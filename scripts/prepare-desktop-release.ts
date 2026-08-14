/**
 * Materialize the legal and supply-chain evidence that a Desktop bundle
 * carries beside its native runtime artifacts.
 *
 * The script deliberately derives the npm document from the lockfile and the
 * Desktop deploy root, rather than from a developer's node_modules layout.
 * Cargo's own locked resolver remains authoritative for the Rust graph.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, globSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import * as yaml from 'js-yaml'
import { parse as parseToml } from 'smol-toml'
import { desktopVersion, verifyDesktopVersion } from './desktop-version.ts'
import {
  SEA_NODE_RANGE,
  SEA_PKG_SPEC,
  SeaTarget,
  seaRuntimeArchive,
  seaRuntimeArchiveCachePath,
  type SeaRuntimeArchive,
  type SeaRuntimeProvenance,
} from './single-exe-build.ts'

const LABEL = 'prepare-desktop-release'
const ROOT = resolve(import.meta.dirname, '..')
const DESKTOP_ROOT = 'apps/desktop/src-tauri'
/** Repository-relative directory bundled as the Desktop legal resource root. */
export const DESKTOP_LEGAL_RESOURCE_ROOT = `${DESKTOP_ROOT}/resources/legal`
const DESKTOP_CLOSURE = 'native/desktop-runtime'
const DESKTOP_DEPLOY = `${DESKTOP_CLOSURE}/.artifacts/node`
const SIDECAR_BASENAME = 'dsh-desktop-runtime'

type Table = Record<string, unknown>

/** A target-specific file embedded in the Desktop application. */
export interface RuntimeArtifact {
  /** Artifact role in the native bundle. */
  readonly role: 'host' | 'sidecar' | 'ripgrep' | 'spawn-helper'
  /** Repository-relative path to the artifact. */
  readonly path: string
  /** Artifact byte length. */
  readonly size: number
  /** Lowercase SHA-256 digest of the exact artifact bytes. */
  readonly buildSha256: string
  /** Deployment floor reported by the artifact's native headers ('n/a' for PE targets). */
  readonly minimumMacos: string
}

/** The release evidence written to `runtime-manifest.json`. */
export interface RuntimeManifest {
  /** Stable manifest format revision. */
  readonly schemaVersion: 2
  /** Shared dsh version and its Apple-compatible projections. */
  readonly version: {
    readonly dsh: string
    readonly marketing: string
    readonly bundle: string
  }
  /** Repository commit, or `unknown` outside a usable Git checkout. */
  readonly commit: string
  /** Whether the checked-out source had uncommitted changes. */
  readonly sourceDirty: boolean | 'unknown'
  /** Target information proven from the artifact filenames and native headers. */
  readonly target: {
    readonly triple: string
    readonly architecture: string
    readonly minimumMacos: string
  }
  /** Direct artifacts the app's host either executes or exposes to its sidecar. */
  readonly artifacts: readonly RuntimeArtifact[]
  /** SEA packer and Node-runtime provenance. */
  readonly nodeSea: {
    readonly declaredNodeRange: string
    readonly packer: {
      readonly declared: string
      readonly lockfile: string
      readonly integrity: string
      /** SHA-256 of the pnpm patch applied to the locked SEA packer. */
      readonly patchHash: string
    }
    readonly runtimeVersion: string
    readonly source: string
    readonly checksumSource: string
    readonly sha256: string
    /** SHA-256 of the bundled NODE_LICENSE bytes. */
    readonly licenseSha256: string
    readonly provenance: string
  }
  /** Facts that prohibit a release even though an audit draft can be written. */
  readonly releaseBlockers: readonly string[]
}

/** One CycloneDX JSON document. */
interface Bom {
  readonly bomFormat: 'CycloneDX'
  readonly specVersion: '1.6'
  readonly version: 1
  readonly metadata: {
    readonly component: BomComponent
  }
  readonly components: readonly BomComponent[]
  readonly dependencies: readonly BomDependency[]
}

/** One software component represented by a CycloneDX document. */
interface BomComponent {
  readonly type: 'application' | 'library'
  readonly 'bom-ref': string
  readonly name: string
  readonly version: string
  readonly purl?: string
  readonly licenses?: readonly { readonly license: { readonly id?: string; readonly name?: string } }[]
  readonly hashes?: readonly { readonly alg: 'SHA-256' | 'SHA-512'; readonly content: string }[]
  readonly properties?: readonly { readonly name: string; readonly value: string }[]
}

/** One dependency relationship represented by a CycloneDX document. */
interface BomDependency {
  readonly ref: string
  readonly dependsOn: readonly string[]
}

/** One physical package in the symlink-free SEA deployment. */
interface DeployedPackage {
  readonly directory: string
  readonly ref: string
  readonly name: string
  readonly version: string
  readonly licenses: BomComponent['licenses']
  readonly dependencies: readonly {
    readonly name: string
    readonly optional: boolean
  }[]
}

/** The sealed npm package inventory and its resolved dependency graph. */
interface DeployedNpmClosure {
  /** Application package at the deploy root. */
  readonly root: DeployedPackage
  /** Every physical npm package root below the deployed node_modules tree. */
  readonly packages: readonly DeployedPackage[]
  /** Runtime edges resolved from the sealed deployment. */
  readonly dependencies: readonly BomDependency[]
  /** Unique frozen-lock resolution selected for every physical package. */
  readonly resolutions: ReadonlyMap<string, DeployedLockResolution>
}

/** The pnpm lock identity that proves one physical deployed package instance. */
interface NpmLockResolution {
  /** Registry package resolution key. */
  readonly packageKey: string
  /** Snapshot key carrying the resolved peer/dependency instance. */
  readonly snapshotKey: string
  /** Original SRI string from pnpm's lock. */
  readonly integrity: string
  /** CycloneDX-compatible lowercase SHA-512 derived from {@link integrity}. */
  readonly sha512: string
}

/** A first-party workspace package represented by a pnpm importer rather than a registry tarball. */
interface WorkspaceLockResolution {
  /** Repository-relative importer key. */
  readonly importer: string
}

type DeployedLockResolution = NpmLockResolution | WorkspaceLockResolution

/** Immutable source facts for the patched SEA packer. */
export interface LockedSeaPacker {
  /** Pinned package@version declaration. */
  readonly declared: string
  /** Exact lockfile package key. */
  readonly lockfile: string
  /** Registry tarball SHA-512 SRI from pnpm-lock.yaml. */
  readonly integrity: string
  /** SHA-256 of the patch pnpm applies to the packer. */
  readonly patchHash: string
}

/**
 * Materialize the ignored legal resource directory before Tauri validates its
 * resource configuration.
 * @param repositoryRoot - repository containing the Desktop application.
 * @returns absolute legal resource directory.
 */
export async function ensureDesktopLegalResourceRoot(repositoryRoot = ROOT): Promise<string> {
  const legal = resolve(repositoryRoot, DESKTOP_LEGAL_RESOURCE_ROOT)
  await mkdir(legal, { recursive: true })
  return legal
}

/** Read a durable JSON/YAML table and reject every other value. */
function table(value: unknown, location: string): Table {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${LABEL}: ${location} must be a table.`)
  }
  return value as Table
}

/** Read an optional durable table. */
function optionalTable(value: unknown, location: string): Table | undefined {
  return value === undefined ? undefined : table(value, location)
}

/** Read a mandatory string from durable input. */
function requiredString(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${LABEL}: ${location} must be a non-empty string.`)
  }
  return value
}

/** Decode one desktop target triple into its Apple or Windows architecture. */
export function desktopArchitecture(target: string): string {
  if (target === 'aarch64-apple-darwin' || target === 'aarch64-pc-windows-msvc') return 'arm64'
  if (target === 'x86_64-apple-darwin' || target === 'x86_64-pc-windows-msvc') return 'x86_64'
  throw new Error(
    `${LABEL}: unsupported Desktop target ${JSON.stringify(target)}; `
    + 'expected aarch64-apple-darwin, x86_64-apple-darwin, aarch64-pc-windows-msvc, or x86_64-pc-windows-msvc.',
  )
}

/** Map one verified Desktop target triple to its SEA platform tag. */
function seaPlatformFor(target: string): 'win' | 'macos' {
  return target.endsWith('-pc-windows-msvc') ? 'win' : 'macos'
}

/** Escape one npm package identity for a Package URL. */
function npmPurl(name: string, version: string): string {
  const encoded = name.split('/').map(part => encodeURIComponent(part)).join('/')
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`
}

/** Convert a repository path to the lockfile's POSIX representation. */
function lockPath(path: string): string {
  return path.replaceAll('\\', '/')
}

/** Read a dependency table from package.json. */
function packageDependencyNames(value: unknown, location: string): string[] {
  if (value === undefined) return []
  return Object.keys(table(value, location)).sort()
}

/** Normalize package.json license metadata into CycloneDX entries. */
function packageLicenses(value: unknown): BomComponent['licenses'] {
  if (typeof value === 'string' && value.length > 0) return [{ license: { name: value } }]
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const type = (value as Table).type
    if (typeof type === 'string' && type.length > 0) return [{ license: { name: type } }]
  }
  if (Array.isArray(value)) {
    const names = value.flatMap((entry) => {
      if (typeof entry === 'string' && entry.length > 0) return [entry]
      if (entry !== null && typeof entry === 'object' && typeof (entry as Table).type === 'string') {
        return [(entry as Table).type as string]
      }
      return []
    })
    return names.length === 0 ? undefined : names.map(name => ({ license: { name } }))
  }
  return undefined
}

/** Read one physical package from the sealed deploy closure. */
function readDeployedPackage(directory: string, deployRoot: string): DeployedPackage {
  const manifestPath = join(directory, 'package.json')
  const location = lockPath(relative(ROOT, manifestPath))
  const manifest = table(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown, location)
  const optional = new Set(packageDependencyNames(manifest.optionalDependencies, `${location}.optionalDependencies`))
  const peers = packageDependencyNames(manifest.peerDependencies, `${location}.peerDependencies`)
  const peerMeta = optionalTable(manifest.peerDependenciesMeta, `${location}.peerDependenciesMeta`)
  const dependencyOptional = new Map<string, boolean>()
  for (const name of packageDependencyNames(manifest.dependencies, `${location}.dependencies`)) {
    dependencyOptional.set(name, false)
  }
  for (const name of optional) dependencyOptional.set(name, true)
  for (const name of peers) {
    const metadata = optionalTable(peerMeta?.[name], `${location}.peerDependenciesMeta.${name}`)
    dependencyOptional.set(name, metadata?.optional === true)
  }
  const deployedPath = lockPath(relative(deployRoot, directory)) || '.'
  return {
    directory,
    ref: `urn:dsh:npm-deploy:${encodeURIComponent(deployedPath)}`,
    name: requiredString(manifest.name, `${location}.name`),
    version: requiredString(manifest.version, `${location}.version`),
    licenses: packageLicenses(manifest.license ?? manifest.licenses),
    dependencies: [...dependencyOptional]
      .map(([name, optionalDependency]) => ({ name, optional: optionalDependency }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  }
}

/** Resolve one package using Node's ancestor node_modules lookup. */
function resolveDeployedDependency(
  owner: DeployedPackage,
  name: string,
  deployRoot: string,
): string | undefined {
  if (!/^(?:@[^/]+\/)?[^/]+$/u.test(name)) {
    throw new Error(`${LABEL}: package ${owner.name} declares invalid dependency name ${JSON.stringify(name)}.`)
  }
  let current = owner.directory
  while (true) {
    const manifest = join(current, 'node_modules', ...name.split('/'), 'package.json')
    if (existsSync(manifest)) return dirname(manifest)
    if (current === deployRoot) return undefined
    const parent = dirname(current)
    const outside = relative(deployRoot, parent)
    if (outside === '..' || outside.startsWith(`..${posix.sep}`) || isAbsolute(outside)) return undefined
    current = parent
  }
}

/** Merge one dependency while treating any required declaration as required. */
function addDependency(dependencies: Map<string, boolean>, name: string, optional: boolean): void {
  const existing = dependencies.get(name)
  dependencies.set(name, existing === undefined ? optional : existing && optional)
}

/** Enumerate every package root physically shipped below a sealed node_modules tree. */
function readDeployedPackageRoots(deployRoot: string): readonly DeployedPackage[] {
  const packages = new Map<string, DeployedPackage>()

  const entries = (directory: string) => readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))

  function rejectUnexpectedEntry(directory: string, name: string): never {
    throw new Error(`${LABEL}: deployed node_modules entry ${lockPath(relative(deployRoot, join(directory, name)))} is not a package directory.`)
  }

  function inspectPackage(directory: string): void {
    const manifest = join(directory, 'package.json')
    if (!existsSync(manifest)) {
      throw new Error(`${LABEL}: deployed package root ${lockPath(relative(deployRoot, directory))} is missing package.json.`)
    }
    if (packages.has(directory)) {
      throw new Error(`${LABEL}: deployed package root ${lockPath(relative(deployRoot, directory))} occurs more than once.`)
    }
    packages.set(directory, readDeployedPackage(directory, deployRoot))
    inspectNodeModules(join(directory, 'node_modules'))
  }

  function inspectScope(directory: string): void {
    for (const entry of entries(directory)) {
      if (entry.isSymbolicLink() || !entry.isDirectory() || entry.name.startsWith('.')) {
        rejectUnexpectedEntry(directory, entry.name)
      }
      inspectPackage(join(directory, entry.name))
    }
  }

  function inspectNodeModules(directory: string): void {
    if (!existsSync(directory)) return
    for (const entry of entries(directory)) {
      if (entry.name === '.bin') continue
      if (entry.isSymbolicLink() || !entry.isDirectory() || entry.name.startsWith('.')) {
        rejectUnexpectedEntry(directory, entry.name)
      }
      const candidate = join(directory, entry.name)
      if (entry.name.startsWith('@')) inspectScope(candidate)
      else inspectPackage(candidate)
    }
  }

  inspectNodeModules(join(deployRoot, 'node_modules'))
  return [...packages.values()].sort((left, right) => left.ref.localeCompare(right.ref))
}

/** Read the pnpm lock records required to prove a deployed registry package. */
function npmLockRecords(lockfile: string): {
  readonly packages: Table
  readonly snapshots: Table
  readonly importers: Table
} {
  const document = table(yaml.load(readFileSync(lockfile, 'utf8')), lockPath(relative(ROOT, lockfile)))
  return {
    packages: table(document.packages, 'pnpm-lock.yaml.packages'),
    snapshots: table(document.snapshots, 'pnpm-lock.yaml.snapshots'),
    importers: table(document.importers, 'pnpm-lock.yaml.importers'),
  }
}

/** Select lock keys for exactly one package name/version, including peer snapshots. */
function matchingPnpmKeys(records: Table, name: string, version: string): string[] {
  const bare = `${name}@${version}`
  return Object.keys(records).filter(key => key === bare || key.startsWith(`${bare}(`)).sort()
}

/** Decode one pnpm SHA-512 SRI value as the hexadecimal form CycloneDX requires. */
function sriSha512(integrity: string, location: string): string {
  const candidates = integrity.split(/\s+/u).filter(part => part.startsWith('sha512-'))
  if (candidates.length !== 1 || candidates[0] === undefined) {
    throw new Error(`${LABEL}: ${location} must contain exactly one sha512 SRI digest.`)
  }
  const encoded = candidates[0].slice('sha512-'.length)
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error(`${LABEL}: ${location} has an invalid SHA-512 SRI encoding.`)
  }
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.length !== 64 || decoded.toString('base64') !== encoded) {
    throw new Error(`${LABEL}: ${location} must encode exactly one SHA-512 digest.`)
  }
  return decoded.toString('hex')
}

/** Resolve an in-repository package through exactly one workspace importer. */
function workspaceImporter(
  pkg: DeployedPackage,
  importers: Table,
): WorkspaceLockResolution | undefined {
  const candidates = Object.keys(importers).filter((importer) => {
    const directory = importer === '.' ? ROOT : resolve(ROOT, importer)
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) return false
    const manifest = table(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown, lockPath(relative(ROOT, manifestPath)))
    return manifest.name === pkg.name && manifest.version === pkg.version
  }).sort()
  if (candidates.length === 0) return undefined
  if (candidates.length !== 1 || candidates[0] === undefined) {
    throw new Error(`${LABEL}: deployed workspace package ${pkg.name}@${pkg.version} maps to multiple pnpm importers: ${candidates.join(', ')}.`)
  }
  return { importer: candidates[0] }
}

/** Prove one deployed package instance against a unique pnpm package and snapshot record. */
function deployedLockResolution(
  pkg: DeployedPackage,
  records: ReturnType<typeof npmLockRecords>,
): DeployedLockResolution {
  const packageKeys = matchingPnpmKeys(records.packages, pkg.name, pkg.version)
  if (packageKeys.length === 0) {
    const workspace = workspaceImporter(pkg, records.importers)
    if (workspace !== undefined) return workspace
    throw new Error(`${LABEL}: deployed package ${pkg.name}@${pkg.version} has no pnpm package resolution or workspace importer.`)
  }
  if (packageKeys.length !== 1 || packageKeys[0] === undefined) {
    throw new Error(`${LABEL}: deployed package ${pkg.name}@${pkg.version} maps ambiguously to pnpm package resolutions: ${packageKeys.join(', ')}.`)
  }
  const snapshotKeys = matchingPnpmKeys(records.snapshots, pkg.name, pkg.version)
  if (snapshotKeys.length !== 1 || snapshotKeys[0] === undefined) {
    const detail = snapshotKeys.length === 0 ? 'none' : snapshotKeys.join(', ')
    throw new Error(`${LABEL}: deployed package ${pkg.name}@${pkg.version} maps ambiguously to pnpm snapshots: ${detail}.`)
  }
  const packageKey = packageKeys[0]
  const resolution = optionalTable(records.packages[packageKey], `pnpm-lock.yaml.packages.${packageKey}`)?.resolution
  const integrity = requiredString(
    optionalTable(resolution, `pnpm-lock.yaml.packages.${packageKey}.resolution`)?.integrity,
    `pnpm-lock.yaml.packages.${packageKey}.resolution.integrity`,
  )
  return {
    packageKey,
    snapshotKey: snapshotKeys[0],
    integrity,
    sha512: sriSha512(integrity, `pnpm-lock.yaml.packages.${packageKey}.resolution.integrity`),
  }
}

/** Add resolved dependencies injected by one frozen pnpm snapshot. */
function snapshotDependencies(
  resolution: NpmLockResolution,
  records: ReturnType<typeof npmLockRecords>,
  dependencies: Map<string, boolean>,
): void {
  const snapshot = table(
    records.snapshots[resolution.snapshotKey],
    `pnpm-lock.yaml.snapshots.${resolution.snapshotKey}`,
  )
  for (const [field, optional] of [['dependencies', false], ['optionalDependencies', true]] as const) {
    const values = optionalTable(snapshot[field], `pnpm-lock.yaml.snapshots.${resolution.snapshotKey}.${field}`)
    if (values === undefined) continue
    for (const [name, version] of Object.entries(values).sort(([left], [right]) => left.localeCompare(right))) {
      requiredString(version, `pnpm-lock.yaml.snapshots.${resolution.snapshotKey}.${field}.${name}`)
      addDependency(dependencies, name, optional)
    }
  }
}

/** Combine package metadata with peer and optional dependencies resolved by pnpm. */
function deployedDependencies(
  pkg: DeployedPackage,
  resolution: DeployedLockResolution | undefined,
  records: ReturnType<typeof npmLockRecords>,
): readonly { readonly name: string; readonly optional: boolean }[] {
  const dependencies = new Map<string, boolean>()
  for (const dependency of pkg.dependencies) addDependency(dependencies, dependency.name, dependency.optional)
  if (resolution !== undefined && 'snapshotKey' in resolution) {
    snapshotDependencies(resolution, records, dependencies)
  }
  return [...dependencies]
    .map(([name, optional]) => ({ name, optional }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** Build the complete physical deployment graph and prove it against the frozen lock. */
function readDeployedNpmClosure(
  deployRoot: string,
  records: ReturnType<typeof npmLockRecords>,
): DeployedNpmClosure {
  const root = readDeployedPackage(deployRoot, deployRoot)
  const packages = readDeployedPackageRoots(deployRoot)
  const packagesByDirectory = new Map(packages.map(pkg => [pkg.directory, pkg]))
  const resolutions = new Map<string, DeployedLockResolution>()
  for (const pkg of packages) resolutions.set(pkg.ref, deployedLockResolution(pkg, records))

  const owners = [root, ...packages]
  const edges = new Map<string, Set<string>>()
  for (const owner of owners) {
    const resolution = owner === root ? undefined : resolutions.get(owner.ref)
    if (owner !== root && resolution === undefined) {
      throw new Error(`${LABEL}: deployed package ${owner.name}@${owner.version} has no lock resolution.`)
    }
    const dependsOn = new Set<string>()
    for (const dependency of deployedDependencies(owner, resolution, records)) {
      const directory = resolveDeployedDependency(owner, dependency.name, deployRoot)
      if (directory === undefined) {
        if (dependency.optional) continue
        throw new Error(`${LABEL}: deployed package ${owner.name}@${owner.version} is missing required dependency ${dependency.name}.`)
      }
      const target = packagesByDirectory.get(directory)
      if (target === undefined) {
        throw new Error(`${LABEL}: deployed package ${owner.name}@${owner.version} resolves ${dependency.name} outside the physical package inventory.`)
      }
      dependsOn.add(target.ref)
    }
    edges.set(owner.ref, dependsOn)
  }

  const reachable = new Set<string>([root.ref])
  const queue = [root.ref]
  while (queue.length > 0) {
    const owner = queue.shift()
    if (owner === undefined) continue
    for (const target of edges.get(owner) ?? []) {
      if (reachable.has(target)) continue
      reachable.add(target)
      queue.push(target)
    }
  }
  if (reachable.size !== packages.length + 1) {
    const unreferenced = packages
      .filter(pkg => !reachable.has(pkg.ref))
      .map(pkg => `${pkg.name}@${pkg.version}`)
      .sort()
    throw new Error(
      `${LABEL}: deployed physical package count ${packages.length} does not match reachable closure ${reachable.size - 1}; unreferenced: ${unreferenced.join(', ')}.`,
    )
  }
  return {
    root,
    packages,
    dependencies: [...edges]
      .map(([ref, targets]) => ({ ref, dependsOn: [...targets].sort() }))
      .sort((left, right) => left.ref.localeCompare(right.ref)),
    resolutions,
  }
}

/** Render the exact deployed npm closure as a deterministic CycloneDX BOM. */
export function desktopNpmBom(
  target: string,
  deployRoot = resolve(ROOT, DESKTOP_DEPLOY),
  lockfile = resolve(ROOT, 'pnpm-lock.yaml'),
): Bom {
  desktopArchitecture(target)
  if (!existsSync(join(deployRoot, 'package.json'))) {
    throw new Error(`${LABEL}: Desktop SEA deploy closure is missing: ${lockPath(relative(ROOT, deployRoot))}; run desktop:runtime first.`)
  }
  const lock = npmLockRecords(lockfile)
  const closure = readDeployedNpmClosure(deployRoot, lock)
  const component = (pkg: DeployedPackage): BomComponent => {
    const resolution = closure.resolutions.get(pkg.ref)
    if (resolution === undefined) {
      throw new Error(`${LABEL}: deployed package ${pkg.name}@${pkg.version} has no lock resolution.`)
    }
    const properties = [
      {
        name: 'dsh:deployed-path',
        value: lockPath(relative(deployRoot, pkg.directory)) || '.',
      },
      ...('importer' in resolution
        ? [{ name: 'dsh:pnpm-importer', value: resolution.importer }]
        : [
          { name: 'dsh:pnpm-package', value: resolution.packageKey },
          { name: 'dsh:pnpm-snapshot', value: resolution.snapshotKey },
          { name: 'dsh:pnpm-integrity', value: resolution.integrity },
        ]),
    ]
    return {
      type: 'library',
      'bom-ref': pkg.ref,
      name: pkg.name,
      version: pkg.version,
      purl: npmPurl(pkg.name, pkg.version),
      ...(pkg.licenses === undefined ? {} : { licenses: pkg.licenses }),
      ...('sha512' in resolution ? { hashes: [{ alg: 'SHA-512' as const, content: resolution.sha512 }] } : {}),
      properties,
    }
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': closure.root.ref,
        name: closure.root.name,
        version: closure.root.version,
        purl: npmPurl(closure.root.name, closure.root.version),
        properties: [{ name: 'dsh:target', value: target }],
      },
    },
    components: closure.packages.filter(pkg => pkg !== closure.root).map(component),
    dependencies: closure.dependencies,
  }
}

/** Invoke Cargo's locked, target-filtered resolver and return its metadata graph. */
function cargoMetadata(target: string): Table {
  try {
    return table(JSON.parse(execFileSync('cargo', [
      'metadata',
      '--locked',
      '--filter-platform',
      target,
      '--format-version',
      '1',
      '--manifest-path',
      `${DESKTOP_ROOT}/Cargo.toml`,
    ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as unknown, 'cargo metadata')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${LABEL}: cargo metadata --locked failed: ${detail}`)
  }
}

/** Read registry checksums from Cargo.lock. */
function cargoChecksums(): ReadonlyMap<string, string> {
  const document = table(
    parseToml(readFileSync(resolve(ROOT, DESKTOP_ROOT, 'Cargo.lock'), 'utf8')),
    'Desktop Cargo.lock',
  )
  if (!Array.isArray(document.package)) {
    throw new Error(`${LABEL}: Desktop Cargo.lock has no [[package]] records.`)
  }
  const checksums = new Map<string, string>()
  for (const [index, value] of document.package.entries()) {
    const pkg = table(value, `Desktop Cargo.lock.package[${index}]`)
    if (typeof pkg.checksum !== 'string') continue
    const name = requiredString(pkg.name, `Desktop Cargo.lock.package[${index}].name`)
    const version = requiredString(pkg.version, `Desktop Cargo.lock.package[${index}].version`)
    const source = typeof pkg.source === 'string' ? pkg.source : ''
    checksums.set(`${name}\u0000${version}\u0000${source}`, pkg.checksum)
  }
  return checksums
}

/** Keep normal and build Cargo edges while excluding test-only dev edges. */
function cargoRuntimeDependencies(node: Table, location: string): string[] {
  if (!Array.isArray(node.deps)) throw new Error(`${LABEL}: ${location}.deps must be an array.`)
  return node.deps.flatMap((value, index) => {
    const dependency = table(value, `${location}.deps[${index}]`)
    if (!Array.isArray(dependency.dep_kinds)) {
      throw new Error(`${LABEL}: ${location}.deps[${index}].dep_kinds must be an array.`)
    }
    const included = dependency.dep_kinds.some((kind, kindIndex) => {
      const record = table(kind, `${location}.deps[${index}].dep_kinds[${kindIndex}]`)
      return record.kind !== 'dev'
    })
    return included ? [requiredString(dependency.pkg, `${location}.deps[${index}].pkg`)] : []
  }).sort()
}

/** Convert Cargo's target-filtered non-dev resolve graph into CycloneDX. */
export function desktopCargoBom(target: string): Bom {
  desktopArchitecture(target)
  const metadata = cargoMetadata(target)
  const packages = metadata.packages
  const resolveGraph = table(metadata.resolve, 'cargo metadata.resolve')
  const nodes = resolveGraph.nodes
  if (!Array.isArray(packages) || !Array.isArray(nodes)) {
    throw new Error(`${LABEL}: cargo metadata must contain packages and resolve.nodes arrays.`)
  }
  const rootPath = resolve(ROOT, DESKTOP_ROOT, 'Cargo.toml')
  const rootPackage = packages.map((entry, index) => table(entry, `cargo metadata.packages[${index}]`)).find(pkg => pkg.manifest_path === rootPath)
  if (rootPackage === undefined) throw new Error(`${LABEL}: cargo metadata has no Desktop root package.`)
  const packageById = new Map(packages.map((entry, index) => {
    const pkg = table(entry, `cargo metadata.packages[${index}]`)
    return [requiredString(pkg.id, `cargo metadata.packages[${index}].id`), pkg]
  }))
  const nodeById = new Map(nodes.map((entry, index) => {
    const node = table(entry, `cargo metadata.resolve.nodes[${index}]`)
    return [requiredString(node.id, `cargo metadata.resolve.nodes[${index}].id`), node]
  }))
  const rootId = requiredString(rootPackage.id, 'cargo root package.id')
  const reachable = new Set<string>()
  const queue = [rootId]
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined || reachable.has(id)) continue
    reachable.add(id)
    const node = nodeById.get(id)
    if (node === undefined) throw new Error(`${LABEL}: Cargo resolve graph omits reachable package ${id}.`)
    queue.push(...cargoRuntimeDependencies(node, `cargo resolve node ${id}`))
  }
  const cargoRef = (id: string): string => `urn:dsh:cargo:${encodeURIComponent(id)}`
  const cargoPurl = (pkg: Table): string =>
    `pkg:cargo/${encodeURIComponent(requiredString(pkg.name, 'cargo package.name'))}@${encodeURIComponent(requiredString(pkg.version, 'cargo package.version'))}`
  const checksums = cargoChecksums()
  const componentFor = (id: string, pkg: Table): BomComponent => {
    const license = typeof pkg.license === 'string' && pkg.license.length > 0 ? pkg.license : undefined
    const source = typeof pkg.source === 'string' ? pkg.source : ''
    const checksum = checksums.get(
      `${requiredString(pkg.name, 'cargo package.name')}\u0000${requiredString(pkg.version, 'cargo package.version')}\u0000${source}`,
    )
    return {
      type: 'library',
      'bom-ref': cargoRef(id),
      name: requiredString(pkg.name, 'cargo package.name'),
      version: requiredString(pkg.version, 'cargo package.version'),
      purl: cargoPurl(pkg),
      ...(license === undefined ? {} : { licenses: [{ license: { name: license } }] }),
      ...(checksum === undefined ? {} : { hashes: [{ alg: 'SHA-256', content: checksum }] }),
      ...(source === '' ? {} : { properties: [{ name: 'dsh:cargo-source', value: source }] }),
    }
  }
  const components = [...reachable]
    .filter(id => id !== rootId)
    .map((id) => {
      const pkg = packageById.get(id)
      if (pkg === undefined) throw new Error(`${LABEL}: Cargo package metadata omits reachable package ${id}.`)
      return componentFor(id, pkg)
    })
    .sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']))
  const dependencies = [...reachable].map((id) => {
    const node = nodeById.get(id)
    if (node === undefined) throw new Error(`${LABEL}: Cargo resolve graph omits reachable package ${id}.`)
    return {
      ref: cargoRef(id),
      dependsOn: cargoRuntimeDependencies(node, `cargo resolve node ${id}`)
        .filter(dependency => reachable.has(dependency))
        .map(cargoRef),
    }
  }).sort((left, right) => left.ref.localeCompare(right.ref))
  const rootComponent = componentFor(rootId, rootPackage)
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: {
        ...rootComponent,
        type: 'application',
      },
    },
    components,
    dependencies,
  }
}

/** Read a SHA-256 digest and byte length without executing the artifact. */
function digest(path: string, role: RuntimeArtifact['role']): RuntimeArtifact {
  const absolute = resolve(ROOT, path)
  if (!existsSync(absolute)) throw new Error(`${LABEL}: required ${role} artifact is missing: ${path}.`)
  const stats = statSync(absolute)
  if (!stats.isFile()) throw new Error(`${LABEL}: ${role} artifact is not a regular file: ${path}.`)
  return {
    role,
    path: lockPath(relative(ROOT, absolute)),
    size: stats.size,
    buildSha256: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
    minimumMacos: minimumMacos(path),
  }
}

/** Run a host inspection command, preserving a useful release diagnostic. */
function hostCommand(command: string, args: readonly string[]): string {
  try {
    return execFileSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${LABEL}: ${command} ${args.join(' ')} failed: ${detail}`)
  }
}

/** Assert that an artifact's PE COFF machine matches the target architecture. */
function verifyPeArchitecture(path: string, architecture: string): void {
  const absolute = resolve(ROOT, path)
  const handle = openSync(absolute, 'r')
  try {
    const header = Buffer.alloc(0x40)
    if (readSync(handle, header, 0, header.length, 0) !== header.length || header.readUInt16LE(0) !== 0x5A4D) {
      throw new Error(`${LABEL}: ${path} must be a PE executable, got no MZ magic.`)
    }
    const peOffset = header.readUInt32LE(0x3C)
    const signatureAndMachine = Buffer.alloc(6)
    const readBytes = readSync(handle, signatureAndMachine, 0, signatureAndMachine.length, peOffset)
    if (readBytes !== signatureAndMachine.length || signatureAndMachine.toString('latin1', 0, 4) !== 'PE\u0000\u0000') {
      throw new Error(`${LABEL}: ${path} must be a PE executable, got no PE signature.`)
    }
    const machine = signatureAndMachine.readUInt16LE(4)
    const expected = architecture === 'x86_64' ? 0x8664 : 0xAA64
    if (machine !== expected) {
      throw new Error(`${LABEL}: ${path} must be ${architecture}; got COFF machine 0x${machine.toString(16).toUpperCase()}.`)
    }
  } finally {
    closeSync(handle)
  }
}

/**
 * Assert that one artifact's native header matches the Desktop target.
 * @param path - repository-relative artifact path.
 * @param target - Desktop target triple accepted by {@link desktopArchitecture}.
 */
function verifyArchitecture(path: string, target: string): void {
  const architecture = desktopArchitecture(target)
  if (target.endsWith('-pc-windows-msvc')) {
    verifyPeArchitecture(path, architecture)
    return
  }
  const output = hostCommand('lipo', ['-archs', resolve(ROOT, path)]).trim().split(/\s+/)
  if (output.length !== 1 || output[0] !== architecture) {
    throw new Error(`${LABEL}: ${path} must be thin ${architecture}; got ${output.join(', ') || 'none'}.`)
  }
}

/** Extract the application Mach-O minimum macOS version; PE artifacts have no macOS floor. */
function minimumMacos(path: string): string {
  const absolute = resolve(ROOT, path)
  const handle = openSync(absolute, 'r')
  try {
    const magic = Buffer.alloc(2)
    if (readSync(handle, magic, 0, magic.length, 0) === magic.length && magic.readUInt16LE(0) === 0x5A4D) {
      return 'n/a'
    }
  } finally {
    closeSync(handle)
  }
  const output = hostCommand('otool', ['-l', absolute])
  const modern = /cmd LC_BUILD_VERSION[\s\S]*?\n\s*minos\s+([^\s]+)/.exec(output)?.[1]
  if (modern !== undefined) return modern
  const legacy = /cmd LC_VERSION_MIN_MACOSX[\s\S]*?\n\s*version\s+([^\s]+)/.exec(output)?.[1]
  return legacy ?? 'unknown'
}

/** Ask Git for a stable release fact without making Git availability a development prerequisite. */
function gitFact(args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
}

/**
 * Read and verify the patched SEA packer selected by the workspace and lockfile.
 * @param root - repository root containing the workspace and frozen lockfile.
 * @returns immutable package, integrity, and patch identity.
 */
export function lockedSeaPacker(root = ROOT): LockedSeaPacker {
  const match = /^(?<name>@[^@/]+\/[^@]+|[^@]+)@(?<version>[^@]+)$/.exec(SEA_PKG_SPEC)
  if (match?.groups?.name === undefined || match.groups.version === undefined) {
    throw new Error(`${LABEL}: SEA_PKG_SPEC ${JSON.stringify(SEA_PKG_SPEC)} is not a package@version pin.`)
  }
  const name = match.groups.name
  const key = `${name}@${match.groups.version}`
  const document = table(yaml.load(readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')), 'pnpm-lock.yaml')
  const packages = table(document.packages, 'pnpm-lock.yaml.packages')
  const entry = optionalTable(packages[key], `pnpm-lock.yaml.packages.${SEA_PKG_SPEC}`)
  if (entry === undefined) {
    throw new Error(`${LABEL}: pnpm-lock.yaml does not lock ${SEA_PKG_SPEC}.`)
  }
  const integrity = requiredString(
    optionalTable(entry.resolution, `pnpm-lock.yaml.packages.${SEA_PKG_SPEC}.resolution`)?.integrity,
    `pnpm-lock.yaml.packages.${SEA_PKG_SPEC}.resolution.integrity`,
  )
  sriSha512(integrity, `pnpm-lock.yaml.packages.${SEA_PKG_SPEC}.resolution.integrity`)
  const patchHash = requiredString(
    table(document.patchedDependencies, 'pnpm-lock.yaml.patchedDependencies')[SEA_PKG_SPEC],
    `pnpm-lock.yaml.patchedDependencies.${SEA_PKG_SPEC}`,
  )
  if (!/^[0-9a-f]{64}$/u.test(patchHash)) {
    throw new Error(`${LABEL}: pnpm-lock.yaml.patchedDependencies.${SEA_PKG_SPEC} must be a lowercase SHA-256 digest.`)
  }
  const importer = table(
    table(document.importers, 'pnpm-lock.yaml.importers')['.'],
    'pnpm-lock.yaml.importers.',
  )
  const installed = table(
    table(importer.devDependencies, 'pnpm-lock.yaml.importers...devDependencies')[name],
    `pnpm-lock.yaml.importers...devDependencies.${name}`,
  )
  const resolved = requiredString(
    installed.version,
    `pnpm-lock.yaml.importers...devDependencies.${name}.version`,
  )
  if (!resolved.includes(`patch_hash=${patchHash}`)) {
    throw new Error(`${LABEL}: root ${SEA_PKG_SPEC} importer does not select patch hash ${patchHash}.`)
  }
  const workspace = table(yaml.load(readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8')), 'pnpm-workspace.yaml')
  const patchPath = requiredString(
    table(workspace.patchedDependencies, 'pnpm-workspace.yaml.patchedDependencies')[SEA_PKG_SPEC],
    `pnpm-workspace.yaml.patchedDependencies.${SEA_PKG_SPEC}`,
  )
  const patch = resolve(root, patchPath)
  const outside = relative(root, patch)
  if (outside === '' || outside === '..' || outside.startsWith(`..${posix.sep}`) || isAbsolute(outside)) {
    throw new Error(`${LABEL}: ${SEA_PKG_SPEC} patch path must remain inside the repository: ${JSON.stringify(patchPath)}.`)
  }
  if (!existsSync(patch)) {
    throw new Error(`${LABEL}: ${SEA_PKG_SPEC} patch is missing: ${lockPath(relative(root, patch))}.`)
  }
  const actualPatchHash = createHash('sha256').update(readFileSync(patch)).digest('hex')
  if (actualPatchHash !== patchHash) {
    throw new Error(`${LABEL}: ${SEA_PKG_SPEC} patch hash ${actualPatchHash} does not match pnpm-lock.yaml ${patchHash}.`)
  }
  return {
    declared: SEA_PKG_SPEC,
    lockfile: SEA_PKG_SPEC,
    integrity,
    patchHash,
  }
}

/** Parse a SEA runtime provenance record or report that the build did not make one. */
function seaProvenance(target: string): {
  readonly value: SeaRuntimeProvenance
  readonly path: string
} | undefined {
  const relativePath = `${DESKTOP_ROOT}/resources/runtime/${target}/sea-provenance.json`
  const path = resolve(ROOT, relativePath)
  if (!existsSync(path)) return undefined
  const document = table(JSON.parse(readFileSync(path, 'utf8')) as unknown, relativePath)
  const packer = table(document.packer, `${relativePath}.packer`)
  const node = table(document.node, `${relativePath}.node`)
  const provenance: SeaRuntimeProvenance = {
    schemaVersion: document.schemaVersion === 2 ? 2 : (() => { throw new Error(`${LABEL}: ${relativePath}.schemaVersion must be 2.`) })(),
    target: requiredString(document.target, `${relativePath}.target`),
    packer: {
      declared: requiredString(packer.declared, `${relativePath}.packer.declared`),
      patchHash: requiredString(packer.patchHash, `${relativePath}.packer.patchHash`),
    },
    node: {
      version: requiredString(node.version, `${relativePath}.node.version`),
      source: requiredString(node.source, `${relativePath}.node.source`),
      checksumSource: requiredString(node.checksumSource, `${relativePath}.node.checksumSource`),
      sha256: requiredString(node.sha256, `${relativePath}.node.sha256`),
    },
  }
  const arch = desktopArchitecture(target) === 'arm64' ? 'arm64' : 'x64'
  const identity = seaRuntimeArchive(SeaTarget.parse(`${SEA_NODE_RANGE}-${seaPlatformFor(target)}-${arch}`, LABEL))
  const expectedPacker = lockedSeaPacker()
  if (
    provenance.target !== target
    || provenance.packer.declared !== expectedPacker.declared
    || provenance.packer.patchHash !== expectedPacker.patchHash
    || provenance.node.version !== identity.version
    || provenance.node.source !== identity.source
    || provenance.node.checksumSource !== identity.checksumSource
    || provenance.node.sha256 !== identity.sha256
  ) {
    throw new Error(`${LABEL}: ${relativePath} does not prove ${target}, ${SEA_PKG_SPEC}, and ${SEA_NODE_RANGE} from ${identity.checksumSource}.`)
  }
  return { value: provenance, path: relativePath }
}

/** Compare numeric dotted macOS versions. */
function compareMacos(left: string, right: string): number {
  const parse = (value: string): number[] => {
    if (!/^\d+(?:\.\d+)*$/u.test(value)) throw new Error(`${LABEL}: invalid macOS version ${JSON.stringify(value)}.`)
    return value.split('.').map(part => Number.parseInt(part, 10))
  }
  const leftParts = parse(left)
  const rightParts = parse(right)
  const width = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < width; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** Read the supported macOS floor declared by the Tauri bundle. */
function configuredMinimumMacos(): string {
  const config = table(
    JSON.parse(readFileSync(resolve(ROOT, DESKTOP_ROOT, 'tauri.conf.json'), 'utf8')) as unknown,
    'Desktop tauri.conf.json',
  )
  const bundle = table(config.bundle, 'Desktop tauri.conf.json.bundle')
  const macos = table(bundle.macOS, 'Desktop tauri.conf.json.bundle.macOS')
  return requiredString(macos.minimumSystemVersion, 'Desktop tauri.conf.json.bundle.macOS.minimumSystemVersion')
}

/** Highest proven macOS deployment floor across artifacts, or 'unknown'. */
function minimumMacosFloor(artifacts: readonly RuntimeArtifact[]): string {
  const knownMinimums = artifacts
    .map(artifact => artifact.minimumMacos)
    .filter((value): value is string => value !== 'unknown')
  const minimum = knownMinimums.length === artifacts.length
    ? knownMinimums.reduce((highest, value) => compareMacos(value, highest) > 0 ? value : highest)
    : 'unknown'
  const configuredMinimum = configuredMinimumMacos()
  if (minimum !== 'unknown' && compareMacos(minimum, configuredMinimum) !== 0) {
    throw new Error(
      `${LABEL}: executable deployment floor is macOS ${minimum}, but tauri.conf.json declares ${configuredMinimum}.`,
    )
  }
  return minimum
}

/** Read and verify the shared dsh version before it enters release evidence. */
function releaseVersion(): RuntimeManifest['version'] {
  const manifest = table(JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as unknown, 'package.json')
  const dsh = requiredString(manifest.version, 'package.json.version')
  verifyDesktopVersion(ROOT, dsh)
  const apple = desktopVersion(dsh)
  return { dsh, marketing: apple.marketingVersion, bundle: apple.bundleVersion }
}

/** Reject a retained Node archive unless its bytes match both release identities. */
export function verifyNodeLicenseArchive(
  archive: string,
  identity: SeaRuntimeArchive,
  provenance: SeaRuntimeProvenance,
): void {
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
  if (actual !== provenance.node.sha256 || actual !== identity.sha256) {
    throw new Error(`${LABEL}: verified Node build cache hash does not match SEA provenance: ${lockPath(relative(ROOT, archive))}.`)
  }
}

/** Node's complete license text and its digest from the verified SEA build cache. */
interface NodeLicense {
  /** Exact UTF-8 text written to NODE_LICENSE. */
  readonly content: string
  /** SHA-256 of {@link content}'s UTF-8 bytes. */
  readonly sha256: string
}

/** Resolve a host tar that reads both gzip tarballs and the official win zip. */
function hostTar(): string {
  // Git Bash shadows Windows' bsdtar with GNU tar, which cannot read zip
  // archives, so the System32 bsdtar is selected explicitly on win32.
  return process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
}

/** Read Node's complete license text from the same verified build cache used by pkg. */
function nodeLicense(target: string): NodeLicense {
  const provenance = seaProvenance(target)
  if (provenance === undefined) {
    throw new Error(`${LABEL}: Node SEA provenance is required before extracting NODE_LICENSE.`)
  }
  const arch = desktopArchitecture(target) === 'arm64' ? 'arm64' : 'x64'
  const identity = seaRuntimeArchive(SeaTarget.parse(`${SEA_NODE_RANGE}-${seaPlatformFor(target)}-${arch}`, LABEL))
  const archive = seaRuntimeArchiveCachePath(resolve(ROOT, DESKTOP_CLOSURE, '.artifacts', 'sea'), identity)
  if (!existsSync(archive)) throw new Error(`${LABEL}: verified Node build cache is missing: ${lockPath(relative(ROOT, archive))}.`)
  verifyNodeLicenseArchive(archive, identity, provenance.value)
  const directory = identity.filename.replace(/\.(?:tar\.gz|zip)$/u, '')
  const content = hostCommand(hostTar(), ['-xOzf', archive, `${directory}/LICENSE`])
  return {
    content,
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  }
}

/** Build the runtime manifest for one completed Desktop target. */
export function runtimeManifest(target: string, nodeLicenseSha256: string, appBinary?: string): RuntimeManifest {
  if (!/^[0-9a-f]{64}$/u.test(nodeLicenseSha256)) {
    throw new Error(`${LABEL}: NODE_LICENSE SHA-256 must be a lowercase digest.`)
  }
  const architecture = desktopArchitecture(target)
  const windows = target.endsWith('-pc-windows-msvc')
  const sidecarPath = `${DESKTOP_ROOT}/binaries/${SIDECAR_BASENAME}-${target}${windows ? '.exe' : ''}`
  const resourceRoot = `${DESKTOP_ROOT}/resources/runtime/${target}`
  const appPath = appBinary === undefined
    ? `${DESKTOP_ROOT}/target/release/dsh-desktop${windows ? '.exe' : ''}`
    : appBinary
  const artifactPaths = windows
    ? [
      { path: appPath, role: 'host' as const },
      { path: sidecarPath, role: 'sidecar' as const },
      { path: `${resourceRoot}/rg.exe`, role: 'ripgrep' as const },
    ]
    : [
      { path: appPath, role: 'host' as const },
      { path: sidecarPath, role: 'sidecar' as const },
      { path: `${resourceRoot}/rg`, role: 'ripgrep' as const },
      { path: `${resourceRoot}/spawn-helper`, role: 'spawn-helper' as const },
    ]
  for (const artifact of artifactPaths) verifyArchitecture(artifact.path, target)
  const commit = gitFact(['rev-parse', 'HEAD'])
  const dirty = gitFact(['status', '--porcelain=v1'])
  const provenance = seaProvenance(target)
  const packer = lockedSeaPacker()
  const artifacts = artifactPaths.map(artifact => digest(artifact.path, artifact.role)) satisfies RuntimeArtifact[]
  const minimum = windows ? 'n/a' : minimumMacosFloor(artifacts)
  const blockers = [
    ...(commit === undefined ? ['repository commit is unknown'] : []),
    ...(dirty === undefined ? ['repository dirty state is unknown'] : dirty === '' ? [] : ['repository has uncommitted changes']),
    ...(minimum === 'unknown' ? ['one or more executable minimum macOS versions are unknown'] : []),
    ...(provenance === undefined ? [`Node SEA provenance is missing from ${resourceRoot}/sea-provenance.json`] : []),
  ]
  return {
    schemaVersion: 2,
    version: releaseVersion(),
    commit: commit ?? 'unknown',
    sourceDirty: dirty === undefined ? 'unknown' : dirty !== '',
    target: { triple: target, architecture, minimumMacos: minimum },
    artifacts,
    nodeSea: {
      declaredNodeRange: SEA_NODE_RANGE,
      packer,
      runtimeVersion: provenance?.value.node.version ?? 'unknown',
      source: provenance?.value.node.source ?? 'unknown',
      checksumSource: provenance?.value.node.checksumSource ?? 'unknown',
      sha256: provenance?.value.node.sha256 ?? 'unknown',
      licenseSha256: nodeLicenseSha256,
      provenance: provenance?.path ?? 'unknown',
    },
    releaseBlockers: blockers,
  }
}

/** Compare or write one generated legal file. */
async function writeGenerated(path: string, content: string, check: boolean): Promise<void> {
  if (check) {
    const current = existsSync(path) ? await readFile(path, 'utf8') : undefined
    if (current !== content) throw new Error(`${LABEL}: generated file is stale or missing: ${lockPath(relative(ROOT, path))}.`)
    return
  }
  await writeFile(path, content)
}

/** Infer a completed target from exactly one sidecar filename. */
function inferTarget(): string {
  const candidates = [
    ...globSync(`${DESKTOP_ROOT}/binaries/${SIDECAR_BASENAME}-*-apple-darwin`, { cwd: ROOT }),
    ...globSync(`${DESKTOP_ROOT}/binaries/${SIDECAR_BASENAME}-*-pc-windows-msvc.exe`, { cwd: ROOT }),
  ]
    .map(path => basename(path).slice(`${SIDECAR_BASENAME}-`.length).replace(/\.exe$/u, ''))
    .sort()
  if (candidates.length !== 1 || candidates[0] === undefined) {
    throw new Error(`${LABEL}: expected exactly one completed Desktop sidecar target; pass --target explicitly.`)
  }
  desktopArchitecture(candidates[0])
  return candidates[0]
}

/** CLI usage text. */
function usage(): string {
  return [
    'Usage: pnpm exec tsx scripts/prepare-desktop-release.ts [flags]',
    '',
    '  --target=<triple>       Desktop target, inferred from one completed sidecar when omitted.',
    '  --app-binary=<path>     built Desktop host to inspect for architecture and native headers.',
    '  --check                 verify generated legal resources without rewriting them.',
    '  --release               reject unknown SEA provenance, unlocked packers, dirty source, or unknown minOS.',
    '  --help                  print this help.',
  ].join('\n')
}

/** Materialize all generated Desktop legal resources for a completed target. */
export async function prepareDesktopRelease(options: {
  /** Desktop target triple, inferred from the sidecar if omitted. */
  readonly target?: string
  /** Absolute or repository-relative app binary to inspect. */
  readonly appBinary?: string
  /** Compare generated output instead of rewriting it. */
  readonly check?: boolean
  /** Apply release-only provenance and cleanliness gates. */
  readonly release?: boolean
} = {}): Promise<RuntimeManifest> {
  const target = options.target ?? inferTarget()
  desktopArchitecture(target)
  const legal = options.check
    ? resolve(ROOT, DESKTOP_LEGAL_RESOURCE_ROOT)
    : await ensureDesktopLegalResourceRoot()
  const appBinary = options.appBinary === undefined
    ? undefined
    : lockPath(relative(ROOT, isAbsolute(options.appBinary) ? options.appBinary : resolve(ROOT, options.appBinary)))
  const nodeLicenseEvidence = nodeLicense(target)
  const manifest = runtimeManifest(target, nodeLicenseEvidence.sha256, appBinary)
  if (options.release === true && manifest.releaseBlockers.length > 0) {
    throw new Error(`${LABEL}: release blocked:\n- ${manifest.releaseBlockers.join('\n- ')}`)
  }
  const npm = desktopNpmBom(target)
  const cargo = desktopCargoBom(target)
  const common = [
    { source: resolve(ROOT, 'LICENSE'), destination: resolve(legal, 'LICENSE') },
    { source: resolve(ROOT, 'THIRD_PARTY_NOTICES.md'), destination: resolve(legal, 'THIRD_PARTY_NOTICES.md') },
  ]
  for (const file of common) {
    if (options.check) {
      const source = await readFile(file.source)
      const destination = existsSync(file.destination) ? await readFile(file.destination) : undefined
      if (destination === undefined || !source.equals(destination)) {
        throw new Error(`${LABEL}: copied legal file is stale or missing: ${lockPath(relative(ROOT, file.destination))}.`)
      }
    } else {
      await copyFile(file.source, file.destination)
    }
  }
  await writeGenerated(resolve(legal, 'desktop-npm.cdx.json'), `${JSON.stringify(npm, null, 2)}\n`, options.check === true)
  await writeGenerated(resolve(legal, 'desktop-cargo.cdx.json'), `${JSON.stringify(cargo, null, 2)}\n`, options.check === true)
  await writeGenerated(resolve(legal, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, options.check === true)
  await writeGenerated(resolve(legal, 'NODE_LICENSE'), nodeLicenseEvidence.content, options.check === true)
  return manifest
}

/** Parse the release-preparation command line and materialize or verify outputs. */
async function main(): Promise<void> {
  let values: { target?: string; 'app-binary'?: string; check?: boolean; release?: boolean; help?: boolean }
  try {
    values = parseArgs({
      args: process.argv.slice(2),
      options: {
        target: { type: 'string' },
        'app-binary': { type: 'string' },
        check: { type: 'boolean', default: false },
        release: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }).values
  } catch (error) {
    throw new Error(`${LABEL}: ${error instanceof Error ? error.message : String(error)}\n\n${usage()}`)
  }
  if (values.help === true) {
    console.log(usage())
    return
  }
  const options: Parameters<typeof prepareDesktopRelease>[0] = {}
  if (values.target !== undefined) Object.assign(options, { target: values.target })
  if (values['app-binary'] !== undefined) Object.assign(options, { appBinary: values['app-binary'] })
  if (values.check !== undefined) Object.assign(options, { check: values.check })
  if (values.release !== undefined) Object.assign(options, { release: values.release })
  const manifest = await prepareDesktopRelease(options)
  console.log(`${LABEL}: ${manifest.target.triple}; ${manifest.artifacts.length} artifact digests; ${manifest.releaseBlockers.length} release blocker(s).`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  await main()
}
