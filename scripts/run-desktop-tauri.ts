/** Run the repository-owned Tauri CLI from the package-less Desktop project. */

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { isEntry } from './release/process.ts'

const repositoryRoot = resolve(import.meta.dirname, '..')
const desktopRoot = resolve(repositoryRoot, 'apps/desktop')
const tauriCli = createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js')
const cargoLockedRunner = resolve(repositoryRoot, 'scripts/cargo-locked')

/**
 * Add the repository-owned Cargo lockfile runner to Tauri release builds.
 * @param args - Tauri subcommand and arguments supplied by the package script.
 * @param runner - Absolute executable used in place of Cargo.
 * @param platform - Host platform selecting the lock enforcement route.
 * @returns Arguments that preserve development commands and lock every build.
 */
export function desktopTauriArguments(
  args: readonly string[],
  runner = cargoLockedRunner,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (args[0] !== 'build') return [...args]
  if (args.some(arg => arg === '--runner' || arg === '-r' || arg.startsWith('--runner=') || /^-r.+/u.test(arg))) {
    throw new Error('Desktop builds use the repository-owned locked Cargo runner')
  }
  // `scripts/cargo-locked` is a POSIX sh wrapper that cannot execute on
  // Windows; main() enforces the same lockfile guarantee there via a locked
  // cargo metadata resolution before Tauri invokes Cargo.
  if (platform === 'win32') return [...args]
  return ['build', '--runner', runner, ...args.slice(1)]
}

/** Resolve the locked Desktop Cargo graph before a Windows release build. */
function verifyLockedCargo(): void {
  const result = spawnSync('cargo', [
    'metadata',
    '--locked',
    '--manifest-path',
    resolve(repositoryRoot, 'apps/desktop/src-tauri/Cargo.toml'),
  ], {
    cwd: desktopRoot,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`Desktop Cargo lock check failed with exit code ${result.status}`)
  }
}

async function main(): Promise<void> {
  const args = desktopTauriArguments(process.argv.slice(2))
  if (process.platform === 'win32' && args[0] === 'build') verifyLockedCargo()
  const child = spawn(process.execPath, [tauriCli, ...args], {
    cwd: desktopRoot,
    stdio: 'inherit',
  })

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      resolveExit({ code, signal })
    })
  })

  if (result.signal !== null) {
    console.error(`Tauri exited after signal ${result.signal}.`)
    process.exitCode = 1
  } else {
    process.exitCode = result.code ?? 1
  }
}

if (isEntry(import.meta.url)) await main()
