/**
 * Validate the sealed macOS Desktop application before CI accepts or releases it.
 *
 * Build verification proves the immutable source payloads and release evidence.
 * Signed and release verification add Developer ID, hardened-runtime,
 * Gatekeeper, notarization, and mounted-DMG checks.
 */

import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  access,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { desktopVersion, verifyDesktopVersion } from './desktop-version.ts'
import { lockedSeaPacker } from './prepare-desktop-release.ts'
import { attempt, capture, isEntry, run } from './release/process.ts'
import { SEA_NODE_RANGE, SeaTarget, seaRuntimeArchive } from './single-exe-build.ts'

/** The only entitlements granted to the Node SEA sidecar under hardened runtime. */
export const SIDECAR_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-executable-page-protection',
  'com.apple.security.cs.disable-library-validation',
] as const

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..')
const EXPECTED_TARGET = 'aarch64-apple-darwin'
const RUNTIME_PATHS = {
  host: 'Contents/MacOS/dsh-desktop',
  sidecar: 'Contents/MacOS/dsh-desktop-runtime',
  ripgrep: 'Contents/Resources/runtime/rg',
  'spawn-helper': 'Contents/Resources/runtime/spawn-helper',
} as const
const REQUIRED_RELATIVE_PATHS = [
  'Contents/Info.plist',
  ...Object.values(RUNTIME_PATHS),
  'Contents/Resources/runtime/sea-provenance.json',
  'Contents/Resources/legal/LICENSE',
  'Contents/Resources/legal/NODE_LICENSE',
  'Contents/Resources/legal/THIRD_PARTY_NOTICES.md',
  'Contents/Resources/legal/desktop-npm.cdx.json',
  'Contents/Resources/legal/desktop-cargo.cdx.json',
  'Contents/Resources/legal/runtime-manifest.json',
] as const
const SOURCE_EVIDENCE_FILES = [
  {
    bundled: 'Contents/Resources/legal/LICENSE',
    source: 'apps/desktop/src-tauri/resources/legal/LICENSE',
  },
  {
    bundled: 'Contents/Resources/legal/THIRD_PARTY_NOTICES.md',
    source: 'apps/desktop/src-tauri/resources/legal/THIRD_PARTY_NOTICES.md',
  },
  {
    bundled: 'Contents/Resources/legal/desktop-npm.cdx.json',
    source: 'apps/desktop/src-tauri/resources/legal/desktop-npm.cdx.json',
  },
  {
    bundled: 'Contents/Resources/legal/desktop-cargo.cdx.json',
    source: 'apps/desktop/src-tauri/resources/legal/desktop-cargo.cdx.json',
  },
  {
    bundled: 'Contents/Resources/legal/runtime-manifest.json',
    source: 'apps/desktop/src-tauri/resources/legal/runtime-manifest.json',
  },
  {
    bundled: 'Contents/Resources/legal/NODE_LICENSE',
    source: 'apps/desktop/src-tauri/resources/legal/NODE_LICENSE',
  },
  {
    bundled: 'Contents/Resources/runtime/sea-provenance.json',
    source: 'apps/desktop/src-tauri/resources/runtime/aarch64-apple-darwin/sea-provenance.json',
  },
] as const
const MACH_O_MAGICS = new Set([
  0xfeedface,
  0xfeedfacf,
  0xcefaedfe,
  0xcffaedfe,
  0xcafebabe,
  0xcafebabf,
  0xbebafeca,
  0xbfbafeca,
])

type JsonRecord = Record<string, unknown>
type RuntimeRole = keyof typeof RUNTIME_PATHS

/** A parsed dotted macOS version. */
export type MacOSVersion = readonly number[]

/** The validation depth appropriate to one Desktop artifact lifecycle stage. */
export type DesktopBundleMode = 'build' | 'signed' | 'release'

/** Inputs for Desktop bundle validation. */
export interface DesktopBundleVerification {
  /** The `.app` bundle emitted by Tauri. */
  readonly app: string
  /** The architecture every Mach-O slice must carry. */
  readonly architecture: 'arm64'
  /** The product's supported macOS floor. */
  readonly minimumMacOS: string
  /** Whether only layout, signed code, or notarized distribution is required. */
  readonly mode: DesktopBundleMode
  /** The expected Developer ID team when signed code is required. */
  readonly teamId?: string
  /** The notarized disk image when release validation is required. */
  readonly dmg?: string
  /** The immutable source commit the bundled runtime manifest must describe. */
  readonly expectedCommit?: string
}

interface ReleaseIdentity {
  readonly dshVersion: string
  readonly marketingVersion: string
  readonly bundleVersion: string
  readonly identifier: string
}

/** Parse a numeric dotted macOS version. */
export function parseMacOSVersion(value: string): MacOSVersion {
  if (!/^\d+(?:\.\d+)*$/u.test(value)) throw new Error(`invalid macOS version: ${JSON.stringify(value)}`)
  return value.split('.').map(part => Number.parseInt(part, 10))
}

/** Render a parsed macOS version without changing its semantic components. */
export function renderMacOSVersion(version: MacOSVersion): string {
  return version.join('.')
}

/** Compare two dotted macOS versions after padding their absent components with zero. */
export function compareMacOSVersions(left: MacOSVersion, right: MacOSVersion): number {
  const width = Math.max(left.length, right.length)
  for (let index = 0; index < width; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** Return whether a file header begins with a supported thin or fat Mach-O magic number. */
export function isMachO(header: Uint8Array): boolean {
  if (header.byteLength < 4) return false
  return MACH_O_MAGICS.has(Buffer.from(header).readUInt32BE(0))
}

/** Extract every deployment target reported by `otool -l`. */
export function parseOtoolDeploymentTargets(output: string): readonly MacOSVersion[] {
  const targets = [...output.matchAll(/^\s*minos\s+(\d+(?:\.\d+)*)\s*$/gmu)]
    .map(match => parseMacOSVersion(match[1] ?? ''))
  const lines = output.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== 'cmd LC_VERSION_MIN_MACOSX') continue
    const version = lines.slice(index + 1).find(line => /^\s*version\s+\d/u.test(line))
    const match = /^\s*version\s+(\d+(?:\.\d+)*)\s*$/u.exec(version ?? '')
    if (match?.[1] !== undefined) targets.push(parseMacOSVersion(match[1]))
  }
  if (targets.length === 0) throw new Error('otool output contains no macOS deployment target')
  return targets
}

/** Reject entitlement XML that differs from the sidecar's fixed allowance. */
export function assertExactSidecarEntitlements(xml: string): void {
  const keys = [...xml.matchAll(/<key>([^<]+)<\/key>/gu)].map(match => match[1] ?? '')
  const expected = new Set<string>(SIDECAR_ENTITLEMENTS)
  const actual = new Set(keys)
  if (keys.length !== expected.size || actual.size !== expected.size || [...actual].some(key => !expected.has(key))) {
    throw new Error(`sidecar entitlements must contain exactly: ${SIDECAR_ENTITLEMENTS.join(', ')}`)
  }
  for (const entitlement of SIDECAR_ENTITLEMENTS) {
    const enabled = new RegExp(`<key>${escapeRegExp(entitlement)}</key>\\s*<true\\s*/>`, 'u').test(xml)
    if (!enabled) throw new Error(`sidecar entitlement ${entitlement} must be true`)
  }
}

/** Discover every regular Mach-O file in a bundle without resolving symlinks. */
export async function listMachOFiles(root: string): Promise<readonly string[]> {
  const files: string[] = []
  await walk(resolve(root), files)
  return files.sort((left, right) => left.localeCompare(right))
}

/** Validate the Desktop bundle and return its sealed Mach-O paths. */
export async function verifyDesktopBundle(options: DesktopBundleVerification): Promise<readonly string[]> {
  const floor = parseMacOSVersion(options.minimumMacOS)
  const app = resolve(options.app)
  await assertDirectory(app)
  for (const path of REQUIRED_RELATIVE_PATHS) await assertRegularFile(resolve(app, path))

  const identity = await releaseIdentity()
  verifyInfoPlist(app, identity, floor)
  await verifyReleaseEvidence(app, options, identity, floor)

  const machOs = await listMachOFiles(app)
  if (machOs.length === 0) throw new Error(`Desktop bundle contains no Mach-O files: ${app}`)
  for (const path of machOs) verifyMachO(app, path, options.architecture, floor)

  if (options.mode !== 'build') {
    if (options.teamId === undefined || options.teamId === '') throw new Error(`${options.mode} verification requires --team-id`)
    verifyDeveloperId(app, options.teamId, true)
    for (const path of machOs) {
      verifyDeveloperId(path, options.teamId, false)
      const entitlements = commandOutput('codesign', ['-d', '--entitlements', ':-', path])
      if (entitlements.includes('com.apple.security.get-task-allow')) {
        throw new Error(`${displayPath(app, path)} must not grant com.apple.security.get-task-allow`)
      }
    }
    assertExactSidecarEntitlements(
      commandOutput('codesign', ['-d', '--entitlements', ':-', resolve(app, RUNTIME_PATHS.sidecar)]),
    )
  }

  if (options.mode === 'release') {
    if (options.dmg === undefined || options.dmg === '') throw new Error('release verification requires --dmg')
    await verifyNotarizedDmg(app, resolve(options.dmg), options)
  }

  console.log(`desktop bundle verified (${options.mode}): ${app}`)
  return machOs
}

async function releaseIdentity(): Promise<ReleaseIdentity> {
  const rootManifest = jsonRecord(
    JSON.parse(await readFile(resolve(REPOSITORY_ROOT, 'package.json'), 'utf8')) as unknown,
    'package.json',
  )
  const dshVersion = requiredString(rootManifest.version, 'package.json.version')
  verifyDesktopVersion(REPOSITORY_ROOT, dshVersion)
  const apple = desktopVersion(dshVersion)
  const tauri = jsonRecord(
    JSON.parse(await readFile(resolve(REPOSITORY_ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')) as unknown,
    'tauri.conf.json',
  )
  return {
    dshVersion,
    marketingVersion: apple.marketingVersion,
    bundleVersion: apple.bundleVersion,
    identifier: requiredString(tauri.identifier, 'tauri.conf.json.identifier'),
  }
}

function verifyInfoPlist(
  app: string,
  identity: ReleaseIdentity,
  floor: MacOSVersion,
): void {
  const plist = resolve(app, 'Contents/Info.plist')
  const expected = {
    CFBundleShortVersionString: identity.marketingVersion,
    CFBundleVersion: identity.bundleVersion,
    CFBundleIdentifier: identity.identifier,
  }
  for (const [key, value] of Object.entries(expected)) {
    const actual = capture('plutil', ['-extract', key, 'raw', '-o', '-', plist])
    if (actual !== value) throw new Error(`Desktop Info.plist ${key} is ${actual}, expected ${value}`)
  }
  const declared = parseMacOSVersion(capture('plutil', [
    '-extract', 'LSMinimumSystemVersion', 'raw', '-o', '-', plist,
  ]))
  if (compareMacOSVersions(declared, floor) !== 0) {
    throw new Error(`Desktop Info.plist declares macOS ${renderMacOSVersion(declared)}, expected ${renderMacOSVersion(floor)}`)
  }
}

async function verifyReleaseEvidence(
  app: string,
  options: DesktopBundleVerification,
  identity: ReleaseIdentity,
  floor: MacOSVersion,
): Promise<void> {
  const legal = resolve(app, 'Contents/Resources/legal')
  for (const name of ['LICENSE', 'NODE_LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    if ((await stat(resolve(legal, name))).size === 0) throw new Error(`Desktop legal resource is empty: ${name}`)
  }
  for (const evidence of SOURCE_EVIDENCE_FILES) {
    await assertEvidenceBytes(
      resolve(REPOSITORY_ROOT, evidence.source),
      resolve(app, evidence.bundled),
      evidence.bundled,
    )
  }
  const npmBom = await readJson(resolve(legal, 'desktop-npm.cdx.json'), 'npm SBOM')
  const cargoBom = await readJson(resolve(legal, 'desktop-cargo.cdx.json'), 'Cargo SBOM')
  assertBom(npmBom, 'npm SBOM')
  assertBom(cargoBom, 'Cargo SBOM')
  const npmNames = componentNames(npmBom)
  if (!npmNames.includes('@vscode/ripgrep-darwin-arm64')) {
    throw new Error('npm SBOM must contain @vscode/ripgrep-darwin-arm64')
  }
  const incompatibleRipgrep = npmNames.filter(name =>
    name.startsWith('@vscode/ripgrep-') && name !== '@vscode/ripgrep-darwin-arm64')
  if (incompatibleRipgrep.length > 0) {
    throw new Error(`npm SBOM contains incompatible ripgrep packages: ${incompatibleRipgrep.join(', ')}`)
  }

  const manifest = await readJson(resolve(legal, 'runtime-manifest.json'), 'runtime manifest')
  if (manifest.schemaVersion !== 2) throw new Error('runtime manifest schemaVersion must be 2')
  const version = jsonRecord(manifest.version, 'runtime manifest.version')
  if (
    version.dsh !== identity.dshVersion
    || version.marketing !== identity.marketingVersion
    || version.bundle !== identity.bundleVersion
  ) {
    throw new Error('runtime manifest version does not match root and Apple bundle versions')
  }
  const manifestCommit = requiredString(manifest.commit, 'runtime manifest.commit')
  if (manifestCommit === 'unknown' || !/^[0-9a-f]{40,64}$/u.test(manifestCommit)) {
    throw new Error('runtime manifest commit must be a Git object id')
  }
  assertExpectedRuntimeManifestCommit(manifestCommit, options.expectedCommit)
  if (manifest.sourceDirty !== false) throw new Error('runtime manifest must describe a clean source tree')
  const blockers = stringArray(manifest.releaseBlockers, 'runtime manifest.releaseBlockers')
  if (blockers.length > 0) throw new Error(`runtime manifest has release blockers: ${blockers.join('; ')}`)

  const target = jsonRecord(manifest.target, 'runtime manifest.target')
  if (target.triple !== EXPECTED_TARGET || target.architecture !== options.architecture) {
    throw new Error('runtime manifest target does not match the arm64 Desktop release')
  }
  const manifestFloor = parseMacOSVersion(requiredString(target.minimumMacos, 'runtime manifest.target.minimumMacos'))
  if (compareMacOSVersions(manifestFloor, floor) !== 0) {
    throw new Error('runtime manifest minimumMacos does not match the supported floor')
  }

  if (!Array.isArray(manifest.artifacts)) throw new Error('runtime manifest.artifacts must be an array')
  const artifacts = new Map<RuntimeRole, JsonRecord>()
  for (const [index, value] of manifest.artifacts.entries()) {
    const artifact = jsonRecord(value, `runtime manifest.artifacts[${index}]`)
    const role = requiredString(artifact.role, `runtime manifest.artifacts[${index}].role`)
    if (!Object.hasOwn(RUNTIME_PATHS, role)) throw new Error(`runtime manifest has unknown artifact role ${role}`)
    if (artifacts.has(role as RuntimeRole)) throw new Error(`runtime manifest repeats artifact role ${role}`)
    artifacts.set(role as RuntimeRole, artifact)
  }
  if (artifacts.size !== Object.keys(RUNTIME_PATHS).length) {
    throw new Error('runtime manifest must describe host, sidecar, ripgrep, and spawn-helper exactly once')
  }
  for (const [role, relativePath] of Object.entries(RUNTIME_PATHS) as [RuntimeRole, string][]) {
    const artifact = artifacts.get(role)
    if (artifact === undefined) throw new Error(`runtime manifest omits ${role}`)
    const bundled = resolve(app, relativePath)
    const actualMinimum = highestDeploymentTarget(bundled)
    const recordedMinimum = parseMacOSVersion(requiredString(
      artifact.minimumMacos,
      `runtime manifest ${role}.minimumMacos`,
    ))
    if (compareMacOSVersions(actualMinimum, recordedMinimum) !== 0) {
      throw new Error(`runtime manifest ${role} minimumMacos does not match the bundled Mach-O`)
    }
    if (options.mode === 'build') {
      const expectedSize = requiredNumber(artifact.size, `runtime manifest ${role}.size`)
      const expectedHash = requiredString(artifact.buildSha256, `runtime manifest ${role}.buildSha256`)
      const metadata = await stat(bundled)
      if (metadata.size !== expectedSize || await sha256(bundled) !== expectedHash) {
        throw new Error(`runtime manifest ${role} build digest does not match the bundled payload`)
      }
    }
  }

  const nodeSea = jsonRecord(manifest.nodeSea, 'runtime manifest.nodeSea')
  const provenance = await readJson(
    resolve(app, 'Contents/Resources/runtime/sea-provenance.json'),
    'SEA provenance',
  )
  assertPinnedNodeSeaEvidence(nodeSea, provenance, await readFile(resolve(legal, 'NODE_LICENSE')))
}

/**
 * Compare one bundled evidence file against the current release source resource.
 * @param source - source resource path.
 * @param bundled - corresponding path inside the Desktop application.
 * @param bundledRelativePath - bundle-relative path reported if bytes differ.
 * @returns Nothing when both byte streams are identical.
 */
export async function assertEvidenceBytes(
  source: string,
  bundled: string,
  bundledRelativePath: string,
): Promise<void> {
  const [expected, actual] = await Promise.all([readFile(source), readFile(bundled)])
  if (!expected.equals(actual)) {
    throw new Error(`Desktop bundled evidence differs from source resource: ${bundledRelativePath}`)
  }
}

/**
 * Assert the bundle's Node and packer provenance against current immutable inputs.
 * @param nodeSea - Node evidence from the runtime manifest.
 * @param provenance - SEA provenance bundled with the sidecar resources.
 * @param nodeLicense - exact bundled NODE_LICENSE bytes.
 * @returns Nothing when every recorded value matches the source lock and Node pin.
 */
export function assertPinnedNodeSeaEvidence(
  nodeSea: JsonRecord,
  provenance: JsonRecord,
  nodeLicense: Uint8Array,
): void {
  const packer = lockedSeaPacker()
  const node = seaRuntimeArchive(SeaTarget.parse(`${SEA_NODE_RANGE}-macos-arm64`, 'Desktop bundle'))
  const nodePacker = jsonRecord(nodeSea.packer, 'runtime manifest.nodeSea.packer')
  const provenancePacker = jsonRecord(provenance.packer, 'SEA provenance.packer')
  const provenanceNode = jsonRecord(provenance.node, 'SEA provenance.node')
  const expectedLicenseSha256 = createHash('sha256').update(nodeLicense).digest('hex')
  const expectedProvenance = 'apps/desktop/src-tauri/resources/runtime/aarch64-apple-darwin/sea-provenance.json'

  assertEvidenceValue(nodeSea.declaredNodeRange, SEA_NODE_RANGE, 'runtime manifest nodeSea.declaredNodeRange')
  assertEvidenceValue(nodePacker.declared, packer.declared, 'runtime manifest nodeSea.packer.declared')
  assertEvidenceValue(nodePacker.lockfile, packer.lockfile, 'runtime manifest nodeSea.packer.lockfile')
  assertEvidenceValue(nodePacker.integrity, packer.integrity, 'runtime manifest nodeSea.packer.integrity')
  assertEvidenceValue(nodePacker.patchHash, packer.patchHash, 'runtime manifest nodeSea.packer.patchHash')
  assertEvidenceValue(nodeSea.runtimeVersion, node.version, 'runtime manifest nodeSea.runtimeVersion')
  assertEvidenceValue(nodeSea.source, node.source, 'runtime manifest nodeSea.source')
  assertEvidenceValue(nodeSea.checksumSource, node.checksumSource, 'runtime manifest nodeSea.checksumSource')
  assertEvidenceValue(nodeSea.sha256, node.sha256, 'runtime manifest nodeSea.sha256')
  assertEvidenceValue(nodeSea.licenseSha256, expectedLicenseSha256, 'runtime manifest nodeSea.licenseSha256')
  assertEvidenceValue(nodeSea.provenance, expectedProvenance, 'runtime manifest nodeSea.provenance')

  assertEvidenceValue(provenance.schemaVersion, 2, 'SEA provenance.schemaVersion')
  assertEvidenceValue(provenance.target, EXPECTED_TARGET, 'SEA provenance.target')
  assertEvidenceValue(provenancePacker.declared, packer.declared, 'SEA provenance.packer.declared')
  assertEvidenceValue(provenancePacker.patchHash, packer.patchHash, 'SEA provenance.packer.patchHash')
  assertEvidenceValue(provenanceNode.version, node.version, 'SEA provenance.node.version')
  assertEvidenceValue(provenanceNode.source, node.source, 'SEA provenance.node.source')
  assertEvidenceValue(provenanceNode.checksumSource, node.checksumSource, 'SEA provenance.node.checksumSource')
  assertEvidenceValue(provenanceNode.sha256, node.sha256, 'SEA provenance.node.sha256')
}

/** Compare one persistent evidence value with the immutable value it must record. */
function assertEvidenceValue(actual: unknown, expected: string | number, location: string): void {
  if (actual !== expected) {
    throw new Error(`${location} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

/**
 * Bind a bundled runtime manifest to the source commit selected by its release.
 * @param actualCommit - Commit recorded in the bundled runtime manifest.
 * @param expectedCommit - Immutable release commit, when the caller has one.
 * @returns Nothing when the commits agree or no expected commit was supplied.
 */
export function assertExpectedRuntimeManifestCommit(actualCommit: string, expectedCommit: string | undefined): void {
  if (expectedCommit !== undefined && actualCommit !== expectedCommit) {
    throw new Error(`runtime manifest commit mismatch: expected ${expectedCommit}, got ${actualCommit}`)
  }
}

function assertBom(value: JsonRecord, label: string): void {
  if (value.bomFormat !== 'CycloneDX' || value.specVersion !== '1.6') {
    throw new Error(`${label} must be CycloneDX 1.6`)
  }
  const metadata = jsonRecord(value.metadata, `${label}.metadata`)
  const root = jsonRecord(metadata.component, `${label}.metadata.component`)
  const rootRef = requiredString(root['bom-ref'], `${label}.metadata.component.bom-ref`)
  if (!Array.isArray(value.components) || value.components.length === 0) {
    throw new Error(`${label}.components must be non-empty`)
  }
  if (!Array.isArray(value.dependencies)) throw new Error(`${label}.dependencies must be an array`)
  const hasRootEdge = value.dependencies.some((entry) => {
    const dependency = jsonRecord(entry, `${label}.dependencies entry`)
    return dependency.ref === rootRef && Array.isArray(dependency.dependsOn)
  })
  if (!hasRootEdge) throw new Error(`${label} must connect its metadata root to the dependency graph`)
}

function componentNames(value: JsonRecord): string[] {
  if (!Array.isArray(value.components)) return []
  return value.components.map((entry, index) =>
    requiredString(jsonRecord(entry, `SBOM components[${index}]`).name, `SBOM components[${index}].name`))
}

function verifyMachO(
  app: string,
  path: string,
  architecture: 'arm64',
  floor: MacOSVersion,
): void {
  const architectures = capture('lipo', ['-archs', path]).split(/\s+/u).filter(Boolean)
  if (architectures.length !== 1 || architectures[0] !== architecture) {
    throw new Error(`${displayPath(app, path)} must be thin ${architecture}, got ${architectures.join(', ') || '(none)'}`)
  }
  const highest = highestDeploymentTarget(path)
  if (compareMacOSVersions(highest, floor) > 0) {
    throw new Error(
      `${displayPath(app, path)} requires macOS ${renderMacOSVersion(highest)}, above ${renderMacOSVersion(floor)}`,
    )
  }
}

function highestDeploymentTarget(path: string): MacOSVersion {
  return parseOtoolDeploymentTargets(capture('otool', ['-l', path]))
    .reduce((current, candidate) =>
      compareMacOSVersions(candidate, current) > 0 ? candidate : current)
}

async function verifyNotarizedDmg(
  sourceApp: string,
  dmg: string,
  options: DesktopBundleVerification,
): Promise<void> {
  if (options.teamId === undefined || options.teamId === '') {
    throw new Error('release verification requires --team-id')
  }
  const teamId = options.teamId
  await assertRegularFile(dmg)
  run('hdiutil', ['verify', dmg])
  run('codesign', ['--verify', '--verbose=4', dmg])
  run('xcrun', ['stapler', 'validate', sourceApp])
  run('xcrun', ['stapler', 'validate', dmg])
  run('spctl', ['--assess', '--type', 'execute', '--verbose=4', sourceApp])
  run('spctl', ['--assess', '--type', 'open', '--verbose=4', dmg])

  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-dmg-'))
  const mountpoint = resolve(root, 'mounted')
  await rm(mountpoint, { force: true, recursive: true })
  let attached = false
  let failure: Error | undefined
  try {
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountpoint, dmg])
    attached = true
    const entries = (await readdir(mountpoint)).sort()
    const expected = ['Applications', basename(sourceApp)].sort()
    if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) {
      throw new Error(`DMG root must contain exactly ${expected.join(' and ')}, got ${entries.join(', ')}`)
    }
    const applications = resolve(mountpoint, 'Applications')
    if (await readlink(applications) !== '/Applications') {
      throw new Error('DMG Applications link must target /Applications')
    }
    const mountedApp = resolve(mountpoint, basename(sourceApp))
    await verifyDesktopBundle({
      app: mountedApp,
      architecture: options.architecture,
      minimumMacOS: options.minimumMacOS,
      mode: 'signed',
      teamId,
      ...(options.expectedCommit === undefined ? {} : { expectedCommit: options.expectedCommit }),
    })
    run('xcrun', ['stapler', 'validate', mountedApp])
    run('spctl', ['--assess', '--type', 'execute', '--verbose=4', mountedApp])
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

async function walk(directory: string, files: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      await walk(path, files)
      continue
    }
    if (!entry.isFile()) continue
    if (isMachO(await readHeader(path))) files.push(path)
  }
}

async function readHeader(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(4)
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0)
    return header.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function readJson(path: string, label: string): Promise<JsonRecord> {
  try {
    return jsonRecord(JSON.parse(await readFile(path, 'utf8')) as unknown, label)
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON: ${error.message}`)
    throw error
  }
}

function jsonRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as JsonRecord
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`)
  const result: string[] = []
  for (const rawItem of value) {
    const item: unknown = rawItem
    if (typeof item !== 'string') throw new Error(`${label} must be an array of strings`)
    result.push(item)
  }
  return result
}

async function assertDirectory(path: string): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isDirectory()) throw new Error(`Desktop app is not a directory: ${path}`)
}

async function assertRegularFile(path: string): Promise<void> {
  await access(path)
  const metadata = await lstat(path)
  if (!metadata.isFile()) throw new Error(`expected regular file: ${path}`)
}

function displayPath(root: string, path: string): string {
  return relative(root, path) || '.'
}

function commandOutput(command: string, args: readonly string[]): string {
  const result = attempt(command, args)
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}:\n${result.stdout}\n${result.stderr}`)
  }
  return `${result.stdout}\n${result.stderr}`
}

function verifyDeveloperId(path: string, teamId: string, deep: boolean): void {
  run('codesign', ['--verify', ...(deep ? ['--deep'] : []), '--strict', '--verbose=4', path])
  const signature = commandOutput('codesign', ['-dvvv', path])
  if (!signature.includes('Authority=Developer ID Application:')) {
    throw new Error(`${path} is not signed by a Developer ID Application certificate`)
  }
  if (!signature.includes(`TeamIdentifier=${teamId}`)) {
    throw new Error(`${path} does not carry expected TeamIdentifier=${teamId}`)
  }
  if (!/flags=0x[0-9a-f]+\(runtime\)/iu.test(signature)) {
    throw new Error(`${path} is not signed with hardened runtime`)
  }
  if (!signature.includes('Timestamp=')) throw new Error(`${path} has no secure signing timestamp`)
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const rawChunk of createReadStream(path)) {
    const chunk: unknown = rawChunk
    if (!(chunk instanceof Uint8Array)) throw new Error(`bundle asset stream returned non-binary data for ${path}`)
    hash.update(chunk)
  }
  return hash.digest('hex')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      app: { type: 'string' },
      arch: { type: 'string', default: 'arm64' },
      dmg: { type: 'string' },
      mode: { type: 'string', default: 'build' },
      'minimum-macos': { type: 'string' },
      'team-id': { type: 'string' },
    },
    allowPositionals: false,
  })
  if (values.app === undefined || values['minimum-macos'] === undefined) {
    throw new Error('usage: verify-desktop-bundle.ts --app <app> --minimum-macos <version> [--mode build|signed|release] [--dmg <dmg>] [--team-id <team>]')
  }
  const mode = values.mode
  if (mode !== 'build' && mode !== 'signed' && mode !== 'release') {
    throw new Error(`invalid Desktop verification mode: ${mode}`)
  }
  if (values.arch !== 'arm64') throw new Error(`Desktop release requires --arch arm64, got ${values.arch}`)
  const options: DesktopBundleVerification = {
    app: values.app,
    architecture: values.arch,
    minimumMacOS: values['minimum-macos'],
    mode,
    ...(values['team-id'] === undefined ? {} : { teamId: values['team-id'] }),
    ...(values.dmg === undefined ? {} : { dmg: values.dmg }),
  }
  await verifyDesktopBundle(options)
}

if (isEntry(import.meta.url)) await main()
