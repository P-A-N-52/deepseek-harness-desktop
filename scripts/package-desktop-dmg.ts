/** Package one immutable, ad-hoc sealed macOS Desktop developer-preview DMG. */

import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { DesktopDmgManifest } from './desktop-dmg.ts'
import {
  desktopUnsignedDmgName,
  desktopUnsignedTag,
  renderDesktopDmgChecksums,
  sha256File,
} from './desktop-dmg.ts'
import { desktopVersion, verifyDesktopVersion } from './desktop-version.ts'
import { prepareDesktopRelease } from './prepare-desktop-release.ts'
import { capture, isEntry, run } from './release/process.ts'
import { listMachOFiles, verifyDesktopBundle } from './verify-desktop-bundle.ts'
import { verifyDesktopDmg } from './verify-desktop-dmg.ts'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..')
const SIDECAR_RELATIVE_PATH = 'Contents/MacOS/dsh-desktop-runtime'
const SIDECAR_ENTITLEMENTS = resolve(REPOSITORY_ROOT, 'apps/desktop/src-tauri/sidecar-entitlements.plist')
const SOURCE_HOST_BINARY = resolve(REPOSITORY_ROOT, 'apps/desktop/src-tauri/target/release/dsh-desktop')

/** Inputs required to package one unsigned macOS Desktop disk image. */
export interface PackageDesktopDmgOptions {
  readonly app: string
  readonly output: string
  readonly minimumMacOS: string
  readonly tag: string
  readonly dryRun: boolean
}

/**
 * Verify the local unsigned tag names the exact clean source revision.
 *
 * @param tag - Annotated tag supplied by the packager caller.
 * @param version - Root dsh semantic version.
 * @returns The immutable commit shared by the tag and `HEAD`.
 */
export function verifyDesktopDmgTag(tag: string, version: string): string {
  const expected = desktopUnsignedTag(version)
  if (tag !== expected) throw new Error(`Desktop unsigned tag must be ${expected}, got ${tag}`)
  capture('git', ['rev-parse', '--verify', `${tag}^{tag}`])
  const commit = capture('git', ['rev-parse', '--verify', `${tag}^{commit}`])
  const head = capture('git', ['rev-parse', '--verify', 'HEAD'])
  if (head !== commit) throw new Error(`Desktop unsigned tag ${tag} points to ${commit}, but HEAD is ${head}`)
  const dirty = capture('git', ['status', '--porcelain=v1', '--untracked-files=all'])
  if (dirty !== '') throw new Error('Desktop DMG packaging requires a clean working tree')
  return commit
}

/**
 * Verify, copy, ad-hoc seal, package, and atomically publish one local DMG directory.
 *
 * @param options - Immutable application, output, target, tag, and dry-run selection.
 * @returns A promise that settles after the complete output directory is verified or removed.
 */
export async function packageDesktopDmg(options: PackageDesktopDmgOptions): Promise<void> {
  const app = resolve(options.app)
  const output = resolve(options.output)
  const version = await rootVersion()
  verifyDesktopVersion(REPOSITORY_ROOT, version)
  const appleVersion = desktopVersion(version)
  const expectedTag = desktopUnsignedTag(version)
  if (options.tag !== expectedTag) throw new Error(`Desktop unsigned tag must be ${expectedTag}, got ${options.tag}`)
  const product = productName(app)
  const dmgName = desktopUnsignedDmgName(product, version)

  if (options.dryRun) {
    console.log(`desktop DMG: would verify immutable source application ${app}`)
    console.log('desktop DMG: would ad-hoc seal a private copy with hardened runtime')
    console.log(`desktop DMG: would create and mount-verify ${join(output, dmgName)}`)
    console.log(`desktop DMG: would atomically write ${output}`)
    return
  }

  const commit = verifyDesktopDmgTag(options.tag, version)
  await prepareDesktopRelease({
    target: 'aarch64-apple-darwin',
    appBinary: SOURCE_HOST_BINARY,
    check: true,
    release: true,
  })
  await assertDirectory(app)
  await assertRegularFile(SIDECAR_ENTITLEMENTS)
  await assertAbsent(output)
  await verifyDesktopBundle({
    app,
    architecture: 'arm64',
    minimumMacOS: options.minimumMacOS,
    mode: 'build',
    expectedCommit: commit,
  })

  await mkdir(dirname(output), { recursive: true })
  const working = await mkdtemp(join(dirname(output), '.desktop-dmg-'))
  let committed = false
  try {
    const staging = join(working, '.staging')
    await mkdir(staging)
    const stagedApp = join(staging, basename(app))
    run('ditto', [app, stagedApp])
    await sealApplicationAdHoc(stagedApp)
    await verifyDesktopBundle({
      app: stagedApp,
      architecture: 'arm64',
      minimumMacOS: options.minimumMacOS,
      mode: 'ad-hoc',
      expectedCommit: commit,
    })
    await symlink('/Applications', join(staging, 'Applications'))

    const dmg = join(working, dmgName)
    run('hdiutil', ['create', '-format', 'UDZO', '-volname', product, '-srcfolder', staging, dmg])
    await rm(staging, { recursive: true, force: false })

    const asset = {
      file: dmgName,
      bytes: (await stat(dmg)).size,
      sha256: await sha256File(dmg),
    }
    const manifest: DesktopDmgManifest = {
      schemaVersion: 2,
      kind: 'unsigned-developer-preview',
      product,
      version: {
        dsh: version,
        marketing: appleVersion.marketingVersion,
        bundle: appleVersion.bundleVersion,
      },
      identifier: plistValue(app, 'CFBundleIdentifier'),
      source: { tag: options.tag, commit, dirty: false },
      target: {
        triple: 'aarch64-apple-darwin',
        architecture: 'arm64',
        minimumMacOS: options.minimumMacOS,
      },
      distribution: {
        applicationSignature: 'ad-hoc',
        hardenedRuntime: true,
        developerId: false,
        notarized: false,
        diskImageSignature: 'none',
        gatekeeperApprovalRequired: true,
        automaticUpdates: false,
      },
      assets: [asset],
    }
    const manifestPath = join(working, 'release-manifest.json')
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(
      join(working, 'SHA256SUMS'),
      renderDesktopDmgChecksums(asset, await sha256File(manifestPath)),
    )

    await verifyDesktopDmg({
      input: working,
      minimumMacOS: options.minimumMacOS,
      expectedTag: options.tag,
      expectedCommit: commit,
    })
    await verifyDesktopBundle({
      app,
      architecture: 'arm64',
      minimumMacOS: options.minimumMacOS,
      mode: 'build',
      expectedCommit: commit,
    })
    await rename(working, output)
    committed = true
    console.log(`desktop DMG packaged: ${join(output, dmgName)}`)
  } finally {
    if (!committed) await rm(working, { recursive: true, force: true })
  }
}

async function sealApplicationAdHoc(app: string): Promise<void> {
  const machOs = await listMachOFiles(app)
  const bundles = await listNestedCodeBundles(app)
  const signables = [...new Set([...machOs, ...bundles])].sort((left, right) => {
    const depth = pathDepth(right) - pathDepth(left)
    return depth !== 0 ? depth : left.localeCompare(right)
  })
  for (const path of signables) {
    const args = ['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none']
    if (relative(app, path) === SIDECAR_RELATIVE_PATH) args.push('--entitlements', SIDECAR_ENTITLEMENTS)
    args.push(path)
    run('codesign', args)
  }
  run('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', app])
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
  desktopUnsignedTag(manifest.version)
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
  throw new Error(`Desktop DMG output already exists: ${path}`)
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
      'minimum-macos': { type: 'string' },
      output: { type: 'string' },
      tag: { type: 'string' },
    },
    allowPositionals: false,
  })
  await packageDesktopDmg({
    app: requiredString(values.app, 'app'),
    output: requiredString(values.output, 'output'),
    minimumMacOS: requiredString(values['minimum-macos'], 'minimum-macos'),
    tag: requiredString(values.tag, 'tag'),
    dryRun: values['dry-run'],
  })
}

function requiredString(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`missing required --${name}`)
  return value
}

if (isEntry(import.meta.url)) await main()
