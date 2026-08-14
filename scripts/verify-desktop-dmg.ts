/** Verify one locally packaged unsigned Desktop disk image and its delivery metadata. */

import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, readdir, readlink, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { DesktopDmgManifest } from './desktop-dmg.ts'
import {
  parseDesktopDmgManifest,
  renderDesktopDmgChecksums,
} from './desktop-dmg.ts'
import { attempt, isEntry, run } from './release/process.ts'
import { verifyDesktopBundle } from './verify-desktop-bundle.ts'

const MANIFEST = 'release-manifest.json'
const CHECKSUMS = 'SHA256SUMS'

/** Inputs for validating one unsigned Desktop DMG output directory. */
export interface VerifyDesktopDmgOptions {
  readonly input: string
  readonly minimumMacOS: string
  readonly expectedTag?: string
  readonly expectedCommit?: string
}

/**
 * Verify delivery metadata, the disk image layout, and the mounted application seal.
 *
 * @param options - Output directory and expected source and platform facts.
 * @returns The exact manifest whose disk image passed mounted verification.
 */
export async function verifyDesktopDmg(options: VerifyDesktopDmgOptions): Promise<DesktopDmgManifest> {
  const input = resolve(options.input)
  await assertDirectory(input)
  const manifestPath = join(input, MANIFEST)
  const manifest = parseDesktopDmgManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown)
  if (manifest.target.minimumMacOS !== options.minimumMacOS) {
    throw new Error(`release manifest minimum macOS is ${manifest.target.minimumMacOS}, expected ${options.minimumMacOS}`)
  }
  if (options.expectedTag !== undefined && manifest.source.tag !== options.expectedTag) {
    throw new Error(`release manifest tag is ${manifest.source.tag}, expected ${options.expectedTag}`)
  }
  if (options.expectedCommit !== undefined && manifest.source.commit !== options.expectedCommit) {
    throw new Error(`release manifest commit is ${manifest.source.commit}, expected ${options.expectedCommit}`)
  }

  const asset = manifest.assets[0]
  const expectedEntries = [CHECKSUMS, MANIFEST, asset.file].sort()
  const entries = (await readdir(input)).sort()
  if (entries.length !== expectedEntries.length || entries.some((entry, index) => entry !== expectedEntries[index])) {
    throw new Error(`Desktop DMG output must contain exactly ${expectedEntries.join(', ')}, got ${entries.join(', ')}`)
  }

  const dmg = join(input, asset.file)
  await assertRegularFile(dmg)
  const metadata = await stat(dmg)
  const digest = await sha256(dmg)
  if (metadata.size !== asset.bytes || digest !== asset.sha256) {
    throw new Error('release manifest disk image size or SHA-256 does not match the packaged asset')
  }
  const manifestDigest = await sha256(manifestPath)
  const expectedChecksums = renderDesktopDmgChecksums(asset, manifestDigest)
  const actualChecksums = await readFile(join(input, CHECKSUMS), 'utf8')
  if (actualChecksums !== expectedChecksums) {
    throw new Error('SHA256SUMS must contain the exact disk image and release manifest digests')
  }

  run('hdiutil', ['verify', dmg])
  const dmgSignature = attempt('codesign', ['--verify', '--verbose=4', dmg])
  if (dmgSignature.status === 0) throw new Error('unsigned Desktop DMG unexpectedly carries a code signature')
  await verifyMountedDmg(dmg, manifest, options.minimumMacOS)
  console.log(`desktop DMG verified: ${dmg}`)
  return manifest
}

async function verifyMountedDmg(
  dmg: string,
  manifest: DesktopDmgManifest,
  minimumMacOS: string,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-dmg-'))
  const mountpoint = resolve(root, 'mounted')
  let attached = false
  let failure: Error | undefined
  try {
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountpoint, dmg])
    attached = true
    const expectedApp = `${manifest.product}.app`
    const entries = (await readdir(mountpoint)).sort()
    const expectedEntries = ['Applications', expectedApp].sort()
    if (entries.length !== expectedEntries.length || entries.some((entry, index) => entry !== expectedEntries[index])) {
      throw new Error(`DMG root must contain exactly ${expectedEntries.join(' and ')}, got ${entries.join(', ')}`)
    }
    if (await readlink(join(mountpoint, 'Applications')) !== '/Applications') {
      throw new Error('DMG Applications link must target /Applications')
    }
    await verifyDesktopBundle({
      app: join(mountpoint, expectedApp),
      architecture: 'arm64',
      minimumMacOS,
      mode: 'ad-hoc',
      expectedCommit: manifest.source.commit,
    })
  } catch (error) {
    failure = error instanceof Error ? error : new Error(`Desktop DMG verification failed: ${String(error)}`)
  } finally {
    if (attached) {
      const detached = attempt('hdiutil', ['detach', mountpoint])
      if (detached.status !== 0 && failure === undefined) {
        failure = new Error(`hdiutil detach failed: ${detached.stdout}\n${detached.stderr}`)
      }
    }
    await rm(root, { force: true, recursive: true })
  }
  if (failure !== undefined) throw failure
}

async function assertDirectory(path: string): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isDirectory()) throw new Error(`expected Desktop DMG output directory: ${path}`)
}

async function assertRegularFile(path: string): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isFile()) throw new Error(`expected regular file: ${path}`)
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const rawChunk of createReadStream(path)) {
    const chunk: unknown = rawChunk
    if (!(chunk instanceof Uint8Array)) throw new Error(`Desktop DMG stream returned non-binary data for ${path}`)
    hash.update(chunk)
  }
  return hash.digest('hex')
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      'minimum-macos': { type: 'string' },
      'expected-tag': { type: 'string' },
      'expected-commit': { type: 'string' },
    },
    allowPositionals: false,
  })
  if (values.input === undefined || values['minimum-macos'] === undefined) {
    throw new Error('usage: verify-desktop-dmg.ts --input <directory> --minimum-macos <version> [--expected-tag <tag>] [--expected-commit <commit>]')
  }
  await verifyDesktopDmg({
    input: values.input,
    minimumMacOS: values['minimum-macos'],
    ...(values['expected-tag'] === undefined ? {} : { expectedTag: values['expected-tag'] }),
    ...(values['expected-commit'] === undefined ? {} : { expectedCommit: values['expected-commit'] }),
  })
}

if (isEntry(import.meta.url)) await main()
