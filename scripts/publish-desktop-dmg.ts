/** Manually publish one verified unsigned Desktop DMG without GitHub Actions. */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  parseDesktopDmgManifest,
  renderUnsignedReleaseNotes,
} from './desktop-dmg.ts'
import { verifyDesktopDmgTag } from './package-desktop-dmg.ts'
import { attempt, capture, isEntry, run } from './release/process.ts'
import { verifyDesktopDmg } from './verify-desktop-dmg.ts'

const CHECKSUMS = 'SHA256SUMS'
const MANIFEST = 'release-manifest.json'

/** Inputs for a local, explicitly authorized GitHub release publication. */
export interface PublishDesktopDmgOptions {
  readonly input: string
  readonly repo: string
  readonly tag: string
  readonly publish: boolean
}

/** GitHub release fields that the manual publisher treats as authoritative. */
export interface GitHubRelease {
  readonly draft: boolean
  readonly tagName: string
  readonly assets: readonly string[]
}

/**
 * Verify an unsigned artifact and optionally publish its exact bytes through `gh`.
 *
 * @param options - Local artifact, target repository, tag, and explicit write selection.
 * @returns A promise that settles after read-only verification or completed publication.
 */
export async function publishDesktopDmg(options: PublishDesktopDmgOptions): Promise<void> {
  assertRepository(options.repo)
  const input = resolve(options.input)
  const manifest = parseDesktopDmgManifest(
    JSON.parse(await readFile(join(input, MANIFEST), 'utf8')) as unknown,
  )
  const commit = verifyDesktopDmgTag(options.tag, manifest.version.dsh)
  await verifyDesktopDmg({
    input,
    minimumMacOS: manifest.target.minimumMacOS,
    expectedTag: options.tag,
    expectedCommit: commit,
  })
  if (!options.publish) {
    console.log(`desktop DMG publish: verified ${input}`)
    console.log(`desktop DMG publish: would publish ${options.tag} to ${options.repo}`)
    return
  }

  verifyPublisherRepository(options.repo, commit)
  verifyRemoteTag(options.repo, options.tag)
  const assetNames = [manifest.assets[0].file, CHECKSUMS, MANIFEST]
  const assetPaths = assetNames.map(name => join(input, name))
  const existing = queryRelease(options.repo, options.tag)
  if (existing === undefined) {
    const args = [
      'release',
      'create',
      options.tag,
      '--repo',
      options.repo,
      '--draft',
      '--verify-tag',
      '--title',
      `${manifest.product} ${manifest.version.dsh} (unsigned)`,
      '--notes',
      renderUnsignedReleaseNotes(manifest),
    ]
    if (manifest.version.dsh.includes('-')) args.push('--prerelease')
    args.push(...assetPaths)
    run('gh', args)
  } else {
    assertReleaseAssets(existing, options.tag, assetNames, existing.draft)
  }

  await downloadAndCompare(options.repo, options.tag, input, assetNames)
  verifyRemoteTag(options.repo, options.tag)
  if (existing?.draft === false) {
    console.log(`desktop DMG publication already verified: ${options.repo}@${options.tag}`)
    return
  }
  run('gh', ['release', 'edit', options.tag, '--repo', options.repo, '--verify-tag', '--draft=false'])
  const published = queryRelease(options.repo, options.tag)
  if (published === undefined) throw new Error(`GitHub release ${options.tag} disappeared after publication`)
  assertReleaseAssets(published, options.tag, assetNames, false)
  console.log(`desktop DMG published: ${options.repo}@${options.tag}`)
}

/**
 * Reject a release whose tag, draft state, or asset inventory differs from the local artifact.
 *
 * @param release - Parsed GitHub release metadata.
 * @param tag - Exact unsigned Desktop tag.
 * @param assetNames - Complete allowed asset inventory.
 * @param expectedDraft - Required draft state for the current publication phase.
 * @returns Nothing after all release metadata matches.
 */
export function assertReleaseAssets(
  release: GitHubRelease,
  tag: string,
  assetNames: readonly string[],
  expectedDraft: boolean,
): void {
  if (release.tagName !== tag) throw new Error(`GitHub release tag is ${release.tagName}, expected ${tag}`)
  if (release.draft !== expectedDraft) {
    throw new Error(`GitHub release ${tag} draft state is ${String(release.draft)}, expected ${String(expectedDraft)}`)
  }
  const actual = [...release.assets].sort()
  const expected = [...assetNames].sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`GitHub release ${tag} assets must be exactly ${expected.join(', ')}`)
  }
}

function verifyPublisherRepository(repo: string, commit: string): void {
  const current = capture('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  if (current !== repo) throw new Error(`current repository is ${current}, expected publisher ${repo}`)
  const defaultBranch = capture('gh', [
    'repo',
    'view',
    repo,
    '--json',
    'defaultBranchRef',
    '--jq',
    '.defaultBranchRef.name',
  ])
  run('git', ['fetch', '--no-tags', 'origin', defaultBranch])
  const remoteCommit = capture('git', ['rev-parse', `origin/${defaultBranch}`])
  if (remoteCommit !== commit) {
    throw new Error(`Desktop DMG commit ${commit} is not the current origin/${defaultBranch} commit ${remoteCommit}`)
  }
}

function verifyRemoteTag(repo: string, tag: string): void {
  const remote = capture('gh', ['api', `repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`, '--jq', '.object.sha'])
  const local = capture('git', ['rev-parse', '--verify', tag])
  if (remote !== local) throw new Error(`remote tag object ${remote} differs from local tag object ${local}`)
}

function queryRelease(repo: string, tag: string): GitHubRelease | undefined {
  const result = attempt('gh', ['api', `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`])
  if (result.status !== 0) {
    if (isGitHubNotFound(result.stderr)) return undefined
    throw new Error(`cannot query GitHub release ${tag}:\n${result.stdout}\n${result.stderr}`)
  }
  const value: unknown = JSON.parse(result.stdout)
  if (!isRecord(value) || typeof value.draft !== 'boolean' || typeof value.tag_name !== 'string') {
    throw new Error(`GitHub release ${tag} returned invalid metadata`)
  }
  if (!Array.isArray(value.assets)) throw new Error(`GitHub release ${tag} assets must be an array`)
  const assets = value.assets.map((asset, index) => {
    if (!isRecord(asset) || typeof asset.name !== 'string') {
      throw new Error(`GitHub release ${tag} asset ${String(index)} has no name`)
    }
    return asset.name
  })
  return { draft: value.draft, tagName: value.tag_name, assets }
}

/**
 * Distinguish gh's exact missing-resource diagnostic from every other API failure.
 *
 * @param stderr - Standard error emitted by `gh api`.
 * @returns Whether the command emitted gh's exact HTTP 404 diagnostic.
 */
export function isGitHubNotFound(stderr: string): boolean {
  return stderr.split('\n').some(line => line.trim() === 'gh: Not Found (HTTP 404)')
}

async function downloadAndCompare(
  repo: string,
  tag: string,
  input: string,
  assetNames: readonly string[],
): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-desktop-release-assets-'))
  try {
    run('gh', ['release', 'download', tag, '--repo', repo, '--dir', temporary])
    const downloaded = (await readdir(temporary)).sort()
    const expected = [...assetNames].sort()
    if (downloaded.length !== expected.length || downloaded.some((name, index) => name !== expected[index])) {
      throw new Error(`downloaded GitHub release assets must be exactly ${expected.join(', ')}`)
    }
    for (const name of assetNames) {
      const [local, remote] = await Promise.all([
        readFile(join(input, name)),
        readFile(join(temporary, basename(name))),
      ])
      if (!local.equals(remote)) throw new Error(`GitHub release asset differs from local bytes: ${name}`)
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

function assertRepository(value: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new Error(`invalid GitHub repository: ${JSON.stringify(value)}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      publish: { type: 'boolean', default: false },
      repo: { type: 'string' },
      tag: { type: 'string' },
    },
    allowPositionals: false,
  })
  await publishDesktopDmg({
    input: requiredString(values.input, 'input'),
    repo: requiredString(values.repo, 'repo'),
    tag: requiredString(values.tag, 'tag'),
    publish: values.publish,
  })
}

function requiredString(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`missing required --${name}`)
  return value
}

if (isEntry(import.meta.url)) await main()
