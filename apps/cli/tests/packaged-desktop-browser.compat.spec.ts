/**
 * Exercises the sealed Desktop runtime through its actual browser surface.
 *
 * This suite deliberately starts the packaged SEA directly. The native Tauri
 * lifecycle is covered separately because a browser cannot own its WebView.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const webPackageRequire = createRequire(join(repoRoot, 'apps/web/package.json'))
interface Locator {
  click(): Promise<void>
  count(): Promise<number>
  fill(value: string): Promise<void>
  getByRole(role: string, options?: { exact?: boolean; name?: string }): Locator
  press(key: string): Promise<void>
  waitFor(options?: { state?: 'hidden'; timeout?: number }): Promise<void>
}

interface BrowserConsoleMessage {
  text(): string
  type(): string
}

interface BrowserPage {
  getByRole(role: string, options?: { exact?: boolean; name?: string }): Locator
  getByText(text: string, options?: { exact?: boolean }): Locator
  goto(url: string, options?: { waitUntil?: 'load' }): Promise<unknown>
  locator(selector: string): Locator
  on(event: 'console', listener: (message: BrowserConsoleMessage) => void): void
  on(event: 'pageerror', listener: (error: Error) => void): void
}

interface Browser {
  close(): Promise<void>
  newPage(options: { locale: string; viewport: { height: number; width: number } }): Promise<BrowserPage>
}

interface BrowserLauncher {
  launch(): Promise<Browser>
}

// Playwright is owned by the existing Web test package; anchor resolution at
// that manifest so the release smoke also works with an isolated pnpm layout.
const { chromium } = webPackageRequire('playwright') as { chromium: BrowserLauncher }
const runtimePath = process.env.DSH_DESKTOP_RUNTIME_BIN
const enabled = process.env.DSH_REQUIRE_DESKTOP_RUNTIME_BROWSER_SMOKE === '1'
const startupTimeoutMs = 60_000

interface RuntimeServer {
  child: ChildProcess
  url: string
}

/** Starts the sealed runtime and resolves its loopback readiness URL. */
async function startRuntime(runtime: string, home: string): Promise<RuntimeServer> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_AGENTS_HOME: join(home, 'agents'),
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
  }
  delete environment.DEEPSEEK_API_KEY
  delete environment.DEEPSEEK_BASE_URL

  const child = spawn(runtime, [], {
    cwd: home,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''

  const appendOutput = (chunk: Buffer): void => {
    output = `${output}${chunk.toString()}`.slice(-16_384)
  }

  child.stdout.on('data', appendOutput)
  child.stderr.on('data', appendOutput)

  return await new Promise<RuntimeServer>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Desktop runtime did not report readiness within ${startupTimeoutMs}ms: ${output}`))
    }, startupTimeoutMs)

    const inspectOutput = (): void => {
      const match = output.match(/^dsh web: (http:\/\/127\.0\.0\.1:\d+)$/mu)
      const url = match?.[1]
      if (url === undefined) return
      clearTimeout(timeout)
      resolve({ child, url })
    }

    child.stdout.on('data', inspectOutput)
    child.stderr.on('data', inspectOutput)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`Desktop runtime exited before readiness (code ${String(code)}, signal ${String(signal)}): ${output}`))
    })
  })
}

/** Terminates a directly started SEA without leaving a release smoke process behind. */
async function stopRuntime(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return

  const stopped = new Promise<void>((resolve) => {
    child.once('exit', () => { resolve() })
  })
  child.kill('SIGTERM')
  await Promise.race([
    stopped,
    new Promise<void>(resolve => setTimeout(resolve, 15_000)),
  ])

  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await stopped
  }
}

describe.skipIf(!enabled)('sealed Desktop runtime browser compatibility', () => {
  let browser: Browser | undefined
  let page: BrowserPage | undefined
  let server: RuntimeServer | undefined
  let root: string | undefined
  const consoleMessages: string[] = []
  const pageErrors: string[] = []

  beforeAll(async () => {
    if (runtimePath === undefined || runtimePath.length === 0) {
      throw new Error('DSH_DESKTOP_RUNTIME_BIN is required when DSH_REQUIRE_DESKTOP_RUNTIME_BROWSER_SMOKE=1')
    }
    await access(runtimePath)

    root = await mkdtemp(join(tmpdir(), 'dsh-desktop-browser-'))
    const home = join(root, 'home')
    await mkdir(home)
    await mkdir(join(root, 'workspace'))
    server = await startRuntime(runtimePath, home)
    browser = await chromium.launch()
    page = await browser.newPage({ locale: 'en-US', viewport: { height: 1_000, width: 1_680 } })
    page.on('console', message => consoleMessages.push(`${message.type()}: ${message.text()}`))
    page.on('pageerror', error => pageErrors.push(String(error)))
  })

  afterAll(async () => {
    if (browser !== undefined) await browser.close()
    if (server !== undefined) await stopRuntime(server.child)
    if (root !== undefined) await rm(root, { force: true, recursive: true })
  })

  it('boots, defers key configuration, and adds a workspace through the browse surface', async () => {
    if (page === undefined || server === undefined || root === undefined) {
      throw new Error('Desktop browser test setup did not complete')
    }

    await page.goto(server.url, { waitUntil: 'load' })
    await page.locator('[class*="frame"]').waitFor({ timeout: 30_000 })
    expect(await page.getByText('Failed to load plugins', { exact: true }).count()).toBe(0)

    const welcomeDialog = page.getByRole('dialog', { name: 'Internal Testing Notice' })
    await welcomeDialog.getByRole('button', { name: 'Continue' }).click()
    const keyDialog = page.getByRole('dialog', { name: 'Add an API key to get started' })
    await keyDialog.getByRole('button', { name: 'Configure later' }).click()
    await keyDialog.waitFor({ state: 'hidden' })

    await page.getByRole('button', { name: 'Add workspace' }).click()
    const directoryDialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await directoryDialog.getByRole('button', { name: 'Edit path' }).click()
    const workspace = join(root, 'workspace')
    const pathInput = directoryDialog.getByRole('textbox', { name: 'Edit path' })
    await pathInput.fill(workspace)
    await pathInput.press('Enter')
    await directoryDialog.getByRole('button', { name: 'Open', exact: true }).click()
    await directoryDialog.waitFor({ state: 'hidden' })
    await page.getByRole('treeitem', { name: 'workspace' }).waitFor({ timeout: 30_000 })

    expect(await page.getByText('Failed to load plugins', { exact: true }).count()).toBe(0)
    expect(consoleMessages.join('\n')).not.toMatch(/Failed to load plugins|web boot:.*(?:did not activate|waiting for services)/iu)
    expect(pageErrors).toEqual([])
  })
})
