import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { desktopTauriArguments } from './run-desktop-tauri.ts'

const lockedRunner = resolve(import.meta.dirname, 'cargo-locked')

describe('Desktop Tauri launcher', () => {
  it('routes every release build through Cargo --locked on POSIX hosts', () => {
    expect(desktopTauriArguments(['build', '--bundles', 'app'], lockedRunner, 'darwin')).toEqual([
      'build',
      '--runner',
      lockedRunner,
      '--bundles',
      'app',
    ])
  })

  it.skipIf(process.platform === 'win32')('keeps the locked Cargo runner executable', () => {
    expect(readFileSync(lockedRunner, 'utf8')).toBe('#!/bin/sh\nset -eu\n\nexec cargo --locked "$@"\n')
    expect(statSync(lockedRunner).mode & 0o111).not.toBe(0)
  })

  it('keeps Windows release builds runner-free for the locked Cargo metadata check', () => {
    expect(desktopTauriArguments(['build', '--bundles', 'msi'], lockedRunner, 'win32')).toEqual([
      'build',
      '--bundles',
      'msi',
    ])
    expect(() => desktopTauriArguments(['build', '--runner', 'cargo'], lockedRunner, 'win32')).toThrow(
      'repository-owned locked Cargo runner',
    )
  })

  it('leaves development commands alone and rejects a caller-owned build runner', () => {
    expect(desktopTauriArguments(['dev'], lockedRunner, 'darwin')).toEqual(['dev'])
    expect(() => desktopTauriArguments(['build', '--runner', 'cargo'], lockedRunner, 'darwin')).toThrow(
      'repository-owned locked Cargo runner',
    )
    expect(() => desktopTauriArguments(['build', '-r', 'cargo'], lockedRunner, 'darwin')).toThrow(
      'repository-owned locked Cargo runner',
    )
    expect(() => desktopTauriArguments(['build', '--runner=cargo'], lockedRunner, 'darwin')).toThrow(
      'repository-owned locked Cargo runner',
    )
    expect(() => desktopTauriArguments(['build', '-rcargo'], lockedRunner, 'darwin')).toThrow(
      'repository-owned locked Cargo runner',
    )
  })
})
