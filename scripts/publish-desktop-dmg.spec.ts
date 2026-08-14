import { describe, expect, it } from 'vitest'
import { assertReleaseAssets, isGitHubNotFound } from './publish-desktop-dmg.ts'

const assets = [
  'DeepSeek-Harness-Desktop_0.1.0-rc.5_aarch64_unsigned.dmg',
  'SHA256SUMS',
  'release-manifest.json',
] as const

describe('manual Desktop DMG publication', () => {
  it('reuses only the exact same-tag draft asset inventory', () => {
    const release = {
      draft: true,
      tagName: 'desktop-unsigned-v0.1.0-rc.5',
      assets: [...assets].reverse(),
    }
    expect(() => {
      assertReleaseAssets(release, 'desktop-unsigned-v0.1.0-rc.5', assets, true)
    }).not.toThrow()
    expect(() => {
      assertReleaseAssets({ ...release, draft: false }, 'desktop-unsigned-v0.1.0-rc.5', assets, true)
    }).toThrow('draft state')
    expect(() => {
      assertReleaseAssets({ ...release, assets: [...release.assets, 'unexpected'] }, release.tagName, assets, true)
    }).toThrow('assets must be exactly')
  })

  it('accepts the same inventory only after the final release is no longer a draft', () => {
    expect(() => {
      assertReleaseAssets({ draft: false, tagName: 'desktop-unsigned-v0.1.0', assets }, 'desktop-unsigned-v0.1.0', assets, false)
    }).not.toThrow()
  })

  it('treats only gh\'s exact missing-release diagnostic as absence', () => {
    expect(isGitHubNotFound('gh: Not Found (HTTP 404)\n')).toBe(true)
    expect(isGitHubNotFound('{"status":"404"}\n')).toBe(false)
    expect(isGitHubNotFound('gh: HTTP 401: Bad credentials\n')).toBe(false)
  })
})
