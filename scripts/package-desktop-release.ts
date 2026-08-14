/**
 * Sign, notarize, staple, package, and describe one immutable macOS Desktop release.
 *
 * This command intentionally accepts no default signing identity or notarization
 * profile. A release runner must supply both through its protected environment;
 * a missing release credential is an error instead of an unsigned fallback.
 */

import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { desktopVersion, verifyDesktopVersion } from './desktop-version.ts'
import { prepareDesktopRelease } from './prepare-desktop-release.ts'
import { capture, isEntry, run } from './release/process.ts'
import { listMachOFiles, verifyDesktopBundle } from './verify-desktop-bundle.ts'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..')
const SIDECAR_RELATIVE_PATH = 'Contents/MacOS/dsh-desktop-runtime'
const SIDECAR_ENTITLEMENTS = resolve(REPOSITORY_ROOT, 'apps/desktop/src-tauri/sidecar-entitlements.plist')
const SOURCE_HOST_BINARY = resolve(REPOSITORY_ROOT, 'apps/desktop/src-tauri/target/release/dsh-desktop')

/** The immutable release facts written next to a signed Desktop artifact. */
interface DesktopReleaseManifest {
  readonly schemaVersion: 1
  readonly product: string
  readonly version: {
    readonly dsh: string
    readonly marketing: string
    readonly bundle: string
  }
  readonly identifier: string
  readonly tag: string
  readonly commit: string
  readonly target: 'aarch64-apple-darwin'
  readonly minimumMacOS: string
  readonly teamId: string
  readonly assets: readonly [{ readonly file: string; readonly bytes: number; readonly sha256: string }]
}

/** Inputs required to package one macOS Desktop release. */
export interface PackageDesktopReleaseOptions {
  readonly app: string
  readonly output: string
  readonly identity: string
  readonly minimumMacOS: string
  readonly notaryProfile: string
  readonly tag: string
  readonly teamId: string
  readonly dryRun: boolean
}

/** Construct the only tag name permitted for a Desktop version. */
export function desktopReleaseTag(version: string): string {
  assertReleaseVersion(version)
  return `desktop-v${version}`
}

/** Render a stable arm64 DMG filename without spaces. */
export function desktopDmgName(product: string, version: string): string {
  assertReleaseVersion(version)
  const stem = product.trim().replace(/[^A-Za-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
  if (stem === '') throw new Error('Desktop product name cannot be empty')
  return `${stem}_${version}_aarch64.dmg`
}

/** Verify a tag matches the exact root version and resolves through an annotated tag object. */
export function verifyDesktopReleaseTag(tag: string, version: string): string {
  const expected = desktopReleaseTag(version)
  if (tag !== expected) throw new Error(`Desktop release tag must be ${expected}, got ${tag}`)
  capture('git', ['rev-parse', '--verify', `${tag}^{tag}`])
  const commit = capture('git', ['rev-parse', '--verify', `${tag}^{commit}`])
  const head = capture('git', ['rev-parse', '--verify', 'HEAD'])
  if (head !== commit) throw new Error(`Desktop release tag ${tag} points to ${commit}, but HEAD is ${head}`)
  const dirty = capture('git', ['status', '--porcelain=v1', '--untracked-files=all'])
  if (dirty !== '') throw new Error('Desktop release requires a clean working tree')
  return commit
}

/** Sign and package the Desktop application, then emit its delivery metadata. */
export async function packageDesktopRelease(options: PackageDesktopReleaseOptions): Promise<void> {
  assertNonEmpty('signing identity', options.identity)
  assertNonEmpty('notary profile', options.notaryProfile)
  assertNonEmpty('Team ID', options.teamId)
  const app = resolve(options.app)
  const output = resolve(options.output)
  const version = await rootVersion()
  verifyDesktopVersion(REPOSITORY_ROOT, version)
  const appleVersion = desktopVersion(version)
  const expectedTag = desktopReleaseTag(version)
  if (options.tag !== expectedTag) throw new Error(`Desktop release tag must be ${expectedTag}, got ${options.tag}`)
  const product = productName(app)
  const dmgName = desktopDmgName(product, version)
  const dmg = join(output, dmgName)
  const checksums = join(output, 'SHA256SUMS')
  const manifest = join(output, 'release-manifest.json')
  const staging = join(output, '.desktop-dmg-staging')
  const notary = join(output, '.desktop-notary')

  if (options.dryRun) {
    console.log(`desktop release: would sign ${app}`)
    console.log(`desktop release: would notarize and staple ${app}`)
    console.log(`desktop release: would create, sign, notarize, and staple ${dmg}`)
    console.log(`desktop release: would write ${checksums} and ${manifest}`)
    return
  }

  const commit = verifyDesktopReleaseTag(options.tag, version)
  await prepareDesktopRelease({
    target: 'aarch64-apple-darwin',
    appBinary: SOURCE_HOST_BINARY,
    check: true,
    release: true,
  })

  await assertDirectory(app)
  await mkdir(output, { recursive: true })
  for (const path of [dmg, checksums, manifest, staging, notary]) await assertAbsent(path)
  await assertRegularFile(SIDECAR_ENTITLEMENTS)

  await verifyDesktopBundle({
    app,
    architecture: 'arm64',
    minimumMacOS: options.minimumMacOS,
    mode: 'build',
    expectedCommit: commit,
  })
  await signApplication(app, options.identity)
  await verifyDesktopBundle({
    app,
    architecture: 'arm64',
    minimumMacOS: options.minimumMacOS,
    mode: 'signed',
    teamId: options.teamId,
    expectedCommit: commit,
  })

  let stagingCreated = false
  let notaryCreated = false
  try {
    await mkdir(notary)
    notaryCreated = true
    const notaryZip = join(notary, `${basename(app)}.zip`)
    run('ditto', ['-c', '-k', '--keepParent', app, notaryZip])
    run('xcrun', ['notarytool', 'submit', notaryZip, '--wait', '--keychain-profile', options.notaryProfile])
    run('xcrun', ['stapler', 'staple', app])

    await mkdir(staging)
    stagingCreated = true
    const stagedApp = join(staging, basename(app))
    run('ditto', [app, stagedApp])
    await symlink('/Applications', join(staging, 'Applications'))
    run('hdiutil', ['create', '-format', 'UDZO', '-volname', product, '-srcfolder', staging, dmg])
    run('codesign', ['--force', '--sign', options.identity, '--timestamp', dmg])
    run('xcrun', ['notarytool', 'submit', dmg, '--wait', '--keychain-profile', options.notaryProfile])
    run('xcrun', ['stapler', 'staple', dmg])

    await verifyDesktopBundle({
      app,
      architecture: 'arm64',
      minimumMacOS: options.minimumMacOS,
      mode: 'release',
      teamId: options.teamId,
      dmg,
      expectedCommit: commit,
    })

    const asset = {
      file: basename(dmg),
      bytes: (await stat(dmg)).size,
      sha256: await sha256(dmg),
    }
    await writeFile(checksums, `${asset.sha256}  ${asset.file}\n`)
    const release: DesktopReleaseManifest = {
      schemaVersion: 1,
      product,
      version: {
        dsh: version,
        marketing: appleVersion.marketingVersion,
        bundle: appleVersion.bundleVersion,
      },
      identifier: plistValue(app, 'CFBundleIdentifier'),
      tag: options.tag,
      commit,
      target: 'aarch64-apple-darwin',
      minimumMacOS: options.minimumMacOS,
      teamId: options.teamId,
      assets: [asset],
    }
    await writeFile(manifest, `${JSON.stringify(release, null, 2)}\n`)
    console.log(`desktop release packaged: ${dmg}`)
  } finally {
    if (stagingCreated) await removeOwnedDirectory(staging)
    if (notaryCreated) await removeOwnedDirectory(notary)
  }
}

async function signApplication(app: string, identity: string): Promise<void> {
  const machOs = await listMachOFiles(app)
  const bundles = await listNestedCodeBundles(app)
  const signables = [...new Set([...machOs, ...bundles])].sort((left, right) => {
    const depth = pathDepth(right) - pathDepth(left)
    return depth !== 0 ? depth : left.localeCompare(right)
  })
  for (const path of signables) {
    const args = ['--force', '--sign', identity, '--options', 'runtime', '--timestamp']
    if (relative(app, path) === SIDECAR_RELATIVE_PATH) args.push('--entitlements', SIDECAR_ENTITLEMENTS)
    args.push(path)
    run('codesign', args)
  }
  run('codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp', app])
}

async function listNestedCodeBundles(root: string): Promise<readonly string[]> {
  const bundles: string[] = []
  await walkBundles(root, bundles)
  return bundles
}

async function walkBundles(directory: string, bundles: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue
    const path = join(directory, entry.name)
    if (/\.(?:app|appex|bundle|framework|mdimporter|plugin|qlgenerator|saver|service|xpc)$/u.test(entry.name)) {
      bundles.push(path)
    }
    await walkBundles(path, bundles)
  }
}

function pathDepth(path: string): number {
  return path.split('/').length
}

async function rootVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8'))
  if (!isRecord(manifest) || typeof manifest.version !== 'string') {
    throw new Error('root package.json must contain a string version')
  }
  assertReleaseVersion(manifest.version)
  return manifest.version
}

function productName(app: string): string {
  const name = basename(app)
  if (!name.endsWith('.app')) throw new Error(`Desktop app must end with .app: ${app}`)
  return name.slice(0, -'.app'.length)
}

function plistValue(app: string, key: string): string {
  return capture('plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Contents/Info.plist')])
}

function assertReleaseVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`invalid Desktop release version: ${version}`)
  }
}

function assertNonEmpty(label: string, value: string): void {
  if (value.trim() === '') throw new Error(`${label} must not be empty`)
}

async function assertDirectory(path: string): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isDirectory()) throw new Error(`expected Desktop app directory: ${path}`)
}

async function assertRegularFile(path: string): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isFile()) throw new Error(`expected regular file: ${path}`)
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  throw new Error(`release output already exists: ${path}`)
}

async function removeOwnedDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: false })
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const rawChunk of createReadStream(path)) {
    const chunk: unknown = rawChunk
    if (!(chunk instanceof Uint8Array)) throw new Error(`release asset stream returned non-binary data for ${path}`)
    hash.update(chunk)
  }
  return hash.digest('hex')
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      app: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      identity: { type: 'string' },
      'minimum-macos': { type: 'string' },
      'notary-profile': { type: 'string' },
      output: { type: 'string' },
      tag: { type: 'string' },
      'team-id': { type: 'string' },
    },
    allowPositionals: false,
  })
  await packageDesktopRelease({
    app: requiredString(values.app, 'app'),
    output: requiredString(values.output, 'output'),
    identity: requiredString(values.identity, 'identity'),
    minimumMacOS: requiredString(values['minimum-macos'], 'minimum-macos'),
    notaryProfile: requiredString(values['notary-profile'], 'notary-profile'),
    tag: requiredString(values.tag, 'tag'),
    teamId: requiredString(values['team-id'], 'team-id'),
    dryRun: values['dry-run'],
  })
}

function requiredString(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`missing required --${name}`)
  return value
}

if (isEntry(import.meta.url)) await main()
