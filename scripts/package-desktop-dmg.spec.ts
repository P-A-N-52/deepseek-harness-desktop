import { describe, expect, it } from 'vitest'
import {
  desktopUnsignedDmgName,
  desktopUnsignedTag,
  parseDesktopDmgManifest,
  renderDesktopDmgChecksums,
  renderUnsignedReleaseNotes,
} from './desktop-dmg.ts'

const manifest = {
  schemaVersion: 2,
  kind: 'unsigned-developer-preview',
  product: 'DeepSeek Harness Desktop',
  version: { dsh: '0.1.0-rc.5', marketing: '0.1.0', bundle: '0.1.705' },
  identifier: 'io.github.pan52.deepseek-harness-desktop',
  source: { tag: 'desktop-unsigned-v0.1.0-rc.5', commit: 'a'.repeat(40), dirty: false },
  target: { triple: 'aarch64-apple-darwin', architecture: 'arm64', minimumMacOS: '13.5' },
  distribution: {
    applicationSignature: 'ad-hoc',
    hardenedRuntime: true,
    developerId: false,
    notarized: false,
    diskImageSignature: 'none',
    gatekeeperApprovalRequired: true,
    automaticUpdates: false,
  },
  assets: [{
    file: 'DeepSeek-Harness-Desktop_0.1.0-rc.5_aarch64_unsigned.dmg',
    bytes: 42,
    sha256: 'b'.repeat(64),
  }],
} as const

describe('unsigned Desktop DMG metadata', () => {
  it('uses names that disclose the unnotarized distribution status', () => {
    expect(desktopUnsignedTag('0.1.0-rc.5')).toBe('desktop-unsigned-v0.1.0-rc.5')
    expect(desktopUnsignedDmgName('DeepSeek Harness Desktop', '0.1.0-rc.5'))
      .toBe('DeepSeek-Harness-Desktop_0.1.0-rc.5_aarch64_unsigned.dmg')
    expect(() => desktopUnsignedTag('0.1')).toThrow('invalid Desktop release version')
  })

  it('accepts only the exact unsigned manifest schema', () => {
    expect(parseDesktopDmgManifest(manifest)).toEqual(manifest)
    expect(() => parseDesktopDmgManifest({
      ...manifest,
      distribution: { ...manifest.distribution, developerId: true },
    })).toThrow('release manifest.distribution.developerId')
    expect(() => parseDesktopDmgManifest({ ...manifest, teamId: 'TEAM' }))
      .toThrow('release manifest must contain exactly')
  })

  it('renders an explicit trust and Gatekeeper warning for manual publication', () => {
    const notes = renderUnsignedReleaseNotes(parseDesktopDmgManifest(manifest))
    expect(notes).toContain('disk image itself is unsigned')
    expect(notes).toContain('Neither carries an Apple Developer ID or Apple notarization')
    expect(notes).toContain('does not authenticate the publisher')
    expect(notes).toContain('System Settings → Privacy & Security → Open Anyway')
    expect(notes).toContain('Do not disable Gatekeeper or remove quarantine attributes')
    expect(notes).toContain('https://support.apple.com/en-gb/102445')
  })

  it('binds the DMG and manifest into one exact checksum inventory', () => {
    expect(renderDesktopDmgChecksums(manifest.assets[0], 'c'.repeat(64))).toBe(
      `${'b'.repeat(64)}  ${manifest.assets[0].file}\n${'c'.repeat(64)}  release-manifest.json\n`,
    )
    expect(() => renderDesktopDmgChecksums(manifest.assets[0], 'not-a-hash'))
      .toThrow('lowercase SHA-256')
  })
})
