import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createDesktopParentTermination, watchDesktopParent } from '../../src/desktop-parent-watch.ts'

const leaf = spawn(process.execPath, [
  '-e',
  "process.on('SIGTERM',()=>{});setInterval(()=>{},60_000)",
], { stdio: 'ignore' })
const termination = createDesktopParentTermination(process.pid, true)
watchDesktopParent(process.ppid, undefined, () => { termination.parentLost() })
termination.signal.addEventListener('abort', () => { termination.forceExit(0) }, { once: true })

const server = createServer()
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('fixture did not bind TCP')
console.log(JSON.stringify({ leafPid: leaf.pid, port: address.port, sidecarPid: process.pid }))
