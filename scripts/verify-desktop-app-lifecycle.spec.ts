import { describe, expect, it } from 'vitest'
import {
  descendantPids,
  parseDesktopLifecycleArgs,
  parseLoopbackPorts,
  parseProcessRows,
  productNameFromTauriConfig,
  requireMacOS,
} from './verify-desktop-app-lifecycle.ts'

describe('verify-desktop-app-lifecycle', () => {
  it('derives a filesystem-safe product name from Tauri configuration', () => {
    expect(productNameFromTauriConfig('{"productName":"DeepSeek Harness Desktop"}')).toBe('DeepSeek Harness Desktop')
    expect(() => productNameFromTauriConfig('{"productName":""}')).toThrow('non-empty productName')
    expect(() => productNameFromTauriConfig('{"productName":"bad/name"}')).toThrow('path separator')
  })

  it('parses the optional app bundle and an explicit lifecycle deadline', () => {
    expect(parseDesktopLifecycleArgs([])).toEqual({ appPath: undefined, timeoutMs: 45_000 })
    expect(parseDesktopLifecycleArgs(['--app', '/tmp/Desktop.app', '--timeout-ms', '12000'])).toEqual({
      appPath: '/tmp/Desktop.app',
      timeoutMs: 12_000,
    })
    expect(() => parseDesktopLifecycleArgs(['--timeout-ms', '0'])).toThrow('positive integer')
  })

  it('refuses a non-macOS acceptance host', () => {
    expect(() => {
      requireMacOS('linux')
    }).toThrow('requires macOS')
    expect(() => {
      requireMacOS('darwin')
    }).not.toThrow()
  })

  it('finds a complete direct sidecar subtree from a process snapshot', () => {
    const rows = parseProcessRows([
      '  100     1 /Applications/DeepSeek Harness Desktop.app/Contents/MacOS/dsh-desktop',
      '  101   100 /Applications/DeepSeek Harness Desktop.app/Contents/MacOS/dsh-desktop-runtime',
      '  102   101 /bin/sh -c helper',
      '  103   102 helper-child',
      'not a process row',
    ].join('\n'))
    expect(descendantPids(100, rows)).toEqual([101, 102, 103])
    expect(descendantPids(101, rows)).toEqual([102, 103])
  })

  it('keeps only positive IPv4 loopback listener ports from lsof fields', () => {
    expect(parseLoopbackPorts([
      'p101',
      'f12',
      'n127.0.0.1:51234',
      'n*:443',
      'n127.0.0.1:0',
      'n127.0.0.1:51234',
      'n[::1]:51235',
    ].join('\n'))).toEqual([51_234])
  })
})
