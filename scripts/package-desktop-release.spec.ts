import { describe, expect, it } from 'vitest'
import { desktopDmgName, desktopReleaseTag } from './package-desktop-release.ts'

describe('Desktop release package naming', () => {
  it('couples the immutable tag to the exact marketing version', () => {
    expect(desktopReleaseTag('0.1.0')).toBe('desktop-v0.1.0')
    expect(desktopReleaseTag('0.1.0-rc.5')).toBe('desktop-v0.1.0-rc.5')
    expect(() => desktopReleaseTag('0.1')).toThrow('invalid Desktop release version')
  })

  it('creates a stable arm64 DMG name from the product display name', () => {
    expect(desktopDmgName('DeepSeek Harness Desktop', '0.1.0')).toBe('DeepSeek-Harness-Desktop_0.1.0_aarch64.dmg')
    expect(desktopDmgName(' DeepSeek  Harness! ', '0.1.0-rc.5')).toBe('DeepSeek-Harness_0.1.0-rc.5_aarch64.dmg')
  })
})
