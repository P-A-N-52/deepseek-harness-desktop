import { describe, expect, it } from 'vitest'
import { desktopVersion } from './desktop-version.ts'

describe('desktopVersion', () => {
  it.each([
    ['0.1.0-alpha.2', { marketingVersion: '0.1.0', bundleVersion: '0.1.102' }],
    ['0.1.0-beta.3', { marketingVersion: '0.1.0', bundleVersion: '0.1.303' }],
    ['0.1.0-preview.4', { marketingVersion: '0.1.0', bundleVersion: '0.1.504' }],
    ['0.1.0-rc.5', { marketingVersion: '0.1.0', bundleVersion: '0.1.705' }],
    ['0.1.0', { marketingVersion: '0.1.0', bundleVersion: '0.1.999' }],
    ['0.1.1-rc.1', { marketingVersion: '0.1.1', bundleVersion: '0.1.1701' }],
  ])('maps %s to monotonic Apple fields', (version, expected) => {
    expect(desktopVersion(version)).toEqual(expected)
  })

  it('rejects prereleases without an ordered Desktop channel', () => {
    expect(() => desktopVersion('0.1.0-nightly.1')).toThrow(/numbered alpha, beta, pre, preview, or rc/)
  })

  it('reserves the stable build above every supported candidate', () => {
    expect(() => desktopVersion('0.1.0-rc.100')).toThrow(/at most 99/)
  })
})
