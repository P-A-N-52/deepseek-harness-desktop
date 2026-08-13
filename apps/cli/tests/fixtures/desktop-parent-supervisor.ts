import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const tsxLoader = createRequire(import.meta.url).resolve('tsx/esm')
const sidecar = fileURLToPath(new URL('./desktop-parent-sidecar.ts', import.meta.url))
const child = spawn(process.execPath, ['--import', tsxLoader, sidecar], {
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
setInterval(() => {}, 60_000)
