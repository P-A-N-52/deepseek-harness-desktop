/** Run the repository-owned Tauri CLI from the package-less Desktop project. */

import { spawn } from 'node:child_process'
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
 * @returns Arguments that preserve development commands and lock every build.
 */
export function desktopTauriArguments(args: readonly string[], runner = cargoLockedRunner): string[] {
  if (args[0] !== 'build') return [...args]
  if (args.some(arg => arg === '--runner' || arg === '-r' || arg.startsWith('--runner=') || /^-r.+/u.test(arg))) {
    throw new Error('Desktop builds use the repository-owned locked Cargo runner')
  }
  return ['build', '--runner', runner, ...args.slice(1)]
}

async function main(): Promise<void> {
  const child = spawn(process.execPath, [tauriCli, ...desktopTauriArguments(process.argv.slice(2))], {
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
