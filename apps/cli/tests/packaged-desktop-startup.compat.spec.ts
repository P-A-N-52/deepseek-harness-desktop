/**
 * Keyless HTTP smoke for the closed Desktop Web entry and its final SEA.
 * Ordinary inventory skips it; Desktop artifact validation opts in after the
 * repository build and may replace the built JS entry with the packaged bin.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const sourceLauncher = join(repoRoot, 'apps/cli/src/bin.ts')
const tsxLoader = createRequire(import.meta.url).resolve('tsx/esm')
const packagedRuntime = process.env.DSH_DESKTOP_RUNTIME_BIN
const requireDesktopRuntime = process.env.DSH_REQUIRE_DESKTOP_RUNTIME_SMOKE === '1'

interface RuntimeResult {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
  stdout: string
}

interface BootManifest {
  entries: Array<{ id: string }>
}

/** Read the host-injected client graph from the served index. */
function parseBootManifest(html: string): BootManifest {
  const match = /<script>window\.__DSH_BOOT__ = (\{[^<]+\})<\/script>/u.exec(html)
  if (match?.[1] === undefined) throw new Error('Desktop index omitted window.__DSH_BOOT__')
  return JSON.parse(match[1]) as BootManifest
}

/** Launch one runtime, wait for its exact loopback URL, fetch `/`, then terminate it. */
async function runRuntime(cwd: string): Promise<{ responseBody: string; responseStatus: number; result: RuntimeResult; url: string }> {
  const command = packagedRuntime ?? process.execPath
  const args = packagedRuntime === undefined
    ? ['--import', tsxLoader, sourceLauncher, 'web', '--host', '127.0.0.1', '--port', '0']
    : []
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEEPSEEK_API_KEY: 'dsh-desktop-smoke-dummy-key',
    DSH_AGENTS_HOME: join(cwd, '.agents'),
    DSH_HOME: join(cwd, '.dsh'),
  }
  delete env.DEEPSEEK_BASE_URL
  delete env.NODE_OPTIONS
  delete env.NODE_NO_WARNINGS

  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })

  let timeout: NodeJS.Timeout | undefined
  try {
    const url = await new Promise<string>((resolveReady, rejectReady) => {
      const detectReady = (): void => {
        const match = /^dsh web: (http:\/\/127\.0\.0\.1:\d+)$/mu.exec(stdout)
        if (match?.[1] !== undefined) resolveReady(match[1])
      }
      child.stdout.on('data', detectReady)
      child.once('error', rejectReady)
      child.once('exit', (code, signal) => {
        rejectReady(new Error(`Desktop runtime exited before ready (code=${String(code)}, signal=${String(signal)}).\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      })
      timeout = setTimeout(() => {
        rejectReady(new Error(`Desktop runtime did not become ready within 60s.\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      }, 60_000)
    })
    if (timeout !== undefined) clearTimeout(timeout)

    const response = await fetch(`${url}/`, { redirect: 'manual' })
    const responseBody = await response.text()
    child.kill('SIGTERM')
    const result = await new Promise<RuntimeResult>((resolveExit, rejectExit) => {
      const exitTimeout = setTimeout(() => {
        child.kill('SIGKILL')
        rejectExit(new Error(`Desktop runtime did not dispose within 15s.\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      }, 15_000)
      child.once('error', (error) => {
        clearTimeout(exitTimeout)
        rejectExit(error)
      })
      child.once('close', (code, signal) => {
        clearTimeout(exitTimeout)
        resolveExit({ code, signal, stdout, stderr })
      })
    })
    return { responseBody, responseStatus: response.status, result, url }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

describe.skipIf(!requireDesktopRuntime)('packaged Desktop runtime startup', () => {
  it('serves the shipped Web UI on one ephemeral IPv4 loopback origin and disposes', async () => {
    const expectedArtifact = packagedRuntime ?? sourceLauncher
    expect(existsSync(expectedArtifact), `missing Desktop runtime ${expectedArtifact}`).toBe(true)
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-desktop-runtime-'))
    try {
      const smoke = await runRuntime(cwd)
      expect(smoke.url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/u)
      expect(smoke.responseStatus).toBe(200)
      expect(smoke.responseBody).toContain('<div id="root"></div>')
      const clientIds = parseBootManifest(smoke.responseBody).entries.map(entry => entry.id)
      expect(clientIds).toContain('@deepseek-ai/dsh-client-runtime')
      expect(clientIds).toContain('@deepseek-ai/dsh-client-ui-layout')
      expect(smoke.result).toMatchObject({ code: 0, signal: null })
      expect(smoke.result.stderr).not.toContain('ExperimentalWarning')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 80_000)
})
