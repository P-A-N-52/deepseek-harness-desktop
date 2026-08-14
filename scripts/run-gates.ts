/**
 * Run local and CI quality gates with bounded in-process scheduling.
 *
 * Package scripts own public aggregate names; this runner owns their validated
 * dependency graphs, scheduler environment, and process diagnostics.
 * @see ../.agents/notes/implemented/process/2026-07-06-parallel-pre-push-gates.md
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { resolve, win32 } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { COVERAGE_EXEMPT_ENV, coverageExemptHeavySuites } from './coverage-exempt.ts'

/** A named aggregate exposed by the gate runner. */
export type Mode =
  | 'ci-primary'
  | 'ci-static'
  | 'ci-lint-contracts-ready'
  | 'ci-coverage'
  | 'ci-snapshot'
  | 'ci-artifacts'
  | 'ci-consumers'
  | 'ci-windows-blocking'
  | 'ci-windows-complete'
  | 'ci-windows-observational'
  | 'node-compat'
  | 'check-all'
  | 'doc-sync'

type GateResultStatus = 'passed' | 'failed' | 'cancelled' | 'skipped'
type GateState = 'pending' | 'running' | GateResultStatus

/** A command and its dependency metadata inside one aggregate. */
export interface Gate {
  id: string
  label: string
  displayCommand: string
  command: string
  args: string[]
  needs?: string[]
  env?: Record<string, string | undefined>
  allowFailure?: boolean
}

/** The observed outcome of one gate process. */
export interface GateResult {
  gate: Gate
  status: GateResultStatus
  durationMs: number
  output: GateOutputChunk[]
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  error?: string
}

interface GateOutputChunk {
  stream: 'stdout' | 'stderr'
  text: string
}

interface RunningGate {
  gate: Gate
  promise: Promise<GateResult>
}

interface ConcurrencyDefault {
  workers: number
  source: string
}

type GateExecutor = (gate: Gate, cancelSignal: AbortSignal) => Promise<GateResult>

interface RunGatesOptions {
  stopOnRequiredFailure?: boolean
  onStop?: (result: GateResult) => void
}

const root = resolve(import.meta.dirname, '..')
const PROCESS_TREE_FREEZE_MS = 5_000
const PROCESS_TREE_CONFIRM_MS = 5_000
const PROCESS_TREE_POLL_MS = 50
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2))
}

async function main(args: string[]): Promise<number> {
  const mode = parseMode(args[0])
  const gates = gatesForMode(mode)
  const concurrencyDefault = defaultConcurrency(mode, gates.length)
  const concurrencyOverride = process.env.DSH_GATE_CONCURRENCY
  const maxConcurrency = concurrencyFromEnv('DSH_GATE_CONCURRENCY', concurrencyDefault.workers)
  const concurrencySource = concurrencyOverride === undefined || concurrencyOverride === ''
    ? concurrencyDefault.source
    : '$DSH_GATE_CONCURRENCY'
  const startedAt = performance.now()
  console.log(`run-gates: ${mode} running ${gates.length} gate(s) with ${maxConcurrency} worker(s) from ${concurrencySource}.`)

  let stopCause: GateResult | undefined
  const results = await runGates(gates, maxConcurrency, runGate, {
    stopOnRequiredFailure: stopsOnRequiredFailure(mode),
    onStop: (result) => { stopCause = result },
  })
  if (stopCause !== undefined) {
    console.error(
      `run-gates: STOP after required gate ${stopCause.gate.label} ${stopCause.status}; all started gates settled.`,
    )
  }
  for (const result of results) printResult(result)
  printSummary(results, performance.now() - startedAt)
  return results.some(result => result.gate.allowFailure !== true && result.status !== 'passed')
    ? 1
    : 0
}

/**
 * Select modes where a blocking failure makes further work irrelevant.
 * @param selectedMode - aggregate mode being executed.
 * @returns true when the runner cancels active siblings and skips pending gates.
 */
export function stopsOnRequiredFailure(selectedMode: Mode): boolean {
  return selectedMode !== 'check-all'
    && selectedMode !== 'doc-sync'
    && selectedMode !== 'ci-windows-complete'
    && selectedMode !== 'ci-windows-observational'
}

function parseMode(raw: string | undefined): Mode {
  switch (raw) {
    case 'ci-primary':
    case 'ci-static':
    case 'ci-lint-contracts-ready':
    case 'ci-coverage':
    case 'ci-snapshot':
    case 'ci-artifacts':
    case 'ci-consumers':
    case 'ci-windows-blocking':
    case 'ci-windows-complete':
    case 'ci-windows-observational':
    case 'node-compat':
    case 'check-all':
    case 'doc-sync':
      return raw
    default:
      throw new Error(
        `run-gates: expected mode ci-primary | ci-static | ci-lint-contracts-ready | ci-coverage | ci-snapshot | ci-artifacts | ci-consumers | ci-windows-blocking | ci-windows-complete | ci-windows-observational | node-compat | check-all | doc-sync, got ${JSON.stringify(raw)}.`,
      )
  }
}

/**
 * Resolve the default worker count for one aggregate.
 * @param selectedMode - aggregate whose resource posture applies.
 * @param total - number of gates in the aggregate.
 * @param available - host CPU availability for ordinary modes.
 * @returns the default worker count and its diagnostic source.
 */
export function defaultConcurrency(
  selectedMode: Mode,
  total: number,
  available = availableParallelism(),
): ConcurrencyDefault {
  if (selectedMode === 'ci-consumers') return { workers: total, source: 'ci-consumers gate count' }
  // Local modes cap workers: several doc gates each build a full ts.Program,
  // so an uncapped default on a large host trades wall clock for memory blowups.
  const localCap = selectedMode === 'check-all' || selectedMode === 'doc-sync'
  const modeLimit = localCap ? Math.min(4, available) : available
  return {
    workers: Math.min(total, modeLimit),
    source: localCap
      ? `${available} available CPU(s), ${selectedMode} cap 4`
      : `${available} available CPU(s)`,
  }
}

function concurrencyFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`run-gates: ${name} must be a positive integer, got ${JSON.stringify(raw)}.`)
  }
  return parsed
}

function pnpmScript(id: string, script: string, options: Partial<Gate> = {}): Gate {
  return {
    id,
    label: options.label ?? script,
    displayCommand: `pnpm run ${script}`,
    ...pnpmInvocation(['run', script]),
    ...options,
  }
}

function pnpmExec(id: string, args: string[], options: Partial<Gate> = {}): Gate {
  return {
    id,
    label: options.label ?? `pnpm exec ${args.join(' ')}`,
    displayCommand: `pnpm exec ${args.join(' ')}`,
    ...pnpmInvocation(['exec', ...args]),
    ...options,
  }
}

function pnpmInvocation(args: string[]): Pick<Gate, 'command' | 'args'> {
  const entrypoint = process.env.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    throw new Error('run-gates: npm_execpath is unavailable; invoke the runner through a pnpm package script.')
  }
  // Windows cannot spawn the pnpm.cmd shim directly; the JavaScript entrypoint keeps every host shell-free.
  return { command: process.execPath, args: [entrypoint, ...args] }
}

/**
 * Construct the complete gate list for a named aggregate.
 * @param selected - aggregate mode to construct.
 * @returns the aggregate's gate graph.
 */
export function gatesForMode(selected: Mode): Gate[] {
  switch (selected) {
    case 'ci-primary':
      return ciPrimaryGates()
    case 'ci-static':
      return ciStaticGates({ ownsBuild: false })
    case 'ci-lint-contracts-ready':
      return [
        lintGate(),
        pnpmScript('duplication', 'duplication'),
      ]
    case 'ci-coverage':
      return coverageGates()
    case 'ci-snapshot':
      return [pnpmScript('build', 'build'), snapshotGate()]
    case 'ci-artifacts':
      return ciArtifactGates()
    case 'ci-consumers':
      return ciConsumerGates()
    case 'ci-windows-blocking':
      return ciWindowsBlockingGates()
    case 'ci-windows-complete':
      return ciWindowsCompleteGates()
    case 'ci-windows-observational':
      return ciWindowsObservationalGates()
    case 'node-compat':
      return nodeCompatGates()
    case 'check-all':
      return [
        pnpmScript('runtime-closure', 'verify-runtime-closure', { label: 'runtime closure' }),
        pnpmScript('cordis-config', 'verify-cordis-config', { label: 'Cordis config' }),
        pnpmScript('client-domain-graph', 'verify-client-domain-graph', { label: 'client domain graph' }),
        pnpmScript('test', 'test'),
        pnpmScript('issue-management', 'test:issue-management', { label: 'Issue management policy' }),
        pnpmScript('duplication', 'duplication'),
        snapshotGate(),
        pnpmScript('build', 'build'),
        webSnapshotGate(['build']),
        ...hygieneLeafGates({ artifactNeeds: ['build'] }),
        ...docSyncLeafGates({
          docTypecheckNeeds: ['build'],
          docTypecheckEnv: { DSH_DOC_TYPECHECK_USE_BUILD_OUTPUT: '1' },
          docTypecheckScript: 'doc-typecheck:contracts-ready',
        }),
        pnpmScript('module-graph', 'verify-module-graph', { label: 'module graph' }),
      ]
    case 'doc-sync':
      return docSyncLeafGates()
  }
}

function ciSharedStaticGates(): Gate[] {
  return [
    pnpmScript('runtime-closure', 'verify-runtime-closure', { label: 'runtime closure' }),
    pnpmScript('constraints', 'constraints'),
    pnpmScript('dsh-package-licenses', 'verify-dsh-package-licenses', { label: 'DSH package licenses' }),
    pnpmScript('package-invariants', 'verify-package-invariants', { label: 'package invariants' }),
    pnpmScript('cordis-config', 'verify-cordis-config', { label: 'Cordis config' }),
    pnpmScript('issue-management', 'test:issue-management', { label: 'Issue management policy' }),
  ]
}

function ciPrimaryGates(): Gate[] {
  return [
    ...ciSharedStaticGates(),
    typertContractsGate(),
    pnpmScript('typecheck', 'typecheck:contracts-ready', { needs: ['typert-contracts'] }),
    lintGate({ needs: ['typert-contracts'] }),
    pnpmScript('duplication', 'duplication'),
    ...coverageGates(),
    ...nodeCompatSmokeGates(),
    snapshotGate(),
    ...docSyncLeafGates({
      docTypecheckNeeds: ['typert-contracts'],
      docTypecheckScript: 'doc-typecheck:contracts-ready',
    }),
    pnpmScript('module-graph', 'verify-module-graph', { label: 'module graph' }),
    pnpmScript('knip', 'knip'),
    // The prepared typecheck and build both drive Client tsc, while build also
    // repeats the Host contract pass. Wait for all three consumers so build
    // neither races tsbuildinfo nor replaces declarations while they are read.
    pnpmScript('build', 'build', { needs: ['typecheck', 'lint', 'doc-typecheck'] }),
    pnpmScript('publint', 'publint', { needs: ['build'] }),
    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      needs: ['build'],
    }),
    builtPackageInvariantsGate(['build']),
    builtBinSmokeGate(),
  ]
}

function nodeCompatGates(): Gate[] {
  const typecheck = flagEnabled('DSH_NODE_COMPAT_SKIP_TYPECHECK')
    ? []
    : [pnpmScript('typecheck', 'typecheck')]
  if (runningNodeMajor() !== 22) {
    return [...typecheck, ...nodeCompatSmokeGates()]
  }
  return [
    ...typecheck,
    pnpmScript('build', 'build', {
      ...typecheck.length === 0 ? {} : { needs: ['typecheck'] },
    }),
    pnpmScript('build:web', 'build:web', {
      label: 'Web frontend build',
      needs: ['build'],
    }),
    ...nodeCompatSmokeGates({ cliSmoke: true }),
  ]
}

function nodeCompatSmokeGates(options: { cliSmoke?: boolean } = {}): Gate[] {
  const gates: Gate[] = [
    pnpmExec('source-worker-smoke', [
      'vitest',
      'run',
      'packages/workflow/workflow-worker-thread/tests/source-worker.compat.spec.ts',
    ], { label: 'source worker smoke' }),
    pnpmExec('jsonl-zstd-smoke', [
      'vitest',
      'run',
      'packages/session/session-persistence-jsonl/tests/zstd.compat.spec.ts',
    ], { label: 'JSONL Zstandard smoke' }),
    pnpmExec('dsh-source-launch-smoke', [
      'vitest',
      'run',
      'apps/cli/tests/source-launch.compat.spec.ts',
    ], { label: 'dsh source-launch smoke' }),
    pnpmExec('vitest-jsdom-smoke', [
      'vitest',
      'run',
      'scripts/vitest-environment.compat.spec.ts',
    ], { label: 'Vitest jsdom smoke' }),
  ]
  if (options.cliSmoke) {
    gates.push(
      pnpmExec('cli-lazy-search-startup-smoke', [
        'vitest',
        'run',
        'apps/cli/tests/lazy-search-startup.compat.spec.ts',
      ], {
        label: 'CLI lazy-search startup smoke',
        env: { DSH_REQUIRE_BUILT_CLI_SMOKE: '1' },
        needs: ['build:web'],
      }),
    )
  }
  return gates
}

/** Active Node major used to select version-specific compatibility checks. */
function runningNodeMajor(): number {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
  if (!Number.isSafeInteger(major)) {
    throw new Error(`run-gates: cannot parse Node version ${JSON.stringify(process.versions.node)}.`)
  }
  return major
}

function ciStaticGates(options: { ownsBuild: boolean }): Gate[] {
  return [
    ...ciSharedStaticGates(),
    ...options.ownsBuild ? [pnpmScript('build', 'build')] : [],
    ...docSyncLeafGates({
      includeDocTypecheck: options.ownsBuild,
      ...options.ownsBuild
        ? {
          docTypecheckNeeds: ['build'],
          docTypecheckEnv: { DSH_DOC_TYPECHECK_USE_BUILD_OUTPUT: '1' },
          docTypecheckScript: 'doc-typecheck:contracts-ready',
        }
        : {},
      docsBuildScript: 'docs:build:mpa',
    }),
    pnpmScript('module-graph', 'verify-module-graph', { label: 'module graph' }),
    pnpmScript('knip', 'knip'),
  ]
}

function ciArtifactGates(): Gate[] {
  return [
    pnpmScript('build', 'build'),
    pnpmScript('publint', 'publint', { needs: ['build'] }),
    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      needs: ['build'],
    }),
    builtPackageInvariantsGate(['build']),
    builtBinSmokeGate(),
  ]
}

function ciConsumerGates(): Gate[] {
  const builtTree = ['build']
  const validatedBuild = ['built-package-invariants']
  return [
    pnpmScript('build', 'build'),
    pnpmScript('node-compat', 'check:node-compat', { label: 'Node compatibility' }),
    pnpmScript('publint', 'publint', { needs: builtTree }),
    builtPackageInvariantsGate(['publint']),
    pnpmScript('lint-and-duplication', 'check:ci:lint:contracts-ready', {
      label: 'lint and duplication',
      needs: validatedBuild,
    }),
    snapshotGate(validatedBuild),
    webSnapshotGate(validatedBuild),
    pnpmScript('doc-typecheck', 'doc-typecheck:contracts-ready', {
      needs: validatedBuild,
      env: { DSH_DOC_TYPECHECK_USE_BUILD_OUTPUT: '1' },
    }),
    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      needs: validatedBuild,
    }),
    builtBinSmokeGate(validatedBuild),
  ]
}

function webSnapshotGate(needs: string[]): Gate {
  return pnpmScript('web-snapshot', 'test:web:built', {
    label: 'web browser snapshot',
    displayCommand: 'DSH_SNAPSHOT=replay pnpm run test:web:built',
    env: { DSH_SNAPSHOT: 'replay' },
    needs,
  })
}

function ciWindowsBlockingGates(): Gate[] {
  return [
    pnpmScript('windows-build', 'build', { label: 'build' }),
    pnpmScript('windows-site', 'docs:build', { label: 'production site' }),
  ]
}

function ciWindowsCompleteGates(): Gate[] {
  const observational = ciWindowsObservationalGates()
    // The required production site replaces the observational MPA build; both
    // VitePress modes write the same output directory and cannot overlap.
    .filter(gate => gate.id !== 'build' && gate.id !== 'docs-site-build')
    .map(gate => ({ ...gate, allowFailure: true }))
  return [
    pnpmScript('build', 'build'),
    pnpmScript('windows-site', 'docs:build', { label: 'production site' }),
    ...coverageGates(),
    ...observational,
  ]
}

function ciWindowsObservationalGates(): Gate[] {
  return [
    ...ciStaticGates({ ownsBuild: true }),
    // Linux owns required lint and snapshots; Windows omits those duplicates.
    pnpmScript('duplication', 'duplication'),
    pnpmScript('publint', 'publint', { needs: ['build'] }),
    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      needs: ['build'],
    }),
    builtPackageInvariantsGate(['build']),
    builtBinSmokeGate(),
  ]
}

function typertContractsGate(): Gate {
  return pnpmScript('typert-contracts', 'build:lib:host', { label: 'Typert contracts' })
}

function lintGate(options: { needs?: string[] } = {}): Gate {
  const raw = process.env.DSH_OXLINT_THREADS
  const script = 'lint:contracts-ready'
  return pnpmScript('lint', script, {
    ...raw === undefined || raw === ''
      ? {}
      : { displayCommand: `DSH_OXLINT_THREADS=${raw} pnpm run ${script}` },
    ...options.needs === undefined ? {} : { needs: options.needs },
  })
}

// The heavy suites run uninstrumented beside the thresholded gate: their
// compiler- and subprocess-bound fixtures pay a multiple of their runtime
// under v8 instrumentation while contributing nothing the thresholds need
// (membership rules in scripts/coverage-exempt.ts).
//
// DSH_COVERAGE_MAX_WORKERS is the lane's worker budget, so the two parallel
// gates split it instead of each claiming it whole (the failover pool's
// 8 x 6-instance bound assumes one lane never exceeds its value). The exempt
// gate's wall clock is dominated by its longest single file, so it takes the
// small share. A budget of 1 gives each gate 1 worker; lanes that need a
// strict total of one (the serial reference jobs) also set
// DSH_GATE_CONCURRENCY=1, which keeps the gates from overlapping at all.
function coverageWorkerArgs(): { instrumented: string[]; exempt: string[] } {
  const [flag] = positiveIntArg('DSH_COVERAGE_MAX_WORKERS', '--maxWorkers')
  if (flag === undefined) return { instrumented: [], exempt: [] }
  const total = Number.parseInt(flag.split('=')[1] ?? '', 10)
  const exempt = Math.max(1, Math.floor(total / 3))
  const instrumented = Math.max(1, total - exempt)
  return {
    instrumented: [`--maxWorkers=${String(instrumented)}`],
    exempt: [`--maxWorkers=${String(exempt)}`],
  }
}

function coverageGates(): Gate[] {
  const workers = coverageWorkerArgs()
  return [
    pnpmExec('coverage', [
      'vitest',
      'run',
      '--coverage',
      ...workers.instrumented,
    ], {
      label: 'test:coverage',
      env: { [COVERAGE_EXEMPT_ENV]: '1' },
    }),
    pnpmExec('coverage-exempt-heavy', [
      'vitest',
      'run',
      ...coverageExemptHeavySuites.map(suite => suite.filter),
      ...workers.exempt,
    ], {
      label: 'test:coverage-exempt-heavy',
    }),
  ]
}

// Example and package snapshots boot their bins in `lib` mode (built artifacts under plain Node,
// plugins via real exports); script snapshots execute their real source entry path.
// Callers wait either on `build` or on a validation gate that transitively owns that build.
function snapshotGate(needs: string[] = ['build']): Gate {
  return pnpmScript('snapshot', 'test:snapshot', {
    env: { DSH_EXAMPLE_MODE: 'lib' },
    needs,
  })
}

function builtPackageInvariantsGate(needs?: string[]): Gate {
  return pnpmScript('built-package-invariants', 'verify-built-package-invariants', {
    label: 'built package invariants',
    ...needs === undefined ? {} : { needs },
  })
}

function positiveIntArg(envName: string, flag: string): string[] {
  const raw = process.env[envName]
  if (raw === undefined || raw === '') return []
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(`run-gates: ${envName} must be a positive integer, got ${JSON.stringify(raw)}.`)
  }
  return [`${flag}=${raw}`]
}

function flagEnabled(envName: string): boolean {
  const raw = process.env[envName]
  if (raw === undefined || raw === '') return false
  if (raw !== '1') throw new Error(`run-gates: ${envName} must be 1 when set, got ${JSON.stringify(raw)}.`)
  return true
}

function hygieneLeafGates(options: { artifactNeeds?: string[] } = {}): Gate[] {
  const artifactOptions = options.artifactNeeds === undefined ? {} : { needs: options.artifactNeeds }
  return [
    pnpmScript('rescope-vendor', 'rescope-vendor:check', { label: 'vendor rescope' }),
    pnpmScript('knip', 'knip'),
    pnpmScript('publint', 'publint', artifactOptions),
    pnpmScript('constraints', 'constraints'),
    pnpmScript('dsh-package-licenses', 'verify-dsh-package-licenses', { label: 'DSH package licenses' }),
    pnpmScript('package-invariants', 'verify-package-invariants', { label: 'package invariants' }),
    builtPackageInvariantsGate(options.artifactNeeds),
    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      ...artifactOptions,
    }),
  ]
}

function docSyncLeafGates(options: {
  includeDocTypecheck?: boolean
  docTypecheckNeeds?: string[]
  docTypecheckEnv?: Record<string, string | undefined>
  docTypecheckScript?: 'doc-typecheck' | 'doc-typecheck:contracts-ready'
  docsBuildScript?: 'docs:build' | 'docs:build:mpa'
} = {}): Gate[] {
  const docTypecheckOptions: Partial<Gate> = {}
  if (options.docTypecheckNeeds !== undefined) docTypecheckOptions.needs = options.docTypecheckNeeds
  if (options.docTypecheckEnv !== undefined) docTypecheckOptions.env = options.docTypecheckEnv
  return [
    ...options.includeDocTypecheck === false
      ? []
      : [pnpmScript('doc-typecheck', options.docTypecheckScript ?? 'doc-typecheck', docTypecheckOptions)],
    pnpmScript('cordis-catalog', 'verify-cordis-catalog', { label: 'cordis catalog' }),
    pnpmScript('client-catalog', 'verify-client-catalog', { label: 'client catalog' }),
    pnpmScript('export-jsdoc', 'verify-export-jsdoc', { label: 'export jsdoc' }),
    pnpmScript('tool-catalog', 'verify-tool-catalog', { label: 'tool catalog' }),
    pnpmScript('config-catalog', 'verify-config-catalog', { label: 'config catalog' }),
    pnpmScript('persistence-catalog', 'verify-persistence-catalog', { label: 'persistence catalog' }),
    pnpmScript('doc-graphs', 'verify-doc-graphs', { label: 'doc graphs' }),
    pnpmScript('scoped-events', 'verify-scoped-events', { label: 'scoped events' }),
    pnpmScript('markdown-wrap', 'verify-md-wrap', { label: 'markdown wrap' }),
    pnpmScript('markdown-links', 'verify-md-links', { label: 'markdown links' }),
    pnpmScript('public-repository-links', 'verify-public-repository-links', { label: 'public repository links' }),
    pnpmScript('doc-refs', 'verify-doc-refs', { label: 'doc refs' }),
    pnpmScript('package-paths', 'verify-package-paths', { label: 'package paths' }),
    pnpmScript('config-source-ownership', 'verify-config-source-ownership', { label: 'config source ownership' }),
    pnpmScript('package-readme-model-experience', 'verify-package-readme-model-experience', { label: 'package README model experience' }),
    pnpmScript('mermaid', 'verify-mermaid'),
    pnpmScript('agent-note-classification', 'verify-agent-note-classification', { label: 'agent note classification' }),
    pnpmScript('agent-note-format', 'verify-agent-note-format', { label: 'agent note format' }),
    pnpmScript('archived-agent-notes', 'verify-archived-agent-notes', { label: 'archived agent notes' }),
    pnpmScript('type-equivalence', 'verify-type-equiv', { label: 'type equivalence' }),
    pnpmScript('skill-invocation-metadata', 'verify-skill-invocation-metadata', { label: 'skill invocation metadata' }),
    pnpmScript('translation-prompt', 'verify-translation-prompt', { label: 'translation prompt' }),
    pnpmScript('translation-pairing', 'verify-translation-pairing', { label: 'translation pairing' }),
    pnpmScript('doc-budgets', 'verify-doc-budgets', { label: 'doc budgets' }),
    pnpmExec('docs-site-projection', ['vitest', 'run', 'scripts/project-doc-site.spec.ts', 'scripts/verify-doc-site-fragments.spec.ts'], {
      label: 'documentation site checks',
    }),
    // Keep the VitePress build itself in one gate because projection rewrites website/.generated.
    pnpmScript('docs-site-build', options.docsBuildScript ?? 'docs:build', { label: 'documentation build' }),
    pnpmScript('package-readme-limitations', 'verify-package-readme-limitations', { label: 'package README limitations' }),
  ]
}

function builtBinSmokeGate(needs: string[] = ['build']): Gate {
  return pnpmExec('built-bin-smoke', [
    'vitest',
    'run',
    '--config',
    'vitest.e2e.config.ts',
    'examples/headless-agent/tests/keyless-smoke.e2e.ts',
    'apps/cli/tests/built-bin.e2e.ts',
    'packages/examples/acp-demo/tests/built-bin.e2e.ts',
    'packages/host/directory-picker-native/tests/built-worker.e2e.ts',
    'packages/sdk/server/tests/built-scope-carrier.e2e.ts',
    'packages/subagent/subagent-codex/tests/loader-composition.e2e.ts',
    'packages/subagent/subagent-claude-code/tests/loader-composition.e2e.ts',
    'packages/api/remotes/tests/built-lib.e2e.ts',
    // Built execution consumers: the only automated proof that package-name
    // imports reach their lib/ entrypoints under plain Node. The e2e lane runs
    // unbuilt, so these files self-skip there.
    'packages/workflow/workflow-worker-thread/tests/built-worker.e2e.ts',
    'packages/code-runtime/code-runtime-worker-thread/tests/built-lib.e2e.ts',
    'packages/lsp/lsp-stdio/tests/built-lib.e2e.ts',
  ], {
    label: 'built-bin smoke',
    needs,
    env: { DSH_EXAMPLE_MODE: 'lib' },
  })
}

/**
 * Reject a gate list whose graph cannot be executed unambiguously.
 * @param gates - complete aggregate to validate.
 */
function validateGateGraph(gates: readonly Gate[]): void {
  if (gates.length === 0) throw new Error('run-gates: gate graph has no gates.')

  const ids = new Set<string>()
  for (const gate of gates) {
    if (ids.has(gate.id)) throw new Error(`run-gates: duplicate gate id ${JSON.stringify(gate.id)}.`)
    ids.add(gate.id)
  }
  for (const gate of gates) {
    for (const dependency of gate.needs ?? []) {
      if (!ids.has(dependency)) {
        throw new Error(`run-gates: gate ${JSON.stringify(gate.id)} depends on unknown gate ${JSON.stringify(dependency)}.`)
      }
    }
  }

  const cycle = findDependencyCycle(gates)
  if (cycle !== undefined) throw new Error(`run-gates: dependency cycle: ${cycle.join(' -> ')}.`)
}

function findDependencyCycle(gates: readonly Gate[]): string[] | undefined {
  const byId = new Map(gates.map(gate => [gate.id, gate]))
  const complete = new Set<string>()
  const active = new Map<string, number>()
  const path: string[] = []

  const visit = (id: string): string[] | undefined => {
    if (complete.has(id)) return undefined
    const cycleStart = active.get(id)
    if (cycleStart !== undefined) return [...path.slice(cycleStart), id]
    const gate = byId.get(id)
    if (gate === undefined) return undefined

    active.set(id, path.length)
    path.push(id)
    for (const dependency of gate.needs ?? []) {
      const cycle = visit(dependency)
      if (cycle !== undefined) return cycle
    }
    path.pop()
    active.delete(id)
    complete.add(id)
    return undefined
  }

  for (const gate of gates) {
    const cycle = visit(gate.id)
    if (cycle !== undefined) return cycle
  }
  return undefined
}

/**
 * Validate and run one aggregate before the injected executor can start a child.
 * @param gates - complete aggregate to execute.
 * @param maxActive - maximum concurrent child count.
 * @param execute - child-process executor.
 * @param options - cancellation behavior for blocking failures.
 * @returns results in aggregate order.
 */
export async function runGates(
  gates: Gate[],
  maxActive: number,
  execute: GateExecutor,
  options: RunGatesOptions = {},
): Promise<GateResult[]> {
  validateGateGraph(gates)
  if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
    throw new Error(`run-gates: max concurrency must be a positive integer, got ${JSON.stringify(maxActive)}.`)
  }
  const states = new Map<string, GateState>(gates.map(gate => [gate.id, 'pending']))
  const results = new Map<string, GateResult>()
  const running: RunningGate[] = []
  const controller = new AbortController()
  let stopCause: GateResult | undefined

  const record = (result: GateResult): void => {
    states.set(result.gate.id, result.status)
    results.set(result.gate.id, result)
    if (options.stopOnRequiredFailure !== true
      || result.gate.allowFailure === true
      || result.status === 'passed'
      || stopCause !== undefined) return
    stopCause = result
    options.onStop?.(result)
    controller.abort(new Error(`required gate ${result.gate.id} ${result.status}`))
  }

  const skip = (gate: Gate, error: string): void => {
    record({
      gate,
      status: 'skipped',
      durationMs: 0,
      output: [],
      exitCode: null,
      signalCode: null,
      error,
    })
  }

  const skipBlocked = (): boolean => {
    let changed = false
    for (;;) {
      const blocked = gates.find(gate => states.get(gate.id) === 'pending' && (gate.needs ?? []).some((id) => {
        const state = states.get(id)
        return state === 'failed' || state === 'cancelled' || state === 'skipped'
      }))
      if (blocked === undefined) return changed
      const failedDependencies = (blocked.needs ?? []).filter((id) => {
        const state = states.get(id)
        return state === 'failed' || state === 'cancelled' || state === 'skipped'
      })
      skip(blocked, `dependency failed, cancelled, or skipped: ${failedDependencies.join(', ')}`)
      changed = true
    }
  }

  const skipAfterStop = (): boolean => {
    if (stopCause === undefined) return false
    let changed = false
    for (const gate of gates) {
      if (states.get(gate.id) !== 'pending') continue
      skip(gate, `aggregate stopped after required gate ${stopCause.gate.id} ${stopCause.status}`)
      changed = true
    }
    return changed
  }

  const start = (gate: Gate): void => {
    states.set(gate.id, 'running')
    const started = performance.now()
    const promise = Promise.resolve()
      .then(() => execute(gate, controller.signal))
      .catch((cause: unknown): GateResult => ({
        gate,
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        durationMs: performance.now() - started,
        output: [],
        exitCode: null,
        signalCode: null,
        error: `executor rejected: ${errorMessage(cause)}`,
      }))
    running.push({ gate, promise })
    console.log(`run-gates: start ${gate.label}`)
  }

  for (;;) {
    let madeProgress = skipBlocked()
    madeProgress = skipAfterStop() || madeProgress
    while (stopCause === undefined && running.length < maxActive) {
      const ready = gates.find(gate => states.get(gate.id) === 'pending' && dependenciesPassed(gate, states))
      if (ready === undefined) break
      start(ready)
      madeProgress = true
    }

    if (running.length === 0) {
      const pending = gates.filter(gate => states.get(gate.id) === 'pending')
      if (pending.length > 0) throw new Error('run-gates: validated graph stalled without a failed dependency.')
      break
    }

    if (!madeProgress) {
      const settled = await Promise.race(running.map(async item => ({ item, result: await item.promise })))
      running.splice(running.indexOf(settled.item), 1)
      record(settled.result)
    }
  }

  return gates.map((gate) => {
    const result = results.get(gate.id)
    if (result === undefined) throw new Error(`run-gates: missing result for ${gate.id}.`)
    return result
  })
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function dependenciesPassed(gate: Gate, states: Map<string, GateState>): boolean {
  return (gate.needs ?? []).every(id => states.get(id) === 'passed')
}

/**
 * Execute one gate through the real shell-free child-process boundary.
 * @param gate - command and scheduler environment to execute.
 * @param cancelSignal - aggregate cancellation that freezes and force-kills the POSIX execution, or
 * force-kills the Windows tree; commands must keep descendants connected until cancellation.
 * @returns the complete process outcome.
 */
export async function runGate(gate: Gate, cancelSignal?: AbortSignal): Promise<GateResult> {
  const started = performance.now()
  const output: GateOutputChunk[] = []
  if (cancelSignal?.aborted) {
    return {
      gate,
      status: 'cancelled',
      durationMs: performance.now() - started,
      output,
      exitCode: null,
      signalCode: null,
      error: `cancelled before spawn: ${errorMessage(cancelSignal.reason)}`,
    }
  }

  const child = spawn(gate.command, gate.args, {
    cwd: root,
    env: { ...process.env, ...gate.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    output.push({ stream: 'stdout', text: chunk })
  })
  child.stderr.on('data', (chunk: string) => {
    output.push({ stream: 'stderr', text: chunk })
  })
  let spawnError: string | undefined
  let childSettled = false
  const outcome = new Promise<{ exitCode: number | null; signalCode: NodeJS.Signals | null }>((resolveOutcome) => {
    const settle = (exitCode: number | null, signalCode: NodeJS.Signals | null): void => {
      if (childSettled) return
      childSettled = true
      resolveOutcome({ exitCode, signalCode })
    }
    child.once('error', (error) => {
      spawnError = `failed to start command: ${error.message}`
      settle(null, null)
    })
    child.once('close', settle)
  })

  let cancellation: Promise<string | undefined> | undefined
  const cancellationStarted = Promise.withResolvers<void>()
  const onCancel = (): void => {
    if (cancellation !== undefined) return
    cancellation = terminateGateProcessTree(child).then(
      () => undefined,
      (cause: unknown) => {
        forceDirectChildExit(child)
        return errorMessage(cause)
      },
    )
    cancellationStarted.resolve()
  }
  cancelSignal?.addEventListener('abort', onCancel, { once: true })
  if (cancelSignal?.aborted) onCancel()

  const first = cancellation === undefined
    ? await Promise.race([
      outcome.then(() => 'outcome' as const),
      cancellationStarted.promise.then(() => 'cancellation' as const),
    ])
    : 'cancellation'
  let cancellationError: string | undefined
  if (first === 'cancellation' || cancellation !== undefined) {
    cancellationError = await cancellation
  }
  const { exitCode, signalCode } = await outcome
  cancelSignal?.removeEventListener('abort', onCancel)

  const wasCancelled = cancellation !== undefined
  const status: GateResultStatus = wasCancelled
    ? 'cancelled'
    : exitCode === 0 && signalCode === null && spawnError === undefined ? 'passed' : 'failed'
  const result: GateResult = {
    gate,
    status,
    durationMs: performance.now() - started,
    output,
    exitCode,
    signalCode,
  }
  const errors = [
    ...wasCancelled ? [`cancelled: ${errorMessage(cancelSignal?.reason)}`] : [],
    ...spawnError === undefined ? [] : [spawnError],
    ...cancellationError === undefined ? [] : [`process tree cleanup failed: ${cancellationError}`],
  ]
  if (errors.length > 0) result.error = errors.join('; ')
  return result
}

async function terminateGateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (pid === undefined || pid <= 0) throw new Error('child process has no usable pid')
  if (process.platform === 'win32') {
    terminateWindowsProcessTree(pid)
    return
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(`POSIX gate cleanup is unsupported on ${process.platform}`)
  }

  const captured = new Map<number, GateProcessIdentity>()
  try {
    await freezePosixExecution(pid, captured)
  } catch (cause) {
    const forceError = await forcePosixExecution(pid, [...captured.values()])
    throw new Error([
      `cannot freeze process group ${pid} and its descendants: ${errorMessage(cause)}`,
      ...forceError === undefined ? [] : [`emergency process cleanup failed: ${forceError}`],
    ].join('; '))
  }

  const forceError = await forcePosixExecution(pid, [...captured.values()])
  if (forceError !== undefined) throw new Error(forceError)
}

interface PosixProcessEntry extends GateProcessIdentity {
  parentPid: number
  processGroupId: number
  state: string
}

interface GateProcessIdentity {
  pid: number
  started: string
}

function readPosixProcessTable(): PosixProcessEntry[] {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,state=,lstart='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: PROCESS_TREE_CONFIRM_MS,
  })
  if (result.error !== undefined) throw new Error(`/bin/ps failed: ${result.error.message}`)
  if (result.status !== 0) {
    const diagnostic = result.stderr.trim()
    throw new Error(`/bin/ps exited ${String(result.status)}${diagnostic === '' ? '' : `: ${diagnostic}`}`)
  }

  return result.stdout.split('\n').flatMap((line) => {
    if (line.trim() === '') return []
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (match?.[1] === undefined
      || match[2] === undefined
      || match[3] === undefined
      || match[4] === undefined
      || match[5] === undefined) {
      throw new Error(`cannot parse /bin/ps row: ${JSON.stringify(line)}`)
    }
    const pid = Number(match[1])
    const parentPid = Number(match[2])
    const processGroupId = Number(match[3])
    if (![pid, parentPid, processGroupId].every(Number.isSafeInteger)) {
      throw new Error(`invalid numeric identity in /bin/ps row: ${JSON.stringify(line)}`)
    }
    return [{ pid, parentPid, processGroupId, state: match[4], started: match[5] }]
  })
}

function executionEntries(
  processGroupId: number,
  captured: ReadonlyMap<number, GateProcessIdentity>,
  entries: readonly PosixProcessEntry[],
): PosixProcessEntry[] {
  const byParent = new Map<number, PosixProcessEntry[]>()
  for (const entry of entries) {
    const children = byParent.get(entry.parentPid) ?? []
    children.push(entry)
    byParent.set(entry.parentPid, children)
  }

  const seeds = entries.filter((entry) => {
    const identity = captured.get(entry.pid)
    return entry.processGroupId === processGroupId || identity?.started === entry.started
  })
  const visited = new Set<number>()
  const execution: PosixProcessEntry[] = []
  const visit = (parentPid: number): void => {
    for (const child of byParent.get(parentPid) ?? []) {
      if (visited.has(child.pid)) continue
      visited.add(child.pid)
      execution.push(child)
      visit(child.pid)
    }
  }
  for (const seed of seeds) {
    if (!visited.has(seed.pid)) {
      visited.add(seed.pid)
      execution.push(seed)
    }
    visit(seed.pid)
  }
  return execution
}

async function freezePosixExecution(
  processGroupId: number,
  captured: Map<number, GateProcessIdentity>,
): Promise<void> {
  signalProcessGroup(processGroupId, 'SIGSTOP')
  const deadline = performance.now() + PROCESS_TREE_FREEZE_MS

  for (;;) {
    const entries = readPosixProcessTable()
    const execution = executionEntries(processGroupId, captured, entries)
      .filter(entry => !/^[ZXx]/.test(entry.state))
    let discovered = false
    for (const entry of execution) {
      const current = captured.get(entry.pid)
      if (current?.started === entry.started) continue
      captured.set(entry.pid, { pid: entry.pid, started: entry.started })
      discovered = true
    }

    const unstopped = execution
      .filter(entry => !/^[Tt]/.test(entry.state))
      .map(({ pid, started }) => ({ pid, started }))
    if (unstopped.length > 0) signalIdentities(unstopped, 'SIGSTOP')
    if (!discovered && unstopped.length === 0) return

    const remaining = deadline - performance.now()
    if (remaining <= 0) {
      throw new Error(`process tree did not reach a stopped fixed point within ${PROCESS_TREE_FREEZE_MS}ms`)
    }
    await delay(Math.min(PROCESS_TREE_POLL_MS, remaining))
  }
}

function liveIdentities(
  identities: readonly GateProcessIdentity[],
  entries: readonly PosixProcessEntry[],
): GateProcessIdentity[] {
  const byPid = new Map(entries.map(entry => [entry.pid, entry]))
  return identities.filter((identity) => {
    const current = byPid.get(identity.pid)
    return current?.started === identity.started && !/^[ZXx]/.test(current.state)
  })
}

function presentIdentities(
  identities: readonly GateProcessIdentity[],
  entries: readonly PosixProcessEntry[],
): GateProcessIdentity[] {
  const byPid = new Map(entries.map(entry => [entry.pid, entry]))
  return identities.filter(identity => byPid.get(identity.pid)?.started === identity.started)
}

function signalIdentities(identities: readonly GateProcessIdentity[], signal: NodeJS.Signals): void {
  const failures: string[] = []
  for (const identity of identities) {
    try {
      process.kill(identity.pid, signal)
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code === 'ESRCH') continue
      if (code === 'EPERM') {
        try {
          if (liveIdentities([identity], readPosixProcessTable()).length === 0) continue
        } catch (inspectionCause) {
          failures.push(`cannot verify captured process ${identity.pid}: ${errorMessage(inspectionCause)}`)
          continue
        }
      }
      failures.push(`cannot send ${signal} to captured process ${identity.pid}: ${errorMessage(cause)}`)
    }
  }
  if (failures.length > 0) throw new Error(failures.join('; '))
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return
    if (code === 'EPERM') {
      const groupAlive = readPosixProcessTable()
        .some(entry => entry.processGroupId === pid && !/^[ZXx]/.test(entry.state))
      if (!groupAlive) return
    }
    throw new Error(`cannot send ${signal} to process group ${pid}: ${errorMessage(cause)}`)
  }
}

async function waitForPosixExecutionExit(
  processGroupId: number,
  descendants: readonly GateProcessIdentity[],
  timeoutMs: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const entries = readPosixProcessTable()
    const groupAlive = entries.some(entry => entry.processGroupId === processGroupId && !/^[ZXx]/.test(entry.state))
    if (!groupAlive && presentIdentities(descendants, entries).length === 0) return true
    const remaining = deadline - performance.now()
    if (remaining <= 0) return false
    await delay(Math.min(PROCESS_TREE_POLL_MS, remaining))
  }
}

async function forcePosixExecution(
  processGroupId: number,
  captured: readonly GateProcessIdentity[],
): Promise<string | undefined> {
  const failures: string[] = []
  let forceTargets: GateProcessIdentity[] = []
  try {
    forceTargets = liveIdentities(captured, readPosixProcessTable())
  } catch (cause) {
    failures.push(`cannot inspect captured processes before SIGKILL: ${errorMessage(cause)}`)
  }
  try {
    signalProcessGroup(processGroupId, 'SIGKILL')
  } catch (cause) {
    failures.push(errorMessage(cause))
  }
  try {
    signalIdentities(forceTargets, 'SIGKILL')
  } catch (cause) {
    failures.push(errorMessage(cause))
  }
  try {
    if (await waitForPosixExecutionExit(processGroupId, captured, PROCESS_TREE_CONFIRM_MS)) return undefined
    failures.unshift(`process group ${processGroupId} or a captured descendant remained after SIGKILL`)
  } catch (cause) {
    failures.unshift(`cannot confirm process cleanup: ${errorMessage(cause)}`)
  }
  return failures.join('; ')
}

function terminateWindowsProcessTree(pid: number): void {
  const windowsDirectory = [process.env.SystemRoot, process.env.windir]
    .find(directory => directory !== undefined && /^[a-z]:[/\\]/i.test(directory) && win32.isAbsolute(directory))
  if (windowsDirectory === undefined) {
    throw new Error('SystemRoot or windir must name an absolute Windows directory')
  }
  const taskkill = win32.join(windowsDirectory, 'System32', 'taskkill.exe')
  const result = spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: PROCESS_TREE_CONFIRM_MS,
    windowsHide: true,
  })
  if (result.error !== undefined) {
    throw new Error(`taskkill could not terminate process tree ${pid}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const diagnostic = result.stderr.trim()
    throw new Error(
      `taskkill could not terminate process tree ${pid}: exit ${String(result.status)}${diagnostic === '' ? '' : `: ${diagnostic}`}`,
    )
  }
}

function forceDirectChildExit(child: ChildProcess): void {
  try {
    child.kill('SIGKILL')
  } catch {
    // The cleanup error already carries the authoritative failure.
  }
  child.stdout?.destroy()
  child.stderr?.destroy()
}

/**
 * Format every independently observed failure fact for the aggregate summary.
 * @param result - unsuccessful gate result.
 * @returns error, exit, and signal facts without allowing one to hide another.
 */
export function formatGateResultReason(result: GateResult): string {
  const facts: string[] = []
  if (result.error !== undefined) facts.push(result.error)
  if (result.exitCode !== null) facts.push(`exit ${result.exitCode}`)
  if (result.signalCode !== null) facts.push(`signal ${result.signalCode}`)
  return facts.length === 0 ? 'no exit code or signal' : facts.join(', ')
}

function printResult(result: GateResult): void {
  const verbose = process.env.DSH_GATE_VERBOSE === '1'
  const seconds = (result.durationMs / 1000).toFixed(2)
  if (result.status === 'passed' && !verbose) {
    console.log(`run-gates: PASS ${result.gate.label} (${seconds}s)`)
    return
  }

  const heading = `${result.status.toUpperCase()} ${result.gate.label} (${seconds}s)`
  const writeHeading = result.status === 'passed' ? console.log : console.error
  writeHeading(`\n== ${heading} ==`)
  if (result.status !== 'passed') {
    console.error(`command: ${result.gate.displayCommand}`)
    console.error(`outcome: ${formatGateResultReason(result)}`)
  }
  printOutput(result.output)
}

function printSummary(results: GateResult[], durationMs: number): void {
  const passed = results.filter(result => result.status === 'passed').length
  const failed = results.filter(result => result.status === 'failed').length
  const cancelled = results.filter(result => result.status === 'cancelled').length
  const skipped = results.filter(result => result.status === 'skipped').length
  const seconds = (durationMs / 1000).toFixed(2)
  console.log(`\nrun-gates: ${passed} passed, ${failed} failed, ${cancelled} cancelled, ${skipped} skipped in ${seconds}s.`)

  const unsuccessful = results.filter(result => result.status !== 'passed')
  if (unsuccessful.length === 0) return

  console.error('run-gates: unsuccessful gates:')
  for (const result of unsuccessful) {
    const duration = (result.durationMs / 1000).toFixed(2)
    const reason = formatGateResultReason(result)
    const disposition = result.gate.allowFailure === true ? 'NON-BLOCKING ' : ''
    console.error(`  - ${disposition}${result.status.toUpperCase()} ${result.gate.label} (${duration}s, ${reason})`)
    console.error(`    ${result.gate.displayCommand}`)
  }
}

function printOutput(output: GateOutputChunk[]): void {
  for (const chunk of output) {
    if (chunk.stream === 'stdout') process.stdout.write(chunk.text)
    else process.stderr.write(chunk.text)
  }
}
