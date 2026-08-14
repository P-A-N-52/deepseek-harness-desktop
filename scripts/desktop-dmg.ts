/** Immutable metadata and user-facing text for the unsigned Desktop DMG. */

const TARGET = 'aarch64-apple-darwin'

/** Facts recorded next to one locally packaged Desktop disk image. */
export interface DesktopDmgManifest {
  readonly schemaVersion: 2
  readonly kind: 'unsigned-developer-preview'
  readonly product: string
  readonly version: {
    readonly dsh: string
    readonly marketing: string
    readonly bundle: string
  }
  readonly identifier: string
  readonly source: {
    readonly tag: string
    readonly commit: string
    readonly dirty: false
  }
  readonly target: {
    readonly triple: typeof TARGET
    readonly architecture: 'arm64'
    readonly minimumMacOS: string
  }
  readonly distribution: {
    readonly applicationSignature: 'ad-hoc'
    readonly hardenedRuntime: true
    readonly developerId: false
    readonly notarized: false
    readonly diskImageSignature: 'none'
    readonly gatekeeperApprovalRequired: true
    readonly automaticUpdates: false
  }
  readonly assets: readonly [{ readonly file: string; readonly bytes: number; readonly sha256: string }]
}

/**
 * Construct the only tag name permitted for an unsigned Desktop version.
 *
 * @param version - Root dsh semantic version.
 * @returns The annotated Git tag required by the local packager.
 */
export function desktopUnsignedTag(version: string): string {
  assertReleaseVersion(version)
  return `desktop-unsigned-v${version}`
}

/**
 * Render a stable filename that makes the unnotarized distribution status explicit.
 *
 * @param product - Application product name.
 * @param version - Root dsh semantic version.
 * @returns The single supported arm64 DMG filename.
 */
export function desktopUnsignedDmgName(product: string, version: string): string {
  assertReleaseVersion(version)
  const stem = product.trim().replace(/[^A-Za-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
  if (stem === '') throw new Error('Desktop product name cannot be empty')
  return `${stem}_${version}_aarch64_unsigned.dmg`
}

/**
 * Render the complete two-file checksum inventory for one DMG output directory.
 *
 * @param asset - Disk image metadata recorded in the release manifest.
 * @param manifestSha256 - Digest of `release-manifest.json`.
 * @returns Canonical `shasum -c` input for both delivery files.
 */
export function renderDesktopDmgChecksums(
  asset: DesktopDmgManifest['assets'][0],
  manifestSha256: string,
): string {
  if (!/^[0-9a-f]{64}$/u.test(asset.sha256) || !/^[0-9a-f]{64}$/u.test(manifestSha256)) {
    throw new Error('Desktop DMG checksums must be lowercase SHA-256 digests')
  }
  return `${asset.sha256}  ${asset.file}\n${manifestSha256}  release-manifest.json\n`
}

/**
 * Parse and validate one unsigned Desktop release manifest.
 *
 * @param value - JSON value read from `release-manifest.json`.
 * @returns The exact schema-2 unsigned distribution manifest.
 */
export function parseDesktopDmgManifest(value: unknown): DesktopDmgManifest {
  const manifest = record(value, 'release manifest')
  assertExactKeys(manifest, [
    'schemaVersion',
    'kind',
    'product',
    'version',
    'identifier',
    'source',
    'target',
    'distribution',
    'assets',
  ], 'release manifest')
  assertEqual(manifest.schemaVersion, 2, 'release manifest.schemaVersion')
  assertEqual(manifest.kind, 'unsigned-developer-preview', 'release manifest.kind')
  const product = nonEmptyString(manifest.product, 'release manifest.product')
  const versionValue = record(manifest.version, 'release manifest.version')
  assertExactKeys(versionValue, ['dsh', 'marketing', 'bundle'], 'release manifest.version')
  const version = {
    dsh: nonEmptyString(versionValue.dsh, 'release manifest.version.dsh'),
    marketing: nonEmptyString(versionValue.marketing, 'release manifest.version.marketing'),
    bundle: nonEmptyString(versionValue.bundle, 'release manifest.version.bundle'),
  }
  assertReleaseVersion(version.dsh)
  const identifier = nonEmptyString(manifest.identifier, 'release manifest.identifier')
  const sourceValue = record(manifest.source, 'release manifest.source')
  assertExactKeys(sourceValue, ['tag', 'commit', 'dirty'], 'release manifest.source')
  const source = {
    tag: nonEmptyString(sourceValue.tag, 'release manifest.source.tag'),
    commit: nonEmptyString(sourceValue.commit, 'release manifest.source.commit'),
    dirty: false as const,
  }
  assertEqual(sourceValue.dirty, false, 'release manifest.source.dirty')
  if (!/^[0-9a-f]{40,64}$/u.test(source.commit)) {
    throw new Error('release manifest.source.commit must be a Git object id')
  }
  assertEqual(source.tag, desktopUnsignedTag(version.dsh), 'release manifest.source.tag')

  const targetValue = record(manifest.target, 'release manifest.target')
  assertExactKeys(targetValue, ['triple', 'architecture', 'minimumMacOS'], 'release manifest.target')
  const target = {
    triple: TARGET,
    architecture: 'arm64',
    minimumMacOS: nonEmptyString(targetValue.minimumMacOS, 'release manifest.target.minimumMacOS'),
  } as const
  assertEqual(targetValue.triple, target.triple, 'release manifest.target.triple')
  assertEqual(targetValue.architecture, target.architecture, 'release manifest.target.architecture')

  const distributionValue = record(manifest.distribution, 'release manifest.distribution')
  const distribution = {
    applicationSignature: 'ad-hoc' as const,
    hardenedRuntime: true as const,
    developerId: false as const,
    notarized: false as const,
    diskImageSignature: 'none' as const,
    gatekeeperApprovalRequired: true as const,
    automaticUpdates: false as const,
  }
  assertExactKeys(distributionValue, Object.keys(distribution), 'release manifest.distribution')
  for (const [key, expected] of Object.entries(distribution)) {
    assertEqual(distributionValue[key], expected, `release manifest.distribution.${key}`)
  }

  if (!Array.isArray(manifest.assets) || manifest.assets.length !== 1) {
    throw new Error('release manifest.assets must contain exactly one disk image')
  }
  const assetValue = record(manifest.assets[0], 'release manifest.assets[0]')
  assertExactKeys(assetValue, ['file', 'bytes', 'sha256'], 'release manifest.assets[0]')
  const asset = {
    file: nonEmptyString(assetValue.file, 'release manifest.assets[0].file'),
    bytes: nonNegativeInteger(assetValue.bytes, 'release manifest.assets[0].bytes'),
    sha256: nonEmptyString(assetValue.sha256, 'release manifest.assets[0].sha256'),
  }
  if (asset.file !== desktopUnsignedDmgName(product, version.dsh)) {
    throw new Error('release manifest disk image filename does not match its product and version')
  }
  if (!/^[0-9a-f]{64}$/u.test(asset.sha256)) {
    throw new Error('release manifest.assets[0].sha256 must be a lowercase SHA-256 digest')
  }

  return {
    schemaVersion: 2,
    kind: 'unsigned-developer-preview',
    product,
    version,
    identifier,
    source,
    target,
    distribution,
    assets: [asset],
  }
}

/**
 * Render the warning and installation text used for a manual GitHub release.
 *
 * @param manifest - Verified unsigned distribution manifest.
 * @returns Markdown release notes with the required trust disclosure.
 */
export function renderUnsignedReleaseNotes(manifest: DesktopDmgManifest): string {
  return `# ${manifest.product} ${manifest.version.dsh} (unsigned developer preview)

> [!WARNING]
> The application in this disk image is ad-hoc signed; the disk image itself is unsigned. Neither carries an Apple Developer ID or Apple notarization. This artifact does not authenticate the publisher and has not received Apple's notarization malware check. SHA-256 verifies only the bytes obtained from a source you already trust.

Target: Apple Silicon, macOS ${manifest.target.minimumMacOS} or later. Updates are manual.

Download the DMG, \`SHA256SUMS\`, and \`release-manifest.json\` into one directory, then verify them before opening the image:

\`\`\`sh
shasum -a 256 -c SHA256SUMS
\`\`\`

Drag the application to \`/Applications\`. Gatekeeper is expected to block the first launch. After confirming the source, version, and digest, try to open the application once, then use **System Settings → Privacy & Security → Open Anyway**. Managed Macs may forbid this exception. Do not disable Gatekeeper or remove quarantine attributes. See [Apple's guidance for opening apps safely](https://support.apple.com/en-gb/102445).

The application shares \`$DSH_HOME\` with the CLI. Back up that directory before upgrading; this developer preview does not promise downgrade compatibility.
`
}

function assertReleaseVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`invalid Desktop release version: ${version}`)
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${label} must contain exactly ${keys.join(', ')}`)
  }
}
