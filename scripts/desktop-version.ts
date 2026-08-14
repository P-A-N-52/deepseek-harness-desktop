/**
 * Keep the Desktop Cargo and Apple bundle versions derived from the dsh
 * release version. Apple accepts numeric bundle versions only, while the dsh
 * family also publishes numbered alpha, beta, and release candidates.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isEntry } from './release/process.ts'

const ROOT_MANIFEST = 'package.json'
const CARGO_MANIFEST = 'apps/desktop/src-tauri/Cargo.toml'
const TAURI_CONFIG = 'apps/desktop/src-tauri/tauri.conf.json'

/** Version fields written into the macOS bundle. */
export interface DesktopVersion {
  /** Numeric user-visible release version. */
  readonly marketingVersion: string
  /** Monotonic numeric build version. */
  readonly bundleVersion: string
}

/**
 * Convert a dsh semver into Apple-compatible bundle fields.
 *
 * The third build component reserves 1,000 values for each patch. Alpha,
 * beta, and release-candidate builds occupy ordered ranges below the stable
 * build at 999, so every supported semver advance also advances the Apple
 * build version.
 *
 * @param version - dsh family version.
 * @returns numeric marketing and build versions.
 */
export function desktopVersion(version: string): DesktopVersion {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  if (match === null) throw new Error(`Desktop version must be semver, got ${version}`)
  const [, major, minor, patchText, prerelease] = match
  const patch = Number(patchText)
  let stage = 999
  if (prerelease !== undefined) {
    const prereleaseMatch = /^(a|alpha|b|beta|c|pre|preview|rc)\.?(\d+)$/.exec(prerelease)
    if (prereleaseMatch === null) {
      throw new Error(
        `Desktop prerelease ${prerelease} must be a numbered alpha, beta, pre, preview, or rc release`,
      )
    }
    const number = Number(prereleaseMatch[2])
    if (number > 99) throw new Error(`Desktop prerelease number must be at most 99, got ${String(number)}`)
    const channel = prereleaseMatch[1]
    const offset = channel === 'a' || channel === 'alpha'
      ? 100
      : channel === 'b' || channel === 'beta'
        ? 300
        : channel === 'pre' || channel === 'preview'
          ? 500
          : 700
    stage = offset + number
  }
  return {
    marketingVersion: `${major}.${minor}.${patchText}`,
    bundleVersion: `${major}.${minor}.${String(patch * 1_000 + stage)}`,
  }
}

/**
 * Assert the root, Cargo, and Tauri version fields describe one release.
 * @param root - repository root.
 * @param expectedVersion - shared dsh version expected at every source.
 */
export function verifyDesktopVersion(root: string, expectedVersion: string): void {
  const rootManifest = JSON.parse(readFileSync(join(root, ROOT_MANIFEST), 'utf8')) as { version?: unknown }
  if (rootManifest.version !== expectedVersion) {
    throw new Error(`${ROOT_MANIFEST}: expected version ${expectedVersion}, got ${String(rootManifest.version)}`)
  }

  const cargo = readFileSync(join(root, CARGO_MANIFEST), 'utf8')
  if (!cargo.includes(`\nversion = "${expectedVersion}"\n`)) {
    throw new Error(`${CARGO_MANIFEST}: expected package version ${expectedVersion}`)
  }

  const expected = desktopVersion(expectedVersion)
  const tauri = JSON.parse(readFileSync(join(root, TAURI_CONFIG), 'utf8')) as {
    version?: unknown
    bundle?: { macOS?: { bundleVersion?: unknown } }
  }
  if (tauri.version !== expected.marketingVersion) {
    throw new Error(`${TAURI_CONFIG}: expected version ${expected.marketingVersion}, got ${String(tauri.version)}`)
  }
  if (tauri.bundle?.macOS?.bundleVersion !== expected.bundleVersion) {
    throw new Error(
      `${TAURI_CONFIG}: expected bundle.macOS.bundleVersion ${expected.bundleVersion}, got ${String(tauri.bundle?.macOS?.bundleVersion)}`,
    )
  }
}

/**
 * Rewrite Desktop-owned version fields during a dsh family version bump.
 * @param root - repository root.
 * @param from - current shared dsh version.
 * @param to - target shared dsh version.
 */
export function writeDesktopVersion(root: string, from: string, to: string): void {
  const current = desktopVersion(from)
  const next = desktopVersion(to)

  const cargoPath = join(root, CARGO_MANIFEST)
  const cargo = readFileSync(cargoPath, 'utf8')
  const cargoLine = `\nversion = "${from}"\n`
  if (!cargo.includes(cargoLine)) throw new Error(`${CARGO_MANIFEST}: cannot locate package version ${from}`)
  writeFileSync(cargoPath, cargo.replace(cargoLine, `\nversion = "${to}"\n`))

  const tauriPath = join(root, TAURI_CONFIG)
  const tauri = readFileSync(tauriPath, 'utf8')
  const versionLine = `  "version": "${current.marketingVersion}",`
  const bundleLine = `      "bundleVersion": "${current.bundleVersion}",`
  if (!tauri.includes(versionLine)) throw new Error(`${TAURI_CONFIG}: cannot locate ${versionLine.trim()}`)
  if (!tauri.includes(bundleLine)) throw new Error(`${TAURI_CONFIG}: cannot locate ${bundleLine.trim()}`)
  writeFileSync(
    tauriPath,
    tauri
      .replace(versionLine, `  "version": "${next.marketingVersion}",`)
      .replace(bundleLine, `      "bundleVersion": "${next.bundleVersion}",`),
  )
}

function main(): void {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), ROOT_MANIFEST), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error(`${ROOT_MANIFEST}: version must be a string`)
  verifyDesktopVersion(process.cwd(), manifest.version)
  const resolved = desktopVersion(manifest.version)
  console.log(
    `desktop version: dsh ${manifest.version}, marketing ${resolved.marketingVersion}, bundle ${resolved.bundleVersion}`,
  )
}

if (isEntry(import.meta.url)) main()
