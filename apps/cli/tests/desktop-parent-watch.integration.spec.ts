import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const tsxLoader = createRequire(import.meta.url).resolve('tsx/esm')
const supervisorFixture = fileURLToPath(new URL('./fixtures/desktop-parent-supervisor.ts', import.meta.url))

interface FixtureReady {
  leafPid: number
  port: number
  sidecarPid: number
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

async function portAcceptsConnection(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => { resolve(false) })
  })
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for Desktop fixture teardown')
    await new Promise((resolve) => { setTimeout(resolve, 25) })
  }
}

async function readReady(child: ChildProcess): Promise<FixtureReady> {
  if (child.stdout === null || child.stderr === null) throw new Error('fixture output is unavailable')
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Desktop fixture did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 10_000)
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      const line = stdout.split('\n').find(candidate => candidate.startsWith('{'))
      if (line === undefined) return
      clearTimeout(timeout)
      resolve(JSON.parse(line) as FixtureReady)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`Desktop fixture exited before ready (code=${String(code)}, signal=${String(signal)})\n${stderr}`))
    })
  })
}

describe.skipIf(process.platform === 'win32')('Desktop parent-loss integration', () => {
  it('kills the sealed process group and closes its port when the native parent is lost', async () => {
    const supervisor = spawn(process.execPath, ['--import', tsxLoader, supervisorFixture], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let ready: FixtureReady | undefined
    try {
      ready = await readReady(supervisor)
      expect(await portAcceptsConnection(ready.port)).toBe(true)

      supervisor.kill('SIGKILL')
      await waitFor(() => !processExists(ready!.sidecarPid) && !processExists(ready!.leafPid))
      await waitFor(async () => !await portAcceptsConnection(ready!.port))
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL')
      if (ready !== undefined && processExists(ready.sidecarPid)) {
        process.kill(-ready.sidecarPid, 'SIGKILL')
      }
      if (ready !== undefined && processExists(ready.leafPid)) process.kill(ready.leafPid, 'SIGKILL')
    }
  }, 15_000)
})
