import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  defaultConcurrency,
  formatGateResultReason,
  gatesForMode,
  runGate,
  runGates,
  stopsOnRequiredFailure,
  type Gate,
  type GateResult,
} from './run-gates.ts'
import { SNAPSHOT_TEST_INCLUDES, WEB_SNAPSHOT_TEST_INCLUDES } from './snapshot-inventories.ts'

function gate(id: string, options: Partial<Gate> = {}): Gate {
  return {
    id,
    label: id,
    displayCommand: `run ${id}`,
    command: process.execPath,
    args: ['-e', ''],
    ...options,
  }
}

function resultFor(subject: Gate, status: GateResult['status'] = 'passed'): GateResult {
  return {
    gate: subject,
    status,
    durationMs: 10,
    output: [],
    exitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : null,
    signalCode: null,
  }
}

function withPnpmEntrypoint<T>(action: () => T): T {
  const previous = process.env.npm_execpath
  process.env.npm_execpath = '/private/pnpm.cjs'
  try {
    return action()
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'npm_execpath')
    else process.env.npm_execpath = previous
  }
}

function withEnv<T>(name: string, value: string | undefined, action: () => T): T {
  const previous = process.env[name]
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
  try {
    return action()
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = previous
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return
    await delay(20)
  }
  throw new Error(message)
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function cancelGateTree(options: {
  detachedDescendant: boolean
  descendantStdio: 'ignore' | 'inherit'
  termBehavior: 'ignore' | 'spawn-detached'
}): Promise<{
  result: GateResult
  descendantAliveAfterReturn: boolean
  termHandlerSpawnedDescendant: boolean
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-run-gates-tree-'))
  const marker = join(directory, 'child.pid')
  const escapedMarker = join(directory, 'escaped.pid')
  const controller = new AbortController()
  let childPid: number | undefined
  let escapedPid: number | undefined
  let running: Promise<GateResult> | undefined
  try {
    const escapedScript = [
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid))",
      'setInterval(() => {}, 1000)',
    ].join(';')
    const termHandler = options.termBehavior === 'ignore'
      ? ["process.on('SIGTERM', () => {})"]
      : [
        "const { spawn } = require('node:child_process')",
        `process.on('SIGTERM', () => { spawn(process.execPath, ['-e', ${JSON.stringify(escapedScript)}, process.argv[2]], { detached: true, stdio: 'ignore' }).unref() })`,
      ]
    const childScript = [
      ...termHandler,
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid))",
      'setInterval(() => {}, 1000)',
    ].join(';')
    const script = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}, process.argv[1], process.argv[2]], { detached: ${String(options.detachedDescendant)}, stdio: ${JSON.stringify(options.descendantStdio)} })`,
      'setInterval(() => {}, 1000)',
    ].join(';')
    running = runGate(gate('tree', { args: ['-e', script, marker, escapedMarker] }), controller.signal)
    await waitUntil(async () => {
      try {
        childPid = Number(await readFile(marker, 'utf8'))
        return Number.isSafeInteger(childPid) && childPid > 0
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    }, 'child process did not publish its pid')
    if (childPid === undefined) throw new Error('child process published no pid')

    controller.abort(new Error('test required gate failed'))
    const result = await Promise.race([
      running,
      delay(12_000, undefined, { ref: false }).then(() => {
        throw new Error('runGate did not settle after cancellation')
      }),
    ])
    try {
      const publishedPid = Number(await readFile(escapedMarker, 'utf8'))
      if (Number.isSafeInteger(publishedPid) && publishedPid > 0) escapedPid = publishedPid
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return {
      result,
      descendantAliveAfterReturn: processExists(childPid),
      termHandlerSpawnedDescendant: escapedPid !== undefined,
    }
  } finally {
    controller.abort(new Error('test cleanup'))
    if (childPid !== undefined && processExists(childPid)) process.kill(childPid, 'SIGKILL')
    if (escapedPid !== undefined && processExists(escapedPid)) process.kill(escapedPid, 'SIGKILL')
    if (running !== undefined) await running
    await rm(directory, { recursive: true, force: true })
  }
}

describe('gate graph validation', () => {
  it.each([
    'ci-primary',
    'ci-static',
    'ci-lint-contracts-ready',
    'ci-coverage',
    'ci-snapshot',
    'ci-artifacts',
    'ci-consumers',
    'ci-windows-blocking',
    'ci-windows-complete',
    'ci-windows-observational',
    'node-compat',
    'check-all',
    'doc-sync',
  ] as const)('constructs and executes preflight for a valid non-empty %s graph', async (mode) => {
    const subject = withPnpmEntrypoint(() => gatesForMode(mode))
    const execute = vi.fn(async (item: Gate) => resultFor(item))

    await expect(runGates(subject, subject.length, execute)).resolves.toHaveLength(subject.length)
  })

  it('keeps the public repository link policy in the documentation gate', () => {
    const ids = withPnpmEntrypoint(() => gatesForMode('doc-sync').map(subject => subject.id))

    expect(ids).toContain('public-repository-links')
  })

  it.each(['ci-primary', 'ci-static', 'check-all'] as const)(
    'keeps the DSH package license policy in %s',
    (mode) => {
      const ids = withPnpmEntrypoint(() => gatesForMode(mode).map(subject => subject.id))

      expect(ids).toContain('dsh-package-licenses')
    },
  )

  it('keeps native Windows coverage blocking while portability inventory remains observational', () => {
    const gates = withPnpmEntrypoint(() => gatesForMode('ci-windows-complete'))
    const byId = new Map(gates.map(subject => [subject.id, subject]))

    expect(byId.get('coverage')?.allowFailure).not.toBe(true)
    expect(byId.get('coverage-exempt-heavy')?.allowFailure).not.toBe(true)
    expect(byId.get('duplication')?.allowFailure).toBe(true)
  })

  it('stops CI aggregates on required failure while diagnostic aggregates collect every result', () => {
    expect(stopsOnRequiredFailure('ci-primary')).toBe(true)
    expect(stopsOnRequiredFailure('ci-consumers')).toBe(true)
    expect(stopsOnRequiredFailure('ci-windows-blocking')).toBe(true)
    expect(stopsOnRequiredFailure('check-all')).toBe(false)
    expect(stopsOnRequiredFailure('doc-sync')).toBe(false)
    expect(stopsOnRequiredFailure('ci-windows-complete')).toBe(false)
    expect(stopsOnRequiredFailure('ci-windows-observational')).toBe(false)
  })

  it.each([
    ['empty', [], /gate graph has no gates/],
    ['duplicate ids', [gate('same'), gate('same')], /duplicate gate id "same"/],
    ['unknown dependencies', [gate('subject', { needs: ['missing'] })], /depends on unknown gate "missing"/],
    ['cycles', [gate('first', { needs: ['second'] }), gate('second', { needs: ['first'] })], /dependency cycle: first -> second -> first/],
  ] as const)('rejects %s before starting a child', async (_label, invalid, message) => {
    const execute = vi.fn(async (subject: Gate) => resultFor(subject))

    await expect(runGates([...invalid], 1, execute)).rejects.toThrow(message)
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects an invalid worker count before starting a child', async () => {
    const execute = vi.fn(async (subject: Gate) => resultFor(subject))

    await expect(runGates([gate('subject')], 0, execute)).rejects.toThrow('max concurrency must be a positive integer')
    expect(execute).not.toHaveBeenCalled()
  })

  it('skips dependents after their prerequisite fails', async () => {
    const dependent = gate('dependent', { needs: ['root'] })
    const root = gate('root')
    const execute = vi.fn(async (subject: Gate) => resultFor(subject, 'failed'))

    const results = await runGates([dependent, root], 1, execute)

    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(root, expect.any(AbortSignal))
    expect(results[0]).toMatchObject({
      gate: dependent,
      status: 'skipped',
      error: 'dependency failed, cancelled, or skipped: root',
    })
  })
})

describe('required-gate fail-fast lifecycle', () => {
  it('cancels and reaps running siblings without starting pending work', async () => {
    const fast = gate('fast')
    const slow = gate('slow')
    const pending = gate('pending')
    let slowReaped = false
    const execute = vi.fn(async (subject: Gate, signal: AbortSignal): Promise<GateResult> => {
      if (subject === fast) return resultFor(subject, 'failed')
      if (subject === slow) {
        return await new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            slowReaped = true
            resolve(resultFor(subject, 'cancelled'))
          }, { once: true })
        })
      }
      return resultFor(subject)
    })
    const stopped: GateResult[] = []

    const results = await runGates([fast, slow, pending], 2, execute, {
      stopOnRequiredFailure: true,
      onStop: (result) => { stopped.push(result) },
    })

    expect(execute.mock.calls.map(([subject]) => subject.id)).toEqual(['fast', 'slow'])
    expect(slowReaped).toBe(true)
    expect(results.map(result => result.status)).toEqual(['failed', 'cancelled', 'skipped'])
    expect(results[2]?.error).toBe('aggregate stopped after required gate fast failed')
    expect(stopped).toEqual([results[0]])
  })

  it('continues after an allowed failure', async () => {
    const allowed = gate('allowed', { allowFailure: true })
    const required = gate('required')
    const execute = vi.fn(async (subject: Gate) => resultFor(
      subject,
      subject === allowed ? 'failed' : 'passed',
    ))
    const stopped = vi.fn()

    const results = await runGates([allowed, required], 1, execute, {
      stopOnRequiredFailure: true,
      onStop: stopped,
    })

    expect(results.map(result => result.status)).toEqual(['failed', 'passed'])
    expect(execute).toHaveBeenCalledTimes(2)
    expect(stopped).not.toHaveBeenCalled()
  })

  it('stops when an allowed failure makes a required dependent impossible', async () => {
    const allowed = gate('allowed', { allowFailure: true })
    const slow = gate('slow')
    const dependent = gate('dependent', { needs: ['allowed'] })
    const pending = gate('pending')
    const execute = vi.fn(async (subject: Gate, signal: AbortSignal): Promise<GateResult> => {
      if (subject === allowed) return resultFor(subject, 'failed')
      if (subject === slow) {
        return await new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve(resultFor(subject, 'cancelled'))
          }, { once: true })
        })
      }
      return resultFor(subject)
    })
    const stopped: GateResult[] = []

    const results = await runGates([allowed, slow, dependent, pending], 2, execute, {
      stopOnRequiredFailure: true,
      onStop: (result) => { stopped.push(result) },
    })

    expect(results.map(result => result.status)).toEqual(['failed', 'cancelled', 'skipped', 'skipped'])
    expect(results[2]?.error).toBe('dependency failed, cancelled, or skipped: allowed')
    expect(stopped).toEqual([results[2]])
  })

  it.each(['throw', 'reject'] as const)('reaps siblings when an executor %ss', async (failure) => {
    const broken = gate('broken')
    const slow = gate('slow')
    const execute = (subject: Gate, signal: AbortSignal): Promise<GateResult> => {
      if (subject === broken) {
        if (failure === 'throw') throw new Error('broken executor')
        return Promise.reject(new Error('broken executor'))
      }
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          resolve(resultFor(subject, 'cancelled'))
        }, { once: true })
      })
    }

    const results = await runGates([broken, slow], 2, execute, { stopOnRequiredFailure: true })

    expect(results.map(result => result.status)).toEqual(['failed', 'cancelled'])
    expect(results[0]?.error).toBe('executor rejected: broken executor')
  })
})

describe('Oxlint gate', () => {
  it('uses the package script when no worker bound is configured', () => {
    const subject = withEnv('DSH_OXLINT_THREADS', undefined, () =>
      withPnpmEntrypoint(() => gatesForMode('ci-lint-contracts-ready')[0]))

    expect(subject).toMatchObject({
      id: 'lint',
      displayCommand: 'pnpm run lint:contracts-ready',
      command: process.execPath,
      args: ['/private/pnpm.cjs', 'run', 'lint:contracts-ready'],
    })
  })

  it('surfaces the configured worker bound on the shared package script', () => {
    const subject = withEnv('DSH_OXLINT_THREADS', '4', () =>
      withPnpmEntrypoint(() => gatesForMode('ci-lint-contracts-ready')[0]))

    expect(subject).toMatchObject({
      id: 'lint',
      displayCommand: 'DSH_OXLINT_THREADS=4 pnpm run lint:contracts-ready',
      command: process.execPath,
      args: ['/private/pnpm.cjs', 'run', 'lint:contracts-ready'],
    })
  })
})

describe('Typert contract preparation', () => {
  it('prepares primary source consumers once before they run', () => {
    const subject = withEnv('DSH_OXLINT_THREADS', undefined, () =>
      withPnpmEntrypoint(() => gatesForMode('ci-primary')))

    expect(subject.find(item => item.id === 'typert-contracts')).toMatchObject({
      displayCommand: 'pnpm run build:lib:host',
      args: ['/private/pnpm.cjs', 'run', 'build:lib:host'],
    })
    for (const [id, script] of [
      ['typecheck', 'typecheck:contracts-ready'],
      ['lint', 'lint:contracts-ready'],
      ['doc-typecheck', 'doc-typecheck:contracts-ready'],
    ] as const) {
      expect(subject.find(item => item.id === id)).toMatchObject({
        displayCommand: `pnpm run ${script}`,
        args: ['/private/pnpm.cjs', 'run', script],
        needs: ['typert-contracts'],
      })
    }
    expect(subject.find(item => item.id === 'build')?.needs).toEqual([
      'typecheck',
      'lint',
      'doc-typecheck',
    ])
  })

  it('reuses contracts from the validated consumer build', () => {
    const subject = withPnpmEntrypoint(() => gatesForMode('ci-consumers'))

    expect(subject.find(item => item.id === 'lint-and-duplication')).toMatchObject({
      displayCommand: 'pnpm run check:ci:lint:contracts-ready',
      args: ['/private/pnpm.cjs', 'run', 'check:ci:lint:contracts-ready'],
    })
    expect(subject.find(item => item.id === 'doc-typecheck')).toMatchObject({
      displayCommand: 'pnpm run doc-typecheck:contracts-ready',
      args: ['/private/pnpm.cjs', 'run', 'doc-typecheck:contracts-ready'],
    })
  })

  it('keeps standalone doc sync responsible for preparation', () => {
    const docTypecheck = withPnpmEntrypoint(() =>
      gatesForMode('doc-sync').find(item => item.id === 'doc-typecheck'))

    expect(docTypecheck?.displayCommand).toBe('pnpm run doc-typecheck')
  })
})

describe('Node compatibility graph', () => {
  it('runs the jsdom environment smoke on every advertised Node line', () => {
    const subject = withPnpmEntrypoint(() => gatesForMode('node-compat'))

    expect(subject.find(item => item.id === 'vitest-jsdom-smoke')).toMatchObject({
      label: 'Vitest jsdom smoke',
      args: [
        '/private/pnpm.cjs',
        'exec',
        'vitest',
        'run',
        'scripts/vitest-environment.compat.spec.ts',
      ],
    })
  })
})

describe('Node 24 lane ownership', () => {
  it('keeps the static lane source-only', () => {
    const subject = withPnpmEntrypoint(() => gatesForMode('ci-static'))

    expect(subject.map(item => item.id)).not.toContain('build')
    expect(subject.map(item => item.id)).not.toContain('doc-typecheck')
  })

  it('owns the build and orders its artifact consumers', () => {
    const subject = withPnpmEntrypoint(() => gatesForMode('ci-consumers'))

    expect(defaultConcurrency('ci-consumers', subject.length, 4)).toEqual({
      workers: 10,
      source: 'ci-consumers gate count',
    })
    expect(subject.map(item => item.id)).toEqual([
      'build',
      'node-compat',
      'publint',
      'built-package-invariants',
      'lint-and-duplication',
      'snapshot',
      'web-snapshot',
      'doc-typecheck',
      'node-next-types',
      'built-bin-smoke',
    ])
    expect(subject.find(item => item.id === 'publint')?.needs).toEqual(['build'])
    expect(subject.find(item => item.id === 'built-package-invariants')?.needs).toEqual(['publint'])
    expect(subject.find(item => item.id === 'lint-and-duplication')?.needs).toEqual(['built-package-invariants'])
    for (const id of [
      'snapshot',
      'web-snapshot',
      'doc-typecheck',
      'node-next-types',
      'built-bin-smoke',
    ]) {
      expect(subject.find(item => item.id === id)?.needs).toEqual(['built-package-invariants'])
    }
    expect(subject.find(item => item.id === 'snapshot')?.env).toEqual({ DSH_EXAMPLE_MODE: 'lib' })
    expect(subject.find(item => item.id === 'doc-typecheck')?.env).toEqual({
      DSH_DOC_TYPECHECK_USE_BUILD_OUTPUT: '1',
    })
    expect(subject.find(item => item.id === 'built-bin-smoke')?.args).toEqual(
      expect.arrayContaining([
        'packages/subagent/subagent-codex/tests/loader-composition.e2e.ts',
        'packages/subagent/subagent-claude-code/tests/loader-composition.e2e.ts',
      ]),
    )
    expect(subject.find(item => item.id === 'web-snapshot')).toMatchObject({
      displayCommand: 'DSH_SNAPSHOT=replay pnpm run test:web:built',
      env: { DSH_SNAPSHOT: 'replay' },
    })
  })
})

describe('snapshot inventory ownership', () => {
  it('keeps browser-carried Web files out of the general snapshot process', () => {
    expect(SNAPSHOT_TEST_INCLUDES.some(pattern => pattern.startsWith('apps/web/'))).toBe(false)
    expect(WEB_SNAPSHOT_TEST_INCLUDES).toEqual([
      'apps/web/tests/**/*.e2e.ts',
      'apps/web/tests/**/*.snapshot.ts',
    ])
  })

  it('keeps both snapshot owners in the comprehensive local aggregate', () => {
    const subject = withPnpmEntrypoint(() => gatesForMode('check-all'))

    expect(subject.find(item => item.id === 'snapshot')?.needs).toEqual(['build'])
    expect(subject.find(item => item.id === 'web-snapshot')).toMatchObject({
      needs: ['build'],
      env: { DSH_SNAPSHOT: 'replay' },
    })
    expect(subject.filter(item => item.id === 'build' || item.id === 'build:web').map(item => item.id))
      .toEqual(['build'])
  })
})

describe('gate process outcomes', () => {
  it.skipIf(process.platform === 'win32')('reports signal termination independently from exit status', async () => {
    const result = await runGate(gate('terminated', {
      args: ['-e', "process.kill(process.pid, 'SIGTERM')"],
    }))

    expect(result.status).toBe('failed')
    expect(result.exitCode).toBeNull()
    expect(result.signalCode).toBe('SIGTERM')
    expect(formatGateResultReason(result)).toBe('signal SIGTERM')
  })

  it('force-kills a signal-trapping group descendant before returning', async () => {
    const { result, descendantAliveAfterReturn } = await cancelGateTree({
      detachedDescendant: false,
      descendantStdio: 'ignore',
      termBehavior: 'ignore',
    })

    expect(result.status).toBe('cancelled')
    expect(result.error).toBe('cancelled: test required gate failed')
    expect(descendantAliveAfterReturn).toBe(false)
  }, 15_000)

  it.skipIf(process.platform === 'win32')(
    'freezes a detached descendant before its termination handler can fork',
    async () => {
      const { result, descendantAliveAfterReturn, termHandlerSpawnedDescendant } = await cancelGateTree({
        detachedDescendant: true,
        descendantStdio: 'inherit',
        termBehavior: 'spawn-detached',
      })

      expect(result.status).toBe('cancelled')
      expect(result.error).toBe('cancelled: test required gate failed')
      expect(descendantAliveAfterReturn).toBe(false)
      expect(termHandlerSpawnedDescendant).toBe(false)
    },
    15_000,
  )
})
