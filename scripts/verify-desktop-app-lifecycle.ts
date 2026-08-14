/**
 * Validates that a packaged macOS Desktop app owns, serves through, and tears
 * down its sealed loopback runtime across a restart.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { isEntry } from './release/process.ts'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const desktopTauriConfig = join(repoRoot, 'apps/desktop/src-tauri/tauri.conf.json')
const desktopBundleDirectory = join(repoRoot, 'apps/desktop/src-tauri/target/release/bundle/macos')
const sidecarExecutableName = 'dsh-desktop-runtime'
const defaultTimeoutMs = 45_000

/** Command-line options for the packaged Desktop lifecycle acceptance. */
export interface DesktopLifecycleOptions {
  /** Optional path to the built `.app` bundle. */
  readonly appPath: string | undefined
  /** Per-launch and teardown deadline. */
  readonly timeoutMs: number
}

/** A process record from `ps`. */
export interface ProcessRow {
  /** Process id. */
  readonly pid: number
  /** Parent process id. */
  readonly parentPid: number
  /** Command text reported by `ps`. */
  readonly command: string
}

interface BundlePaths {
  readonly app: string
  readonly executable: string
  readonly sidecar: string
}

interface LaunchedDesktop {
  readonly app: ChildProcess
  readonly appPid: number
  readonly port: number
  readonly sidecarTree: readonly number[]
}

interface CommandResult {
  readonly status: number | null
  readonly stderr: string
  readonly stdout: string
}

/**
 * Reads the product name used to derive Tauri's release `.app` bundle path.
 * @param source - contents of `tauri.conf.json`.
 * @returns A filesystem-safe product name.
 */
export function productNameFromTauriConfig(source: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new Error('Desktop Tauri configuration is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Desktop Tauri configuration must be an object')
  }
  const productName = (parsed as Record<string, unknown>).productName
  if (typeof productName !== 'string' || productName.trim().length === 0) {
    throw new Error('Desktop Tauri configuration must define a non-empty productName')
  }
  if (productName.includes('/') || productName.includes('\\') || productName.includes('\0')) {
    throw new Error('Desktop Tauri productName must not contain a path separator')
  }
  return productName
}

/**
 * Parses options for the lifecycle command.
 * @param args - arguments after the script path.
 * @returns Parsed app path and deadline.
 */
export function parseDesktopLifecycleArgs(args: readonly string[]): DesktopLifecycleOptions {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: false,
    options: {
      app: { type: 'string' },
      'timeout-ms': { type: 'string' },
    },
    strict: true,
  })
  const rawTimeout = parsed.values['timeout-ms']
  if (rawTimeout === undefined) return { appPath: parsed.values.app, timeoutMs: defaultTimeoutMs }
  if (!/^[1-9]\d*$/u.test(rawTimeout)) {
    throw new Error('--timeout-ms must be a positive integer')
  }
  const timeoutMs = Number(rawTimeout)
  if (!Number.isSafeInteger(timeoutMs)) throw new Error('--timeout-ms must be a safe integer')
  return { appPath: parsed.values.app, timeoutMs }
}

/**
 * Refuses to perform a macOS app acceptance on any other host platform.
 * @param platform - host platform, injectable for unit tests.
 */
export function requireMacOS(platform = process.platform): void {
  if (platform !== 'darwin') {
    throw new Error(`verify-desktop-app-lifecycle requires macOS, received ${platform}`)
  }
}

/**
 * Parses the process fields emitted by `ps -axo pid=,ppid=,command=`.
 * @param output - process table text.
 * @returns Valid process records in source order.
 */
export function parseProcessRows(output: string): readonly ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u)
    if (match === null) continue
    const pid = Number(match[1])
    const parentPid = Number(match[2])
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0) continue
    const command = match[3]
    if (command === undefined) continue
    rows.push({ command, parentPid, pid })
  }
  return rows
}

/**
 * Finds every descendant of a process from one process-table snapshot.
 * @param rootPid - root process id, excluded from the result.
 * @param rows - process table records.
 * @returns Descendant ids in parent-before-child order.
 */
export function descendantPids(rootPid: number, rows: readonly ProcessRow[]): readonly number[] {
  const children = new Map<number, number[]>()
  for (const row of rows) {
    const current = children.get(row.parentPid)
    if (current === undefined) children.set(row.parentPid, [row.pid])
    else current.push(row.pid)
  }
  const result: number[] = []
  const seen = new Set([rootPid])
  const pending = [rootPid]
  while (pending.length > 0) {
    const parent = pending.pop()
    if (parent === undefined) break
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      result.push(child)
      pending.push(child)
    }
  }
  return result
}

/**
 * Extracts loopback listening ports from `lsof -Fn` output.
 * @param output - field-mode lsof output.
 * @returns Distinct positive IPv4 loopback ports.
 */
export function parseLoopbackPorts(output: string): readonly number[] {
  const ports = new Set<number>()
  for (const line of output.split('\n')) {
    const match = line.match(/^n127\.0\.0\.1:(\d+)$/u)
    if (match === null) continue
    const port = Number(match[1])
    if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) ports.add(port)
  }
  return [...ports]
}

async function capture(command: string, args: readonly string[]): Promise<CommandResult> {
  const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  return await new Promise<CommandResult>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (status) => { resolve({ status, stderr, stdout }) })
  })
}

function validateExecutableName(name: string): string {
  if (name.length === 0 || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('Desktop bundle CFBundleExecutable is invalid')
  }
  return name
}

async function readBundleExecutable(infoPlist: string): Promise<string> {
  const result = await capture('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', infoPlist])
  if (result.status !== 0) {
    throw new Error(`Could not read CFBundleExecutable from ${infoPlist}: ${result.stderr.trim()}`)
  }
  return validateExecutableName(result.stdout.trim())
}

async function defaultBundlePath(): Promise<string> {
  const config = await readFile(desktopTauriConfig, 'utf8')
  const productName = productNameFromTauriConfig(config)
  return join(desktopBundleDirectory, `${productName}.app`)
}

async function resolveBundlePaths(requestedApp: string | undefined): Promise<BundlePaths> {
  const app = await realpath(requestedApp ?? await defaultBundlePath())
  if (!app.endsWith('.app')) throw new Error(`Desktop app path must end in .app: ${app}`)
  const contents = join(app, 'Contents')
  const executableName = await readBundleExecutable(join(contents, 'Info.plist'))
  const executable = join(contents, 'MacOS', executableName)
  const sidecar = join(contents, 'MacOS', sidecarExecutableName)
  await Promise.all([
    access(executable, constants.X_OK),
    access(sidecar, constants.X_OK),
  ])
  return { app, executable, sidecar }
}

async function readProcessRows(): Promise<readonly ProcessRow[]> {
  const result = await capture('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,command='])
  if (result.status !== 0) throw new Error(`ps failed: ${result.stderr.trim()}`)
  return parseProcessRows(result.stdout)
}

async function readLoopbackPorts(pid: number): Promise<readonly number[]> {
  const result = await capture('/usr/sbin/lsof', [
    '-nP',
    '-a',
    '-p',
    String(pid),
    '-iTCP',
    '-sTCP:LISTEN',
    '-Fn',
  ])
  if (result.status === 1) return []
  if (result.status !== 0) throw new Error(`lsof failed for sidecar ${String(pid)}: ${result.stderr.trim()}`)
  return parseLoopbackPorts(result.stdout)
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

async function fetchRuntimePage(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/`, { signal: AbortSignal.timeout(1_000) })
    return response.ok && response.headers.get('content-type')?.includes('text/html') === true
  } catch {
    return false
  }
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, durationMs) })
}

async function waitForValue<T>(label: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(100)
  }
}

function runsExecutable(command: string, executable: string): boolean {
  return command === executable || command.startsWith(`${executable} `)
}

async function launchApp(executable: string, home: string): Promise<ChildProcess> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DEEPSEEK_API_KEY: 'dsh-desktop-lifecycle-dummy-key',
    DSH_AGENTS_HOME: join(home, 'agents'),
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
  }
  delete environment.DEEPSEEK_BASE_URL
  const child = spawn(executable, [], { cwd: home, env: environment, stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  return child
}

async function observeDesktop(app: ChildProcess, sidecarPath: string): Promise<LaunchedDesktop | undefined> {
  const appPid = app.pid
  if (appPid === undefined || !processExists(appPid)) {
    throw new Error('Desktop app exited before its runtime became ready')
  }
  const rows = await readProcessRows()
  const sidecar = rows.find(row => row.parentPid === appPid && runsExecutable(row.command, sidecarPath))
  if (sidecar === undefined) return undefined
  const ports = await readLoopbackPorts(sidecar.pid)
  if (ports.length !== 1) return undefined
  const [port] = ports
  if (port === undefined) return undefined
  if (!await fetchRuntimePage(port)) return undefined
  return {
    app,
    appPid,
    port,
    sidecarTree: [sidecar.pid, ...descendantPids(sidecar.pid, rows)],
  }
}

async function launchAndObserve(paths: BundlePaths, home: string, timeoutMs: number): Promise<LaunchedDesktop> {
  const app = await launchApp(paths.executable, home)
  try {
    return await waitForValue('Desktop app, direct sidecar, and loopback page', timeoutMs, async () => {
      return await observeDesktop(app, paths.sidecar)
    })
  } catch (error) {
    const appPid = app.pid
    const rows = appPid === undefined ? [] : await readProcessRows()
    const sidecar = appPid === undefined
      ? undefined
      : rows.find(row => row.parentPid === appPid && runsExecutable(row.command, paths.sidecar))
    if (app.exitCode === null && app.signalCode === null) app.kill('SIGTERM')
    await sleep(500)
    if (sidecar !== undefined) {
      for (const pid of [sidecar.pid, ...descendantPids(sidecar.pid, rows)].reverse()) {
        if (processExists(pid)) process.kill(pid, 'SIGKILL')
      }
    }
    if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL')
    throw error
  }
}

async function waitForExit(app: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (app.exitCode !== null || app.signalCode !== null) return { code: app.exitCode, signal: app.signalCode }
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error('Timed out waiting for Desktop app exit')) }, timeoutMs)
    app.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    app.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal })
    })
  })
}

async function stopAndVerify(desktop: LaunchedDesktop, timeoutMs: number): Promise<void> {
  const exiting = waitForExit(desktop.app, timeoutMs)
  if (desktop.app.exitCode === null && desktop.app.signalCode === null) desktop.app.kill('SIGTERM')
  const outcome = await exiting
  if (outcome.code !== 0 || outcome.signal !== null) {
    throw new Error(`Desktop app did not exit normally (code ${String(outcome.code)}, signal ${String(outcome.signal)})`)
  }
  await waitForValue('sidecar tree and loopback port teardown', timeoutMs, async () => {
    const processTreeGone = desktop.sidecarTree.every(pid => !processExists(pid))
    const portClosed = !await portAcceptsConnection(desktop.port)
    return processTreeGone && portClosed ? true : undefined
  })
}

async function forceStop(desktop: LaunchedDesktop): Promise<void> {
  if (desktop.app.exitCode === null && desktop.app.signalCode === null) desktop.app.kill('SIGTERM')
  await sleep(500)
  for (const pid of [...desktop.sidecarTree].reverse()) {
    if (processExists(pid)) process.kill(pid, 'SIGKILL')
  }
  if (desktop.app.exitCode === null && desktop.app.signalCode === null) desktop.app.kill('SIGKILL')
}

function usage(): string {
  return 'Usage: pnpm tsx scripts/verify-desktop-app-lifecycle.ts [--app /path/to/Desktop.app] [--timeout-ms 45000]'
}

async function main(): Promise<void> {
  requireMacOS()
  if (process.argv.includes('--help')) {
    console.log(usage())
    return
  }
  const options = parseDesktopLifecycleArgs(process.argv.slice(2))
  const paths = await resolveBundlePaths(options.appPath)
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-app-lifecycle-'))
  const home = join(root, 'home')
  let active: LaunchedDesktop | undefined
  try {
    await mkdir(home)
    active = await launchAndObserve(paths, home, options.timeoutMs)
    await stopAndVerify(active, options.timeoutMs)
    active = undefined
    active = await launchAndObserve(paths, home, options.timeoutMs)
    await stopAndVerify(active, options.timeoutMs)
    active = undefined
    console.log(`Desktop app lifecycle passed: ${paths.app}`)
  } finally {
    if (active !== undefined) await forceStop(active)
    await rm(root, { force: true, recursive: true })
  }
}

if (isEntry(import.meta.url)) await main()
