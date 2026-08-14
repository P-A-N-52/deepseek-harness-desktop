/**
 * Shared Node SEA build machinery for closed Harness runtime products.
 *
 * Each product owns its deploy manifest, entry module, assets, and artifact
 * sink. This module owns the common closure materialization and fixed
 * `@yao-pkg/pkg --sea` invocation so products cannot drift in their native
 * addon or symlink handling.
 */

import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/** Repository root, resolved from this shared script. */
export const REPOSITORY_ROOT = resolve(import.meta.dirname, '..')

/** Exact Node release used by every first-party SEA runtime. */
export const SEA_NODE_RANGE = 'node24.19.0'

/** Pinned SEA packer for reproducible runtime products. */
export const SEA_PKG_SPEC = '@yao-pkg/pkg@6.21.0'

/** pnpm release whose deploy output and policy metadata this pipeline validates. */
export const AUDITED_PNPM_VERSION = '11.7.0'

const PLATFORMS = ['linux', 'macos'] as const
const ARCHES = ['x64', 'arm64'] as const
const SEA_PKG_CACHE_ENVIRONMENT = 'DSH_PKG_SEA_CACHE_DIR'
const REVIEWED_DEPLOY_BUILD = {
  packageName: '@deepseek-ai/dsh-subprocess-local',
  workspacePath: 'packages/subprocess/subprocess-local',
  stagedScript: 'node_modules/@deepseek-ai/dsh-subprocess-local/scripts/ensure-spawn-helper.mjs',
  postinstall: 'node scripts/ensure-spawn-helper.mjs',
} as const
const DEPLOY_METADATA = [
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'node_modules/.modules.yaml',
  'node_modules/.pnpm-workspace-state-v1.json',
  'node_modules/.pnpm',
] as const

/** Platform tags accepted by the packaged Node runtime. */
export type SeaPlatform = (typeof PLATFORMS)[number]

/** CPU tags accepted by the packaged Node runtime. */
export type SeaArch = (typeof ARCHES)[number]

/** Official Node archive details fixed by the exact SEA runtime release. */
export interface SeaRuntimeArchive {
  /** Node semantic version without the pkg `node` prefix. */
  readonly version: string
  /** Official archive filename. */
  readonly filename: string
  /** Primary Node distribution URL for the archive. */
  readonly source: string
  /** Primary Node release checksum document from which the digest is pinned. */
  readonly checksumSource: string
  /** Lowercase SHA-256 from the primary Node checksum document. */
  readonly sha256: string
}

const SEA_NODE_ARCHIVE_SHA256: Readonly<Record<`${SeaPlatform}-${SeaArch}`, string>> = {
  // nodejs.org/dist/v24.19.0/SHASUMS256.txt
  'linux-arm64': 'd28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f',
  'linux-x64': 'f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4',
  'macos-arm64': '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d',
  'macos-x64': 'd1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316',
}

function isPlatform(value: string): value is SeaPlatform {
  return (PLATFORMS as readonly string[]).includes(value)
}

function isArch(value: string): value is SeaArch {
  return (ARCHES as readonly string[]).includes(value)
}

/** One validated `@yao-pkg/pkg` target triple. */
export class SeaTarget {
  private constructor(
    /** pkg Node release (`node<major>.<minor>.<patch>`). */
    readonly nodeRange: string,
    /** pkg platform tag. */
    readonly platform: SeaPlatform,
    /** pkg CPU tag. */
    readonly arch: SeaArch,
  ) {}

  /** The pkg `--targets` string. */
  get spec(): string {
    return `${this.nodeRange}-${this.platform}-${this.arch}`
  }

  /**
   * Parse one explicit pkg target.
   * @param spec - raw target text such as `node24.19.0-macos-arm64`.
   * @param label - product prefix used in errors.
   * @returns its validated target.
   */
  static parse(spec: string, label: string): SeaTarget {
    const parts = spec.split('-')
    const [nodeRange, platform, arch] = parts
    if (parts.length !== 3 || nodeRange === undefined || platform === undefined || arch === undefined) {
      throw new Error(`${label}: target ${JSON.stringify(spec)} must be <nodeRange>-<platform>-<arch>, e.g. node24.19.0-linux-x64.`)
    }
    if (!/^node\d+\.\d+\.\d+$/.test(nodeRange)) {
      throw new Error(`${label}: target ${JSON.stringify(spec)}: node release must look like node24.19.0, got ${JSON.stringify(nodeRange)}.`)
    }
    if (!isPlatform(platform)) {
      throw new Error(`${label}: target ${JSON.stringify(spec)}: platform must be one of ${PLATFORMS.join(', ')}, got ${JSON.stringify(platform)}.`)
    }
    if (!isArch(arch)) {
      throw new Error(`${label}: target ${JSON.stringify(spec)}: arch must be one of ${ARCHES.join(', ')}, got ${JSON.stringify(arch)}.`)
    }
    return new SeaTarget(nodeRange, platform, arch)
  }

  /**
   * Resolve the current host to the pinned Node SEA target.
   * @param label - product prefix used in errors.
   * @returns the host target.
   */
  static host(label: string): SeaTarget {
    const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : undefined
    if (platform === undefined) {
      throw new Error(`${label}: unsupported host platform ${process.platform}; pass --targets explicitly.`)
    }
    const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined
    if (arch === undefined) {
      throw new Error(`${label}: unsupported host arch ${process.arch}; pass --targets explicitly.`)
    }
    return new SeaTarget(SEA_NODE_RANGE, platform, arch)
  }
}

/** Parsed shared command-line flags for one SEA product. */
export interface SeaBuildCli {
  /** Targets to package. */
  readonly targets: readonly SeaTarget[]
  /** Skip `pnpm run build`; built artifacts must already exist. */
  readonly skipBuild: boolean
  /** Print every action instead of making filesystem or subprocess changes. */
  readonly dryRun: boolean
}

/** Product-specific parser details for {@link parseSeaBuildCli}. */
export interface SeaBuildCliSpec {
  /** Prefix used in errors and diagnostics. */
  readonly label: string
  /** Full help text. */
  readonly usage: string
  /** Optional product policy applied to every parsed target. */
  readonly validateTarget?: (target: SeaTarget) => void
}

/**
 * Parse the standard SEA build flags.
 * @param argv - command-line arguments after the script name.
 * @param spec - product-specific parser details.
 * @returns validated build options, or exits after help/a parse error.
 */
export function parseSeaBuildCli(argv: readonly string[], spec: SeaBuildCliSpec): SeaBuildCli {
  let values: {
    targets?: string
    'skip-build'?: boolean
    'dry-run'?: boolean
    help?: boolean
  }
  try {
    values = parseArgs({
      args: argv,
      options: {
        targets: { type: 'string' },
        'skip-build': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }).values
  } catch (error) {
    console.error(`${spec.label}: ${error instanceof Error ? error.message : String(error)}\n`)
    console.error(spec.usage)
    process.exit(1)
  }
  if (values.help === true) {
    console.log(spec.usage)
    process.exit(0)
  }
  const targets = values.targets === undefined
    ? [SeaTarget.host(spec.label)]
    : values.targets.split(',').map(part => part.trim()).filter(part => part !== '').map(target => SeaTarget.parse(target, spec.label))
  if (targets.length === 0) throw new Error(`${spec.label}: --targets is empty.`)
  const seen = new Set<string>()
  for (const target of targets) {
    const key = `${target.platform}-${target.arch}`
    if (seen.has(key)) {
      throw new Error(`${spec.label}: duplicate platform-arch ${key} in --targets; canonical product names would collide.`)
    }
    seen.add(key)
    spec.validateTarget?.(target)
  }
  return {
    targets,
    skipBuild: values['skip-build'] === true,
    dryRun: values['dry-run'] === true,
  }
}

/** Product-owned settings passed to the common SEA pipeline. */
export interface SingleExeBuildSpec {
  /** Prefix used in logs and failures. */
  readonly label: string
  /** Workspace package selected by `pnpm deploy`. */
  readonly deployRootPackage: string
  /** Optional deploy manifest passed to the workspace-peer closure gate. */
  readonly closureManifest?: string
  /** Require every reachable workspace package at the deploy root. */
  readonly flatWorkspaceClosure?: boolean
  /** Closed-runtime entry relative to the deployed staging root. */
  readonly entryBin: string
  /** Symlink-free deploy directory. */
  readonly staging: string
  /** Directory receiving SEA executables. */
  readonly outputDir: string
  /** Target-to-filename mapping inside {@link outputDir}. */
  readonly outputName: (target: SeaTarget) => string
  /** Files pkg must include because runtime loading is dynamic. */
  readonly assets: readonly string[]
  /** Optional destination for a macOS node-pty spawn helper. */
  readonly spawnHelperOutput?: (target: SeaTarget, executable: string) => string
}

/** One compiled executable and its optional external node-pty helper. */
export interface SeaArtifact {
  /** Target represented by this artifact. */
  readonly target: SeaTarget
  /** SEA executable path. */
  readonly executable: string
  /** macOS node-pty spawn helper path, when the product emits one. */
  readonly spawnHelper?: string
}

/** Provenance for the verified Node archive baked into one SEA executable. */
export interface SeaRuntimeProvenance {
  /** Stable document revision. */
  readonly schemaVersion: 2
  /** Product target that owns the resulting executable. */
  readonly target: string
  /** Exact patched packer selected from the workspace lockfile. */
  readonly packer: {
    /** Declared package@version pin. */
    readonly declared: string
    /** SHA-256 of the pnpm patch selected for the packer. */
    readonly patchHash: string
  }
  /** Exact official Node archive consumed by the pinned packer. */
  readonly node: {
    readonly version: string
    readonly source: string
    readonly checksumSource: string
    readonly sha256: string
  }
}

/** One trusted archive and the fresh pkg SEA cache created from its verified bytes. */
export interface VerifiedSeaRuntime {
  /** Target whose SEA pack must consume this archive. */
  readonly target: SeaTarget
  /** Verified archive retained outside the distributable application. */
  readonly archive: string
  /** Official identity and expected checksum for {@link archive}. */
  readonly identity: SeaRuntimeArchive
  /** Fresh private pkg SEA cache containing no pre-extracted Node executable. */
  readonly pkgCacheDir: string
}

/** Optional filesystem roots used to materialize a verified SEA runtime. */
export interface SeaRuntimeCacheOptions {
  /** Durable, build-owned archive cache. */
  readonly cacheRoot: string
  /** Existing pkg SEA cache eligible only after an independent hash verification. */
  readonly reusableCacheRoot?: string
}

/** Derive the fixed official archive identity for a pinned SEA target. */
export function seaRuntimeArchive(target: SeaTarget): SeaRuntimeArchive {
  if (target.nodeRange !== SEA_NODE_RANGE) {
    throw new Error(`SEA archive: ${target.spec} does not use the pinned ${SEA_NODE_RANGE} runtime.`)
  }
  const version = target.nodeRange.slice('node'.length)
  const platform = target.platform === 'macos' ? 'darwin' : 'linux'
  const filename = `node-v${version}-${platform}-${target.arch}.tar.gz`
  const checksums: Readonly<Record<string, string>> = SEA_NODE_ARCHIVE_SHA256
  const sha256 = checksums[`${target.platform}-${target.arch}`]
  if (sha256 === undefined) throw new Error(`SEA archive: no official checksum is pinned for ${target.spec}.`)
  return {
    version,
    filename,
    source: `https://nodejs.org/dist/v${version}/${filename}`,
    checksumSource: `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
    sha256,
  }
}

/**
 * Locate the durable, content-addressed archive retained by one product build.
 * @param cacheRoot - product-owned root outside the distributable application.
 * @param identity - fixed official archive identity.
 * @returns the archive's durable cache path.
 */
export function seaRuntimeArchiveCachePath(cacheRoot: string, identity: SeaRuntimeArchive): string {
  return join(cacheRoot, 'verified', identity.sha256, identity.filename)
}

/** Verify that one archive contains the exact bytes approved for its SEA target. */
async function verifySeaRuntimeArchive(archive: string, identity: SeaRuntimeArchive): Promise<void> {
  if (!existsSync(archive)) throw new Error(`SEA archive: missing ${archive}.`)
  const actual = createHash('sha256').update(await readFile(archive)).digest('hex')
  if (actual !== identity.sha256) {
    throw new Error(
      `SEA archive: ${archive} SHA-256 ${actual} does not match ${identity.checksumSource} for ${identity.filename} (${identity.sha256}).`,
    )
  }
}

/** Copy verified bytes through a temporary sibling before making a cache entry visible. */
async function copyVerifiedSeaArchive(source: string, destination: string, identity: SeaRuntimeArchive): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`)
  try {
    await copyFile(source, temporary)
    await verifySeaRuntimeArchive(temporary, identity)
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Download one fixed official archive and atomically retain it only after its pinned hash verifies. */
async function downloadVerifiedSeaArchive(destination: string, identity: SeaRuntimeArchive): Promise<void> {
  let response: Response
  try {
    response = await fetch(identity.source, { redirect: 'error' })
  } catch (error) {
    throw new Error(`SEA archive: failed to download ${identity.source}: ${error instanceof Error ? error.message : String(error)}.`)
  }
  if (!response.ok || response.body === null) {
    throw new Error(`SEA archive: ${identity.source} returned HTTP ${response.status}.`)
  }
  await mkdir(dirname(destination), { recursive: true })
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, new Uint8Array(await response.arrayBuffer()))
    await verifySeaRuntimeArchive(temporary, identity)
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Materialize one verified archive in a build-owned cache without trusting pkg sentinels. */
export async function materializeSeaRuntimeArchive(
  identity: SeaRuntimeArchive,
  options: SeaRuntimeCacheOptions,
): Promise<string> {
  const archive = seaRuntimeArchiveCachePath(options.cacheRoot, identity)
  if (existsSync(archive)) {
    await verifySeaRuntimeArchive(archive, identity)
    return archive
  }
  const reusableRoot = options.reusableCacheRoot ?? join(homedir(), '.pkg-cache', 'sea')
  const reusable = join(reusableRoot, identity.filename)
  if (existsSync(reusable)) {
    await verifySeaRuntimeArchive(reusable, identity)
    await copyVerifiedSeaArchive(reusable, archive, identity)
    return archive
  }
  await downloadVerifiedSeaArchive(archive, identity)
  return archive
}

/**
 * Create one fresh pkg SEA cache containing only a verified archive and its sentinel.
 * @param archive - verified durable archive to copy.
 * @param identity - fixed official archive identity.
 * @param cacheRoot - product-owned root outside the distributable application.
 * @returns fresh cache directory for one pkg process.
 */
export async function isolatedSeaPkgCache(
  archive: string,
  identity: SeaRuntimeArchive,
  cacheRoot: string,
): Promise<string> {
  const caches = join(cacheRoot, 'pkg')
  await mkdir(caches, { recursive: true })
  const cache = await mkdtemp(join(caches, `${identity.version}-${identity.sha256.slice(0, 12)}-`))
  try {
    const privateArchive = join(cache, identity.filename)
    await copyVerifiedSeaArchive(archive, privateArchive, identity)
    // pkg treats this marker as permission to skip its own network lookup. It
    // is created only after this fresh private cache received verified bytes.
    await writeFile(`${privateArchive}.ok`, '')
    return cache
  } catch (error) {
    await rm(cache, { recursive: true, force: true })
    throw error
  }
}

/**
 * Build the one environment override accepted by the patched pkg SEA cache.
 * @param cacheDir - fresh absolute cache directory prepared for one pkg process.
 * @returns environment entries that select the cache without changing a user home.
 */
export function pkgSeaCacheEnvironment(cacheDir: string): Readonly<Record<string, string>> {
  if (cacheDir.trim() === '' || !isAbsolute(cacheDir)) {
    throw new Error(`SEA archive: ${SEA_PKG_CACHE_ENVIRONMENT} must be a non-empty absolute path, got ${JSON.stringify(cacheDir)}.`)
  }
  return { [SEA_PKG_CACHE_ENVIRONMENT]: cacheDir }
}

/**
 * Assert that one installed package manifest and SEA module enforce the isolated cache route.
 * @param manifest - decoded installed package manifest.
 * @param source - installed `lib-es5/sea.js` contents.
 */
export function assertSeaPackerCacheSupport(manifest: unknown, source: string): void {
  const separator = SEA_PKG_SPEC.lastIndexOf('@')
  const expectedName = SEA_PKG_SPEC.slice(0, separator)
  const expectedVersion = SEA_PKG_SPEC.slice(separator + 1)
  if (
    manifest === null
    || typeof manifest !== 'object'
    || (manifest as { name?: unknown }).name !== expectedName
    || (manifest as { version?: unknown }).version !== expectedVersion
  ) {
    throw new Error(`SEA packer: installed package must be ${SEA_PKG_SPEC}.`)
  }
  const cacheRoot = `const cacheRoot = process.env.${SEA_PKG_CACHE_ENVIRONMENT};`
  const absolutePathGuard = '!(0, path_1.isAbsolute)(cacheRoot)'
  const cacheSelection = 'const downloadDir = cacheRoot ??'
  if (!source.includes(cacheRoot) || !source.includes(absolutePathGuard) || !source.includes(cacheSelection)) {
    throw new Error(`SEA packer: installed ${SEA_PKG_SPEC} does not enforce ${SEA_PKG_CACHE_ENVIRONMENT}; reinstall dependencies before packaging.`)
  }
}

/** One exact, verified entry point from the installed SEA packer. */
export interface InstalledSeaPacker {
  /** Real filesystem path to the sole `pkg` executable entry point. */
  readonly binPath: string
}

/** Return whether a resolved path remains below a resolved package root. */
function isWithinPackage(path: string, packageRoot: string): boolean {
  return path.startsWith(packageRoot + sep)
}

/** Return the sole `pkg` bin declaration from an installed packer manifest. */
function seaPackerBinDeclaration(manifest: unknown): string {
  if (manifest === null || typeof manifest !== 'object') {
    throw new Error(`SEA packer: installed package must be ${SEA_PKG_SPEC}.`)
  }
  const bin = (manifest as { bin?: unknown }).bin
  if (typeof bin === 'string' && bin.trim() !== '') return bin
  if (bin === null || typeof bin !== 'object' || Array.isArray(bin)) {
    throw new Error(`SEA packer: installed ${SEA_PKG_SPEC} must expose one pkg bin entry.`)
  }
  const entries = Object.entries(bin)
  const [entry] = entries
  if (entries.length !== 1 || entry === undefined || entry[0] !== 'pkg' || typeof entry[1] !== 'string' || entry[1].trim() === '') {
    throw new Error(`SEA packer: installed ${SEA_PKG_SPEC} must expose one pkg bin entry.`)
  }
  return entry[1]
}

/**
 * Verify one installed packer and resolve its only Node-executable bin file.
 * @param manifestPath - resolved `@yao-pkg/pkg/package.json` path.
 * @returns the verified, real packer entry point.
 */
export async function verifySeaPackerInstallation(manifestPath: string): Promise<InstalledSeaPacker> {
  let packageRoot: string
  let resolvedManifestPath: string
  try {
    [packageRoot, resolvedManifestPath] = await Promise.all([
      realpath(dirname(manifestPath)),
      realpath(manifestPath),
    ])
  } catch (error) {
    throw new Error(`SEA packer: cannot resolve ${SEA_PKG_SPEC} installation: ${error instanceof Error ? error.message : String(error)}.`)
  }
  if (!isWithinPackage(resolvedManifestPath, packageRoot)) {
    throw new Error(`SEA packer: resolved manifest ${resolvedManifestPath} escapes package root ${packageRoot}.`)
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(resolvedManifestPath, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`SEA packer: cannot read ${SEA_PKG_SPEC} manifest: ${error instanceof Error ? error.message : String(error)}.`)
  }
  const binDeclaration = seaPackerBinDeclaration(manifest)
  if (isAbsolute(binDeclaration)) {
    throw new Error(`SEA packer: installed ${SEA_PKG_SPEC} bin must be package-relative, got ${JSON.stringify(binDeclaration)}.`)
  }
  let binPath: string
  let seaPath: string
  try {
    [binPath, seaPath] = await Promise.all([
      realpath(resolve(packageRoot, binDeclaration)),
      realpath(join(packageRoot, 'lib-es5', 'sea.js')),
    ])
  } catch (error) {
    throw new Error(`SEA packer: cannot resolve ${SEA_PKG_SPEC} entry files: ${error instanceof Error ? error.message : String(error)}.`)
  }
  if (!isWithinPackage(binPath, packageRoot) || !isWithinPackage(seaPath, packageRoot)) {
    throw new Error(`SEA packer: resolved ${SEA_PKG_SPEC} entry files must remain below package root ${packageRoot}.`)
  }
  let binMetadata: Awaited<ReturnType<typeof lstat>>
  let source: string
  try {
    [binMetadata, source] = await Promise.all([
      lstat(binPath),
      readFile(seaPath, 'utf8'),
    ])
  } catch (error) {
    throw new Error(`SEA packer: cannot read ${SEA_PKG_SPEC} entry files: ${error instanceof Error ? error.message : String(error)}.`)
  }
  if (!binMetadata.isFile()) {
    throw new Error(`SEA packer: resolved ${SEA_PKG_SPEC} bin is not a regular file: ${binPath}.`)
  }
  assertSeaPackerCacheSupport(manifest, source)
  return { binPath }
}

/** Verify and resolve the locally installed SEA packer selected by the lockfile. */
async function verifyInstalledSeaPacker(): Promise<InstalledSeaPacker> {
  const resolvePackage = createRequire(join(REPOSITORY_ROOT, 'package.json'))
  let manifestPath: string
  try {
    manifestPath = resolvePackage.resolve('@yao-pkg/pkg/package.json')
  } catch (error) {
    throw new Error(`SEA packer: cannot resolve ${SEA_PKG_SPEC}: ${error instanceof Error ? error.message : String(error)}.`)
  }
  return verifySeaPackerInstallation(manifestPath)
}

/**
 * Build the direct Node invocation for an already verified SEA packer.
 * @param packer - exact installed packer returned by {@link verifySeaPackerInstallation}.
 * @param args - pkg command-line arguments after the bin path.
 * @returns Node executable and argument vector for the packer process.
 */
export function seaPackerInvocation(
  packer: InstalledSeaPacker,
  args: readonly string[],
): { command: string; args: string[] } {
  return { command: process.execPath, args: [packer.binPath, ...args] }
}

/** Build the one verified SEA input used by pkg and later release evidence. */
async function prepareVerifiedSeaRuntime(
  target: SeaTarget,
  options: SeaRuntimeCacheOptions,
): Promise<VerifiedSeaRuntime> {
  const identity = seaRuntimeArchive(target)
  const archive = await materializeSeaRuntimeArchive(identity, options)
  await verifySeaRuntimeArchive(archive, identity)
  const pkgCacheDir = await isolatedSeaPkgCache(archive, identity, options.cacheRoot)
  return { target, archive, identity, pkgCacheDir }
}

/** Remove the ephemeral pkg SEA cache after its SEA pack has completed. */
async function disposeVerifiedSeaRuntime(runtime: VerifiedSeaRuntime): Promise<void> {
  await rm(runtime.pkgCacheDir, { recursive: true, force: true })
}

/**
 * Describe the verified Node archive consumed by one completed SEA pack.
 *
 * @param runtime - verified input retained by the completed pack.
 * @param productTarget - product-specific target identity recorded in the document.
 * @param packer - exact patched packer selected by the frozen workspace lock.
 * @returns provenance for the verified base runtime archive.
 */
export function seaRuntimeProvenance(
  runtime: VerifiedSeaRuntime,
  productTarget: string,
  packer: SeaRuntimeProvenance['packer'],
): SeaRuntimeProvenance {
  if (packer.declared !== SEA_PKG_SPEC || !/^[0-9a-f]{64}$/u.test(packer.patchHash)) {
    throw new Error(`SEA provenance: expected ${SEA_PKG_SPEC} with a lowercase SHA-256 patch hash.`)
  }
  return {
    schemaVersion: 2,
    target: productTarget,
    packer,
    node: {
      version: runtime.identity.version,
      source: runtime.identity.source,
      checksumSource: runtime.identity.checksumSource,
      sha256: runtime.identity.sha256,
    },
  }
}

/**
 * List every file a completed SEA pack emitted.
 * @param artifact - one product-target output.
 * @returns executable followed by its optional helper.
 */
export function seaArtifactPaths(artifact: SeaArtifact): string[] {
  return artifact.spawnHelper === undefined
    ? [artifact.executable]
    : [artifact.executable, artifact.spawnHelper]
}

function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

/**
 * Build the lock-authoritative deploy arguments shared by every SEA product.
 * @param deployRootPackage - workspace package whose production closure is deployed.
 * @param staging - absolute destination for the portable closure.
 * @returns pnpm arguments for an offline shared-lockfile deployment.
 */
export function lockedDeployArgs(deployRootPackage: string, staging: string): string[] {
  if (deployRootPackage.trim() === '') throw new Error('SEA deploy: workspace package name must not be empty.')
  if (!isAbsolute(staging)) throw new Error(`SEA deploy: staging path must be absolute, got ${staging}.`)
  return [
    '--config.inject-workspace-packages=true',
    '--config.frozen-lockfile=true',
    '--config.strict-dep-builds=false',
    '--offline',
    '--filter',
    deployRootPackage,
    'deploy',
    '--prod',
    '--config.node-linker=hoisted',
    staging,
  ]
}

/**
 * Require the package manager process to match the audited deploy implementation.
 * @param version - trimmed `pnpm --version` output.
 */
export function assertAuditedPnpmVersion(version: string): void {
  if (version !== AUDITED_PNPM_VERSION) {
    throw new Error(`SEA deploy: pnpm ${AUDITED_PNPM_VERSION} is required, got ${JSON.stringify(version)}.`)
  }
}

/**
 * Return the only workspace build script deliberately handled after deploy.
 * @param repositoryRoot - real repository path used by pnpm's file URL.
 * @returns the exact dedicated-lockfile dependency path.
 */
export function reviewedDeployBuild(repositoryRoot: string): string {
  return `${REVIEWED_DEPLOY_BUILD.packageName}@${pathToFileURL(resolve(repositoryRoot, REVIEWED_DEPLOY_BUILD.workspacePath)).href}`
}

/**
 * Require pnpm to skip exactly the reviewed local helper-mode repair.
 * @param modulesState - parsed deployed `node_modules/.modules.yaml` document.
 * @param repositoryRoot - real repository path used by pnpm's file URL.
 */
export function assertReviewedDeployBuild(modulesState: unknown, repositoryRoot: string): void {
  if (modulesState === null || typeof modulesState !== 'object' || Array.isArray(modulesState)) {
    throw new Error('SEA deploy: node_modules/.modules.yaml must contain one object.')
  }
  const ignoredBuilds = (modulesState as { ignoredBuilds?: unknown }).ignoredBuilds
  if (!Array.isArray(ignoredBuilds) || ignoredBuilds.some(value => typeof value !== 'string')) {
    throw new Error('SEA deploy: node_modules/.modules.yaml ignoredBuilds must be a string array.')
  }
  const expected = reviewedDeployBuild(repositoryRoot)
  if (ignoredBuilds.length !== 1 || ignoredBuilds[0] !== expected) {
    const actual = ignoredBuilds.length === 0 ? 'none' : ignoredBuilds.join(', ')
    throw new Error(`SEA deploy: ignored build scripts must contain only ${expected}; got ${actual}.`)
  }
}

/** Return the first symbolic link below one directory. */
async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Replace staged package links only after proving each resolved target is local.
 * @param staging - portable deploy root.
 * @param label - product prefix used in errors.
 */
export async function materializeLockedStagingLinks(staging: string, label: string): Promise<void> {
  const nodeModules = join(staging, 'node_modules')
  const stagingRoot = await realpath(staging)
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const destination = remaining
    const source = await realpath(destination)
    if (!isWithinPackage(source, stagingRoot)) {
      throw new Error(`${label}: staged symlink ${destination} resolves outside the deploy root: ${source}.`)
    }
    const nestedNodeModules = join(source, 'node_modules')
    await rm(destination, { recursive: true, force: true })
    await cp(source, destination, {
      recursive: true,
      dereference: false,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    remaining = await findSymlink(nodeModules)
  }
}

/**
 * Render a command for logs and failures, quoting arguments containing spaces.
 * @param command - executable name.
 * @param args - argument vector.
 * @returns a human-readable command line.
 */
function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

/** Common sequential materialization and SEA packaging pipeline. */
export class SingleExeBuild {
  /** The deploy root and pkg input for this product. */
  readonly staging: string

  /** Verified SEA inputs retained for completed product targets. */
  private readonly completedSeaRuntimes = new Map<string, VerifiedSeaRuntime>()

  /** Exact pnpm launcher after its version and repository declaration agree. */
  private pnpmCommand: Promise<string> | undefined

  /**
   * Construct one product pipeline.
   * @param spec - product-owned deploy and artifact details.
   * @param cli - validated invocation flags.
   */
  constructor(
    private readonly spec: SingleExeBuildSpec,
    readonly cli: SeaBuildCli,
  ) {
    this.staging = spec.staging
  }

  /** Verify the product's complete workspace peer closure. */
  async verifyClosure(): Promise<void> {
    const args = ['run', 'verify-runtime-closure']
    if (this.spec.closureManifest !== undefined) args.push('--manifest', this.spec.closureManifest)
    if (this.spec.flatWorkspaceClosure === true) args.push('--flat')
    await this.runPnpm('runtime dependency closure', args)
  }

  /** Build workspace artifacts unless the caller explicitly supplied them. */
  async build(): Promise<void> {
    if (this.cli.skipBuild) {
      console.log(`${this.spec.label}: skipping pnpm run build (--skip-build)`)
      return
    }
    await this.runPnpm('build', ['run', 'build'])
  }

  /** Clear, deploy, de-link, and normalize this product's runtime closure. */
  async deployStaging(): Promise<void> {
    if (this.staging === REPOSITORY_ROOT || REPOSITORY_ROOT.startsWith(this.staging + sep)) {
      throw new Error(`${this.spec.label}: refusing to clear staging dir ${this.staging}: it contains the repo root.`)
    }
    const lockfile = join(REPOSITORY_ROOT, 'pnpm-lock.yaml')
    if (!this.cli.dryRun && !existsSync(lockfile)) {
      throw new Error(`${this.spec.label}: ${lockfile} is required for a lock-authoritative deploy.`)
    }
    if (this.cli.dryRun) console.log(`${this.spec.label}: [dry-run] rm -rf ${this.staging}`)
    else await rm(this.staging, { recursive: true, force: true })
    await this.runPnpm('locked offline deploy', lockedDeployArgs(this.spec.deployRootPackage, this.staging))
    await this.materializeStagedLinks()
    await this.runReviewedDeployBuild()
    await this.removeDeployMetadata()
  }

  /** Add the entry and dynamic asset list to the deployed manifest. */
  async injectPkgConfig(): Promise<void> {
    const patch = { bin: this.spec.entryBin, pkg: { assets: this.spec.assets } }
    const manifestPath = join(this.staging, 'package.json')
    if (this.cli.dryRun) {
      console.log(`${this.spec.label}: [dry-run] patch ${manifestPath} with ${JSON.stringify(patch)}`)
      return
    }
    if (!existsSync(manifestPath)) {
      throw new Error(`${this.spec.label}: ${manifestPath} missing — pnpm deploy did not produce a staged package.`)
    }
    if (!existsSync(join(this.staging, this.spec.entryBin))) {
      throw new Error(`${this.spec.label}: ${join(this.staging, this.spec.entryBin)} missing — run without --skip-build so lib/ artifacts exist.`)
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`)
    console.log(`${this.spec.label}: injected pkg config into ${manifestPath}`)
  }

  /**
   * Build one target and materialize its macOS node-pty helper when needed.
   * @param target - pkg target to compile.
   * @returns the completed SEA artifact.
   */
  async pack(target: SeaTarget): Promise<SeaArtifact> {
    const executable = this.productPath(target)
    const packer = await verifyInstalledSeaPacker()
    await this.prepareNativePty(target)
    if (!this.cli.dryRun) await mkdir(this.spec.outputDir, { recursive: true })
    const args = [
      this.staging,
      '--sea',
      '--targets',
      target.spec,
      '--output',
      executable,
    ]
    const runtime = this.cli.dryRun
      ? undefined
      : await prepareVerifiedSeaRuntime(target, { cacheRoot: this.seaRuntimeCacheRoot() })
    const cacheDir = runtime?.pkgCacheDir ?? join(this.seaRuntimeCacheRoot(), 'pkg', 'dry-run', target.spec)
    const invocation = seaPackerInvocation(packer, args)
    try {
      await this.run(`pkg ${target.spec} via Node ${packer.binPath}`, invocation.command, invocation.args, pkgSeaCacheEnvironment(cacheDir))
      if (!this.cli.dryRun && !existsSync(executable)) {
        throw new Error(`${this.spec.label}: product ${executable} is missing after the pkg run; inspect ${this.spec.outputDir}.`)
      }
      if (runtime !== undefined) {
        await verifySeaRuntimeArchive(join(runtime.pkgCacheDir, runtime.identity.filename), runtime.identity)
        this.completedSeaRuntimes.set(target.spec, runtime)
      }
    } finally {
      if (runtime !== undefined) await disposeVerifiedSeaRuntime(runtime)
    }
    if (target.platform !== 'macos') return { target, executable }
    const spawnHelper = this.spec.spawnHelperOutput?.(target, executable) ?? `${executable}-spawn-helper`
    const source = join(this.staging, 'node_modules', 'node-pty', 'prebuilds', `darwin-${target.arch}`, 'spawn-helper')
    if (this.cli.dryRun) {
      console.log(`${this.spec.label}: [dry-run] cp ${source} ${spawnHelper}`)
    } else {
      await mkdir(dirname(spawnHelper), { recursive: true })
      await copyFile(source, spawnHelper)
      await chmod(spawnHelper, 0o755)
    }
    return { target, executable, spawnHelper }
  }

  /**
   * Return the verified Node archive consumed by one completed SEA pack.
   * @param target - completed target whose runtime evidence is requested.
   * @returns the verified archive retained by the product build.
   */
  seaRuntime(target: SeaTarget): VerifiedSeaRuntime {
    const runtime = this.completedSeaRuntimes.get(target.spec)
    if (runtime === undefined) {
      throw new Error(`${this.spec.label}: no completed verified SEA runtime exists for ${target.spec}.`)
    }
    return runtime
  }

  /**
   * Print completed product files and their sizes.
   * @param products - generated executable or helper paths.
   */
  printProducts(products: readonly string[]): void {
    console.log(this.cli.dryRun ? `${this.spec.label}: [dry-run] would produce:` : `${this.spec.label}: products:`)
    for (const path of products) {
      if (this.cli.dryRun) {
        console.log(`  ${path}`)
        continue
      }
      const megabytes = statSync(path).size / (1024 * 1024)
      console.log(`  ${path}  (${megabytes.toFixed(1)} MB)`)
    }
  }

  /** Verify and run the one reviewed workspace postinstall skipped by pnpm deploy. */
  private async runReviewedDeployBuild(): Promise<void> {
    if (this.cli.dryRun) {
      console.log(`${this.spec.label}: [dry-run] verify the sole reviewed ignored build in node_modules/.modules.yaml`)
      await this.run('reviewed staged postinstall', process.execPath, [join(this.staging, REVIEWED_DEPLOY_BUILD.stagedScript)])
      return
    }
    const modulesPath = join(this.staging, 'node_modules', '.modules.yaml')
    let modulesState: unknown
    try {
      modulesState = JSON.parse(await readFile(modulesPath, 'utf8')) as unknown
    } catch (error) {
      throw new Error(`${this.spec.label}: cannot read deployed build policy ${modulesPath}: ${error instanceof Error ? error.message : String(error)}.`)
    }
    const repositoryRoot = await realpath(REPOSITORY_ROOT)
    assertReviewedDeployBuild(modulesState, repositoryRoot)

    const packageRoot = await realpath(join(this.staging, 'node_modules', REVIEWED_DEPLOY_BUILD.packageName))
    const scriptPath = await realpath(join(this.staging, REVIEWED_DEPLOY_BUILD.stagedScript))
    if (!isWithinPackage(packageRoot, await realpath(this.staging)) || !isWithinPackage(scriptPath, packageRoot)) {
      throw new Error(`${this.spec.label}: reviewed deployed build script must remain inside its staged package.`)
    }
    const [scriptMetadata, manifestSource] = await Promise.all([
      lstat(scriptPath),
      readFile(join(packageRoot, 'package.json'), 'utf8'),
    ])
    if (!scriptMetadata.isFile()) {
      throw new Error(`${this.spec.label}: reviewed deployed build script is not a regular file: ${scriptPath}.`)
    }
    const manifest = JSON.parse(manifestSource) as { name?: unknown; scripts?: { postinstall?: unknown } }
    if (manifest.name !== REVIEWED_DEPLOY_BUILD.packageName) {
      throw new Error(`${this.spec.label}: reviewed deployed package name must be ${REVIEWED_DEPLOY_BUILD.packageName}.`)
    }
    if (manifest.scripts?.postinstall !== REVIEWED_DEPLOY_BUILD.postinstall) {
      throw new Error(`${this.spec.label}: reviewed deployed postinstall does not match ${JSON.stringify(REVIEWED_DEPLOY_BUILD.postinstall)}.`)
    }
    await this.run('reviewed staged postinstall', process.execPath, [scriptPath])
  }

  /** Remove build-only pnpm state after it has proved the staged closure. */
  private async removeDeployMetadata(): Promise<void> {
    const paths = DEPLOY_METADATA.map(path => join(this.staging, path))
    if (this.cli.dryRun) {
      for (const path of paths) console.log(`${this.spec.label}: [dry-run] rm -rf ${path}`)
      return
    }
    await Promise.all(paths.map(path => rm(path, { recursive: true, force: true })))
  }

  /** Replace deploy-time package links with files and reject every remaining link. */
  private async materializeStagedLinks(): Promise<void> {
    if (this.cli.dryRun) {
      console.log(`${this.spec.label}: [dry-run] materialize staged package links`)
      return
    }
    await materializeLockedStagingLinks(this.staging, this.spec.label)
  }

  /**
   * Place the target node-pty addon in the staged closure. Linux npm installs
   * it from source, while a portable deploy contains only locked package files.
   * @param target - pkg target whose native addon is staged.
   */
  private async prepareNativePty(target: SeaTarget): Promise<void> {
    const stagedBuild = join(this.staging, 'node_modules', 'node-pty', 'build')
    if (this.cli.dryRun) console.log(`${this.spec.label}: [dry-run] rm -rf ${stagedBuild}`)
    else await rm(stagedBuild, { recursive: true, force: true })
    if (target.platform !== 'linux') return
    const source = join(REPOSITORY_ROOT, 'packages', 'subprocess', 'subprocess-local', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node')
    const destination = join(stagedBuild, 'Release', 'pty.node')
    if (this.cli.dryRun) {
      console.log(`${this.spec.label}: [dry-run] cp ${source} ${destination}`)
      return
    }
    const host = SeaTarget.host(this.spec.label)
    if (target.platform !== host.platform || target.arch !== host.arch) {
      throw new Error(
        `${this.spec.label}: build the Linux runtime on its target architecture; `
        + `target ${target.platform}-${target.arch} does not match host ${host.platform}-${host.arch}.`,
      )
    }
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }

  /**
   * Resolve and validate the product filename for a target.
   * @param target - target being packed.
   * @returns absolute SEA output path.
   */
  private productPath(target: SeaTarget): string {
    const name = this.spec.outputName(target)
    if (name === '' || basename(name) !== name) {
      throw new Error(`${this.spec.label}: output name ${JSON.stringify(name)} must be one filename.`)
    }
    return join(this.spec.outputDir, name)
  }

  /** Return this product's durable SEA archive cache outside its deploy closure. */
  private seaRuntimeCacheRoot(): string {
    const cacheRoot = join(dirname(this.staging), 'sea')
    if (!isAbsolute(cacheRoot)) {
      throw new Error(`${this.spec.label}: SEA archive cache must be absolute, got ${cacheRoot}.`)
    }
    return cacheRoot
  }

  /** Run pnpm only after the resolved executable matches the audited release. */
  private async runPnpm(label: string, args: string[]): Promise<void> {
    const command = this.cli.dryRun
      ? pnpmBin()
      : await (this.pnpmCommand ??= this.verifyPnpm())
    await this.run(label, command, args)
  }

  /** Resolve the current PATH's pnpm and verify it against the repository pin. */
  private async verifyPnpm(): Promise<string> {
    const packageManifest = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8')) as {
      packageManager?: unknown
    }
    const declared = `pnpm@${AUDITED_PNPM_VERSION}`
    if (packageManifest.packageManager !== declared) {
      throw new Error(`${this.spec.label}: root packageManager must be ${declared}.`)
    }
    const command = pnpmBin()
    const version = await new Promise<string>((resolvePromise, reject) => {
      execFile(command, ['--version'], {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        env: { ...process.env, CI: 'true' },
      }, (error, stdout) => {
        if (error !== null) {
          reject(new Error(`${this.spec.label}: cannot execute ${command} --version: ${error.message}.`))
          return
        }
        resolvePromise(stdout.trim())
      })
    })
    assertAuditedPnpmVersion(version)
    return command
  }

  /**
   * Run one subprocess with inherited stdio.
   * @param label - step name for logs and failures.
   * @param command - executable name.
   * @param args - argument vector.
   * @param environment - product-specific environment values for this command.
   */
  private async run(
    label: string,
    command: string,
    args: string[],
    environment: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    const printable = formatCommand(command, args)
    if (this.cli.dryRun) {
      console.log(`${this.spec.label}: [dry-run] ${printable}`)
      return
    }
    console.log(`${this.spec.label}: ${label}: ${printable}`)
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: REPOSITORY_ROOT,
        stdio: 'inherit',
        // Artifact builds must not mutate or validate a developer's Git hooks.
        env: { ...process.env, CI: 'true', ...environment },
      })
      child.once('error', (error) => {
        reject(new Error(`${this.spec.label}: ${label} failed to spawn: ${error.message} (${printable})`))
      })
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolvePromise()
          return
        }
        const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
        reject(new Error(`${this.spec.label}: ${label} failed (${cause}): ${printable}`))
      })
    })
  }
}
