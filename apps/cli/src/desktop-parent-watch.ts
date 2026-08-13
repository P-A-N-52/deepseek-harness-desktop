/**
 * Watch the native Desktop supervisor that owns this sealed sidecar.
 *
 * @module @deepseek-ai/dsh/desktop-parent-watch
 */

const PARENT_POLL_INTERVAL_MS = 250
const OWN_PROCESS_GROUP = 'DSH_DESKTOP_OWN_PROCESS_GROUP'

/** Shutdown bridge for one sealed runtime directly owned by the native host. */
export interface DesktopParentTermination {
  /** Aborted exactly once when the recorded native parent disappears. */
  readonly signal: AbortSignal
  /** Record parent loss and start application disposal. */
  parentLost(): void
  /** Exit after disposal, force-killing the dedicated process group on parent loss. */
  forceExit(code: number): void
}

/**
 * Create the parent-loss shutdown bridge for the sealed Desktop process.
 *
 * @param processId Sidecar process id, also its dedicated group id under Tauri.
 * @param ownsProcessGroup Whether the native host created that dedicated group.
 * @param kill Signal sender.
 * @param exit Ordinary process exit.
 * @returns A bridge shared by the parent watchdog and profile shutdown.
 */
export function createDesktopParentTermination(
  processId: number = process.pid,
  ownsProcessGroup: boolean = process.env[OWN_PROCESS_GROUP] === '1',
  kill: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => { process.kill(pid, signal) },
  exit: (code: number) => void = (code) => { process.exit(code) },
): DesktopParentTermination {
  const parentLoss = new AbortController()
  return {
    signal: parentLoss.signal,
    parentLost() {
      parentLoss.abort()
    },
    forceExit(code) {
      if (parentLoss.signal.aborted && ownsProcessGroup) {
        try {
          kill(-processId, 'SIGKILL')
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
        }
      }
      exit(code)
    },
  }
}

/**
 * Terminate the sealed sidecar if its native supervisor disappears.
 *
 * @param expectedParentPid Parent process recorded before runtime startup.
 * @param readParentPid Current parent-process reader.
 * @param terminate Sidecar termination action.
 * @returns A disposer for the unreferenced watchdog timer.
 */
export function watchDesktopParent(
  expectedParentPid: number,
  readParentPid: () => number = () => process.ppid,
  terminate: () => void = () => { process.kill(process.pid, 'SIGTERM') },
): () => void {
  let parentLost = false
  const timer = setInterval(() => {
    if (parentLost || readParentPid() === expectedParentPid) return
    parentLost = true
    clearInterval(timer)
    terminate()
  }, PARENT_POLL_INTERVAL_MS)
  timer.unref()
  return () => { clearInterval(timer) }
}
