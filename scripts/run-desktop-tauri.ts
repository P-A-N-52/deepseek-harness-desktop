/** Run the repository-owned Tauri CLI from the package-less Desktop project. */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const desktopRoot = resolve(repositoryRoot, 'apps/desktop')
const tauriCli = createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js')

const child = spawn(process.execPath, [tauriCli, ...process.argv.slice(2)], {
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
