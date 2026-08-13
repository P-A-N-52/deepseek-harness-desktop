import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesktopParentTermination, watchDesktopParent } from '../src/desktop-parent-watch.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('Desktop parent watchdog', () => {
  it('keeps the sidecar alive while its supervisor is unchanged', async () => {
    vi.useFakeTimers()
    const terminate = vi.fn()
    const dispose = watchDesktopParent(41, () => 41, terminate)

    await vi.advanceTimersByTimeAsync(1_000)

    expect(terminate).not.toHaveBeenCalled()
    dispose()
  })

  it('terminates once when the supervisor disappears', async () => {
    vi.useFakeTimers()
    let currentParent = 41
    const terminate = vi.fn()
    watchDesktopParent(41, () => currentParent, terminate)

    currentParent = 1
    await vi.advanceTimersByTimeAsync(1_000)

    expect(terminate).toHaveBeenCalledOnce()
  })

  it('forces only the dedicated process group after parent loss', () => {
    const kill = vi.fn()
    const exit = vi.fn()
    const termination = createDesktopParentTermination(42, true, kill, exit)

    termination.forceExit(0)
    expect(kill).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(0)

    termination.parentLost()
    termination.forceExit(7)
    expect(kill).toHaveBeenCalledWith(-42, 'SIGKILL')
    expect(exit).toHaveBeenLastCalledWith(7)
  })
})
