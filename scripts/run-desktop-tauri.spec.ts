import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { desktopTauriArguments } from './run-desktop-tauri.ts'

const lockedRunner = resolve(import.meta.dirname, 'cargo-locked')

describe('Desktop Tauri launcher', () => {
  it('routes every release build through Cargo --locked', () => {
    expect(desktopTauriArguments(['build', '--bundles', 'app'], lockedRunner)).toEqual([
      'build',
      '--runner',
      lockedRunner,
      '--bundles',
      'app',
    ])
    expect(readFileSync(lockedRunner, 'utf8')).toBe('#!/bin/sh\nset -eu\n\nexec cargo --locked "$@"\n')
    expect(statSync(lockedRunner).mode & 0o111).not.toBe(0)
  })

  it('leaves development commands alone and rejects a caller-owned build runner', () => {
    expect(desktopTauriArguments(['dev'], lockedRunner)).toEqual(['dev'])
    expect(() => desktopTauriArguments(['build', '--runner', 'cargo'], lockedRunner)).toThrow(
      'repository-owned locked Cargo runner',
    )
    expect(() => desktopTauriArguments(['build', '-r', 'cargo'], lockedRunner)).toThrow(
      'repository-owned locked Cargo runner',
    )
    expect(() => desktopTauriArguments(['build', '--runner=cargo'], lockedRunner)).toThrow(
      'repository-owned locked Cargo runner',
    )
    expect(() => desktopTauriArguments(['build', '-rcargo'], lockedRunner)).toThrow(
      'repository-owned locked Cargo runner',
    )
  })
})
