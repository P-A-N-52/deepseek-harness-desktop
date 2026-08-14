import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const runnerPrivatePnpmDestination = '${{ runner.temp }}/setup-pnpm'
const workflowFileExtensions = ['.yml', '.yaml'] as const
const desktopWorkflowPaths = [
  '.github/workflows/desktop-*.yml',
  'apps/cli/**',
  'apps/desktop/**',
  'native/desktop-runtime/**',
  'package.json',
  'packages/**',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'patches/**',
  'scripts/*desktop*.ts',
  'scripts/cargo-locked',
  'scripts/gen-third-party-notices.ts',
  'scripts/single-exe-build*.ts',
  'scripts/verify-runtime-closure.ts',
]
const workflowPaths = readdirSync(resolve(root, '.github/workflows'), { withFileTypes: true })
  .filter(entry => entry.isFile() && workflowFileExtensions.some(extension => entry.name.endsWith(extension)))
  .map(entry => '.github/workflows/' + entry.name)
  .sort()

describe('Desktop CI workflow', () => {
  it('pins the supported pnpm 11 setup and triggers its full offline deploy surface', () => {
    const workflow = loadWorkflow('.github/workflows/desktop-ci.yml')
    const pullRequest = workflowEvent(workflow, 'pull_request')
    const push = workflowEvent(workflow, 'push')
    const desktop = workflowJob(workflow, 'desktop-arm64')
    if (!Array.isArray(pullRequest.paths) || !Array.isArray(push.paths) || !Array.isArray(desktop.steps)) {
      throw new TypeError('Desktop CI must define PR/push paths and desktop-arm64 steps')
    }

    expect(pullRequest.paths).toEqual(desktopWorkflowPaths)
    expect(push.paths).toEqual(desktopWorkflowPaths)
    const pnpm = desktop.steps.filter(isRecord).find(step => step.uses === 'pnpm/action-setup@v6')
    expect(pnpm).toMatchObject({
      with: {
        dest: runnerPrivatePnpmDestination,
        version: '11.7.0',
      },
    })
    const releaseEvidence = desktop.steps.filter(isRecord)
      .find(step => step.name === 'Verify generated release evidence')
    const lifecycle = desktop.steps.filter(isRecord)
      .find(step => step.name === 'Exercise packaged app ownership and restart')
    const cargoLock = desktop.steps.filter(isRecord)
      .find(step => step.name === 'Require an unchanged Cargo lockfile')
    expect(releaseEvidence?.run).toMatch(/^pnpm run desktop:prepare-release --target /u)
    expect(lifecycle?.run).toMatch(/^pnpm run desktop:verify-app --app /u)
    expect(cargoLock?.run).toBe('git diff --exit-code -- apps/desktop/src-tauri/Cargo.lock')
    expect(JSON.stringify(desktop.steps)).toContain('scripts/run-desktop-tauri.spec.ts')
  })
})

describe('Desktop release workflow', () => {
  it('publishes only verified Apple Silicon assets from a protected annotated tag', () => {
    const workflow = loadWorkflow('.github/workflows/desktop-release.yml')
    const release = workflowJob(workflow, 'release')
    if (!Array.isArray(release.steps)) throw new TypeError('Desktop release must define release steps')
    const steps = release.steps.filter(isRecord)

    expect(workflow.on).toEqual({ workflow_dispatch: {} })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(release).toMatchObject({
      environment: 'desktop-release',
      permissions: { contents: 'write' },
      'runs-on': 'macos-15',
    })
    expect(steps.find(step => step.uses === 'actions/checkout@v6')).toMatchObject({
      with: {
        'fetch-depth': 0,
        'persist-credentials': false,
      },
    })
    expect(steps.find(step => step.uses === 'pnpm/action-setup@v6')).toMatchObject({
      with: {
        dest: runnerPrivatePnpmDestination,
        version: '11.7.0',
      },
    })

    const authorize = steps.find(step => step.name === 'Authorize the immutable release')
    const credentials = steps.find(step => step.name === 'Import protected Apple credentials')
    const packageRelease = steps.find(step => step.name === 'Sign, notarize, staple, and verify the release')
    const cleanup = steps.find(step => step.name === 'Remove temporary Apple credentials')
    const publish = steps.find(step => step.name === 'Publish the verified GitHub release')
    if (cleanup === undefined) throw new TypeError('Desktop release must remove its temporary credentials')
    if (typeof publish?.run !== 'string') throw new TypeError('Desktop release must define its publication command')
    const publishRun = publish.run
    expect(authorize?.run).toContain('[ "$GITHUB_REF_TYPE" = tag ]')
    expect(authorize?.run).toContain('[ "$(git cat-file -t "$GITHUB_REF_NAME")" = tag ]')
    expect(authorize?.run).toContain('git merge-base --is-ancestor "$GITHUB_SHA" "$default_ref"')
    expect(authorize?.run).toContain('DESKTOP_RELEASE_ENABLED=true')
    expect(credentials?.env).toEqual({
      CERTIFICATE_P12_BASE64: '${{ secrets.DESKTOP_APPLE_CERTIFICATE_P12_BASE64 }}',
      CERTIFICATE_PASSWORD: '${{ secrets.DESKTOP_APPLE_CERTIFICATE_PASSWORD }}',
      NOTARY_ISSUER_ID: '${{ secrets.DESKTOP_APPLE_NOTARY_ISSUER_ID }}',
      NOTARY_KEY_ID: '${{ secrets.DESKTOP_APPLE_NOTARY_KEY_ID }}',
      NOTARY_KEY_P8_BASE64: '${{ secrets.DESKTOP_APPLE_NOTARY_KEY_P8_BASE64 }}',
      SIGNING_IDENTITY: '${{ vars.DESKTOP_APPLE_SIGNING_IDENTITY }}',
      TEAM_ID: '${{ vars.DESKTOP_APPLE_TEAM_ID }}',
    })
    expect(packageRelease?.run).toContain('pnpm run desktop:package-release')
    expect(packageRelease?.run).toContain('--notary-profile "$DSH_NOTARY_PROFILE"')
    expect(packageRelease?.run).toContain('--tag "$GITHUB_REF_NAME"')
    expect(cleanup?.if).toBe('always()')
    expect(steps.indexOf(cleanup)).toBeLessThan(steps.indexOf(publish))
    expect(publish?.env).toEqual({ GH_TOKEN: '${{ github.token }}' })
    expect(publishRun).toContain('git ls-remote --refs origin "refs/tags/$GITHUB_REF_NAME"')
    expect(publishRun).toContain('gh release create "${release_args[@]}"')
    expect(publishRun).toContain('--draft')
    expect(publishRun).toContain('release.isDraft !== true')
    expect(publishRun).toContain('gh release download "$GITHUB_REF_NAME" --dir "$retry_root"')
    expect(publishRun).toContain('cmp "$RELEASE_OUTPUT/$asset" "$retry_root/$asset"')
    expect(publishRun).toContain('gh release edit "$GITHUB_REF_NAME" --verify-tag --draft=false')
    const assetArgumentPattern = [
      'release_args\\+=\\(',
      '\\s+"\\$RELEASE_OUTPUT/\\$dmg_name"',
      '\\s+"\\$RELEASE_OUTPUT/SHA256SUMS"',
      '\\s+"\\$RELEASE_OUTPUT/release-manifest\\.json"',
      '\\s+\\)',
    ].join('')
    expect(publishRun).toMatch(new RegExp(assetArgumentPattern, 'u'))
  })
})

describe('Documentation workflow', () => {
  it('verifies the site without retaining a Pages publication capability', () => {
    const workflow = loadWorkflow('.github/workflows/docs-pages.yml')
    const verify = workflowJob(workflow, 'verify')
    if (!Array.isArray(verify.steps)) {
      throw new TypeError('Documentation workflow must define verification steps')
    }

    expect(workflow.name).toBe('Documentation')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.concurrency).toBeUndefined()
    if (!isRecord(workflow.jobs)) throw new TypeError('Documentation workflow must define jobs')
    expect(workflow.jobs).not.toHaveProperty('publish')
    expect(workflow.jobs).not.toHaveProperty('deploy')
    expect(verify.if).toBeUndefined()
    expect(verify.permissions).toEqual({ contents: 'read' })
    expect(verify.steps.filter(isRecord).find(step => step.uses === 'pnpm/action-setup@v6')).toMatchObject({
      with: {
        dest: runnerPrivatePnpmDestination,
        version: '11.7.0',
      },
    })
    expect(verify.steps.filter(isRecord).find(step => step.name === 'Install (immutable)')).toMatchObject({
      run: 'pnpm install --frozen-lockfile',
    })
    expect(verify.steps.filter(isRecord).find(step => step.name === 'Verify and build documentation')).toMatchObject({
      env: { DOCS_BASE: '/' },
      run: 'pnpm run doc-sync',
    })
    const serialized = JSON.stringify(workflow)
    expect(serialized).not.toContain('actions/configure-pages@')
    expect(serialized).not.toContain('actions/upload-pages-artifact@')
    expect(serialized).not.toContain('actions/deploy-pages@')
    expect(serialized).not.toContain('pages:')
    expect(serialized).not.toContain('id-token:')
  })
})

describe('CI workflow', () => {
  it('pins every workflow pnpm setup to a private pnpm 11 installation', () => {
    const setups = workflowActionSteps('pnpm/action-setup@')

    expect(setups.length).toBeGreaterThan(0)
    for (const step of setups) {
      expect(step.uses).toBe('pnpm/action-setup@v6')
      expect(step).toMatchObject({
        with: {
          dest: runnerPrivatePnpmDestination,
          version: '11.7.0',
        },
      })
    }
  })

  it('keeps every workflow checkout free of persistent credentials', () => {
    const checkouts = workflowActionSteps('actions/checkout@')

    expect(checkouts.length).toBeGreaterThan(0)
    for (const checkout of checkouts) {
      expect(checkout).toMatchObject({
        with: { 'persist-credentials': false },
      })
    }
  })

  it('keeps one GitHub-hosted blocking topology on every CI event', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs)) throw new TypeError('CI workflow must define jobs')

    const blockingJobs = ['linux', 'node-compat', 'python-sdk', 'python-runtime', 'windows'] as const
    expect(Object.keys(workflow.jobs).sort()).toEqual([...blockingJobs, 'all-checks-passed'].sort())

    for (const name of blockingJobs) {
      expect(workflowJob(workflow, name).if).toBeUndefined()
    }

    const linux = workflowJob(workflow, 'linux')
    const nodeCompat = workflowJob(workflow, 'node-compat')
    const pythonRuntime = workflowJob(workflow, 'python-runtime')
    const windows = workflowJob(workflow, 'windows')
    const aggregate = workflowJob(workflow, 'all-checks-passed')
    if (!Array.isArray(linux.steps)
      || !isRecord(nodeCompat.strategy)
      || !Array.isArray(windows.steps)
      || !Array.isArray(aggregate.needs)
      || !Array.isArray(aggregate.steps)) {
      throw new TypeError('CI workflow must define Linux, Node compatibility, Windows, and aggregate configuration')
    }

    const linuxSteps = linux.steps.filter(isRecord)
    const windowsSteps = windows.steps.filter(isRecord)
    const aggregateSteps = aggregate.steps.filter(isRecord)
    expect(linux).toMatchObject({
      name: 'linux / node 24',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 110,
      env: {
        DSH_ARCHIVE_BASE_REF: '${{ github.event.pull_request.base.sha || github.event.before || github.sha }}',
        DSH_GATE_CONCURRENCY: '2',
        DSH_COVERAGE_MAX_WORKERS: '2',
        DSH_E2E_MAX_WORKERS: '2',
        DSH_OXLINT_THREADS: '2',
        DSH_PUBLINT_CONCURRENCY: '2',
        DSH_SNAPSHOT_MAX_CONCURRENCY: '2',
      },
    })
    expect(linuxSteps.find(step => step.uses === 'actions/checkout@v6')).toMatchObject({
      with: {
        'fetch-depth': 0,
        'persist-credentials': false,
      },
    })
    const linuxPrimary = linuxSteps.find(step => step.name === 'Run Linux primary gates')
    const playwrightInstall = linuxSteps.find(step => step.name === 'Install Playwright Chromium and system dependencies')
    const webSnapshot = linuxSteps.find(step => step.name === 'Run Web browser snapshot')
    if (linuxPrimary === undefined || playwrightInstall === undefined || webSnapshot === undefined) {
      throw new TypeError('Linux CI must sequence primary gates, Chromium provisioning, and Web replay')
    }
    expect(playwrightInstall).toMatchObject({
      run: 'pnpm --filter @deepseek-ai/dsh-web-frontend exec playwright install --with-deps chromium',
    })
    expect(linuxSteps.find(step => step.name === 'Prepare bubblewrap')).toMatchObject({
      run: 'bash scripts/prepare-ci-bubblewrap.sh',
    })
    expect(linuxPrimary).toMatchObject({
      'timeout-minutes': 50,
      run: 'pnpm run check:ci',
    })
    expect(webSnapshot).toMatchObject({
      'timeout-minutes': 30,
      env: { DSH_SNAPSHOT: 'replay' },
      run: 'pnpm run test:web:built',
    })
    expect(linuxSteps.indexOf(linuxPrimary)).toBeLessThan(linuxSteps.indexOf(playwrightInstall))
    expect(linuxSteps.indexOf(playwrightInstall)).toBeLessThan(linuxSteps.indexOf(webSnapshot))
    expect(linux['timeout-minutes']).toBeGreaterThan(
      Number(linuxPrimary['timeout-minutes']) + Number(webSnapshot['timeout-minutes']),
    )

    expect(nodeCompat).toMatchObject({
      'runs-on': 'ubuntu-latest',
      strategy: {
        'fail-fast': false,
        matrix: { node: ['22.19', '26'] },
      },
    })
    expect(pythonRuntime).toMatchObject({
      name: 'python runtime / release-shaped Linux x64',
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24.19.0-linux-x64',
        ci: true,
      },
    })

    expect(windows).toMatchObject({
      name: 'windows / node 24',
      'runs-on': 'windows-latest',
    })
    expect(windowsSteps.find(step => step.name === 'Install (immutable)')).toMatchObject({
      shell: 'pwsh',
      run: 'pnpm install --frozen-lockfile',
    })
    expect(windowsSteps.find(step => step.name === 'Verify native Windows gate process lifecycle')).toMatchObject({
      shell: 'pwsh',
      run: 'pnpm exec vitest run scripts/run-gates.spec.ts',
    })
    expect(windowsSteps.find(step => step.name === 'Run native Windows blocking gates')).toMatchObject({
      shell: 'pwsh',
      run: 'pnpm run check:ci:windows-blocking',
    })

    expect(aggregate).toMatchObject({
      'runs-on': 'ubuntu-latest',
      if: 'always()',
      needs: [...blockingJobs],
    })
    const failedAggregate = aggregateSteps.find(step => step.name === 'Fail if any needed job did not succeed')
    const successfulAggregate = aggregateSteps.find(step => step.name === 'All checks passed')
    if (failedAggregate === undefined
      || successfulAggregate === undefined
      || typeof failedAggregate.if !== 'string'
      || typeof failedAggregate.run !== 'string'
      || typeof successfulAggregate.run !== 'string') {
      throw new TypeError('CI aggregate must report failed and successful outcomes')
    }
    for (const result of ['failure', 'cancelled', 'skipped']) {
      expect(failedAggregate.if).toContain(`contains(needs.*.result, '${result}')`)
    }
    expect(failedAggregate.run).toContain('exit 1')
    expect(successfulAggregate.name).toBe('All checks passed')
    expect(successfulAggregate.run).toContain('All needed jobs succeeded')

    const serialized = JSON.stringify(workflow)
    for (const obsoleteTopology of ['self-hosted', 'DSH_CI_FAILOVER', 'wine', 'benchmark', 'serial-']) {
      expect(serialized).not.toContain(obsoleteTopology)
    }
  })

  it('cancels every superseded run', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.concurrency) || !isRecord(workflow.on)) {
      throw new TypeError('CI workflow must define workflow-level concurrency and events')
    }

    expect(workflow.concurrency).toEqual({
      group: '${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': true,
    })
    expect(workflowEvent(workflow, 'push')).toEqual({ branches: ['master'] })
    expect(workflow.on.pull_request).toBeNull()
    expect(workflow.on.workflow_dispatch).toBeNull()
  })

  it('keeps Wine diagnostic-only and points sandbox CI to the hosted topology record', () => {
    const wineDiagnostic = readFileSync(resolve(root, 'scripts/wine-windows-gates.sh'), 'utf8')
    const sandboxWorkflow = readFileSync(resolve(root, '.github/workflows/sandbox.yml'), 'utf8')
    const topologyRecord = '.agents/notes/implemented/process/2026-08-14-independent-desktop-github-hosted-ci.md'

    expect(wineDiagnostic).toContain('Run the explicit `pnpm run check:windows-wine` diagnostic')
    expect(wineDiagnostic).toContain('`windows-latest` under `pwsh`')
    expect(wineDiagnostic).toContain(topologyRecord)
    expect(wineDiagnostic).not.toContain('pull-request `windows` job')
    expect(sandboxWorkflow).toContain(topologyRecord)
    expect(sandboxWorkflow).not.toContain('2026-07-21-serial-cross-platform-ci-reference.md')
  })

  it('keeps supported LSP source under native Windows coverage', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain('packages/lsp/lsp-stdio/src/connection.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/index.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/instance.ts')
  })

  it('requires one release-shaped Python runtime target on every CI event', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const pythonRuntime = workflowJob(workflow, 'python-runtime')
    const aggregate = workflowJob(workflow, 'all-checks-passed')
    if (!Array.isArray(aggregate.needs)) {
      throw new TypeError('CI aggregate must define required job dependencies')
    }

    expect(pythonRuntime).toMatchObject({
      name: 'python runtime / release-shaped Linux x64',
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24.19.0-linux-x64',
        ci: true,
      },
    })
    expect(pythonRuntime.if).toBeUndefined()
    expect(aggregate.needs).toContain('python-runtime')
  })

  it('keeps every Vitest project process-isolated on native Windows', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain("pool: process.platform === 'win32' ? 'threads' : 'forks'")
    expect(config.match(/pool: 'forks'/g)).toHaveLength(2)
  })
})

describe('Real API e2e workflow', () => {
  it('is manual-only and scopes the key to the two credentialed steps', () => {
    const workflow = loadWorkflow('.github/workflows/e2e.yml')
    expect(workflow.on).toEqual({ workflow_dispatch: null })
    const e2e = workflowJob(workflow, 'e2e')
    if (!Array.isArray(e2e.steps)) throw new TypeError('Real API e2e workflow must define the e2e job steps')
    const steps = e2e.steps.filter(isRecord)
    const preflight = steps.find(step => step.name === 'Preflight (require DEEPSEEK API key)')
    const e2eTests = steps.find(step => step.name === 'E2E tests (real DeepSeek API)')
    const secretSteps = steps.filter(step => JSON.stringify(step).includes('DEEPSEEK_API_KEY_EXTERNAL'))

    expect(e2e.environment).toBeUndefined()
    expect(e2e.env).toBeUndefined()
    expect(steps.find(step => step.uses === 'pnpm/action-setup@v6')).toMatchObject({
      with: {
        dest: runnerPrivatePnpmDestination,
        version: '11.7.0',
      },
    })
    expect(secretSteps.map(step => step.name)).toEqual([
      'Preflight (require DEEPSEEK API key)',
      'E2E tests (real DeepSeek API)',
    ])
    expect(preflight).toMatchObject({
      env: { DEEPSEEK_API_KEY: '${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}' },
    })
    expect(preflight?.run).toContain('Configure the DEEPSEEK_API_KEY_EXTERNAL repository secret.')
    expect(e2eTests).toMatchObject({
      env: {
        DEEPSEEK_API_KEY: '${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}',
        DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
        DSH_E2E_MAX_WORKERS: '14',
        DSH_EXAMPLE_MODE: 'lib',
      },
      run: 'pnpm run test:e2e',
    })
  })
})

describe('E2B e2e workflow', () => {
  it('is manual-only and fails loud before running the focused live suite', () => {
    const workflow = loadWorkflow('.github/workflows/e2b-e2e.yml')
    expect(workflow.on).toEqual({ workflow_dispatch: null })
    if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs.e2b) || !Array.isArray(workflow.jobs.e2b.steps)) {
      throw new TypeError('E2B e2e workflow must define the e2b job steps')
    }

    const steps = workflow.jobs.e2b.steps.filter(isRecord)
    const preflight = steps.find(step => step.name === 'Preflight (require E2B API key)')
    const e2b = steps.find(step => step.name === 'E2B tests (live sandbox)')

    expect(preflight).toMatchObject({
      env: { E2B_API_KEY: '${{ secrets.E2B_API_KEY_EXTERNAL }}' },
    })
    expect(preflight?.run).toContain('E2B_API_KEY_EXTERNAL repository secret')
    expect(e2b).toMatchObject({
      env: {
        E2B_API_KEY: '${{ secrets.E2B_API_KEY_EXTERNAL }}',
        DSH_E2E_MAX_WORKERS: '1',
        DSH_EXAMPLE_MODE: 'lib',
      },
    })
    expect(e2b?.run).toContain('packages/e2b/e2b/tests/composition.e2e.ts')
  })
})

describe('Python release workflows', () => {
  it('keeps complete wheel validation separate from protected public publication', () => {
    const workflow = loadWorkflow('.github/workflows/python-release.yml')
    const dispatch = workflowEvent(workflow, 'workflow_dispatch')
    const pullRequest = workflowEvent(workflow, 'pull_request')
    const build = workflowJob(workflow, 'build')
    const pythonCompat = workflowJob(workflow, 'python-compat')
    const validate = workflowJob(workflow, 'validate')
    const publishRuntime = workflowJob(workflow, 'publish-runtime')
    const publishSdk = workflowJob(workflow, 'publish-sdk')
    if (!isRecord(dispatch.inputs)
      || !isRecord(dispatch.inputs.publish)
      || !Array.isArray(pythonCompat.steps)
      || !Array.isArray(validate.steps)
      || !Array.isArray(publishRuntime.steps)
      || !Array.isArray(publishSdk.steps)) {
      throw new TypeError('Python release workflow must define publish input and release steps')
    }

    expect(dispatch.inputs.publish).toMatchObject({ type: 'boolean', default: false })
    expect(pullRequest).toEqual({ types: ['labeled'] })
    expect(build).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' || github.event.label.name == 'python-release-dry-run'",
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24.19.0-linux-x64,node24.19.0-linux-arm64,node24.19.0-macos-arm64',
        release: true,
      },
    })
    expect(pythonCompat.strategy).toMatchObject({ matrix: { python: ['3.10', '3.14'] } })
    expect(JSON.stringify(pythonCompat.steps)).toContain('deepseek-harness-sdk==${{ steps.compatibility-version.outputs.version }}')
    const validateSteps = JSON.stringify(validate.steps)
    const authorize = validate.steps.filter(isRecord).find(step => step.name === 'Authorize publication request')
    if (!isRecord(authorize) || typeof authorize.run !== 'string') {
      throw new TypeError('Python release validation must authorize publication requests')
    }
    expect(validateSteps).toContain('PUBLIC_PYPI_RELEASE_ENABLED')
    expect(authorize).toMatchObject({
      env: {
        PYPI_PUBLISHER_REPOSITORY: '${{ vars.PYPI_PUBLISHER_REPOSITORY }}',
        REPOSITORY: '${{ github.repository }}',
      },
    })
    expect(authorize.run).toContain('[ "$REPOSITORY" = "$PYPI_PUBLISHER_REPOSITORY" ]')
    expect(validateSteps).toContain('100000000')
    expect(publishRuntime).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: 'validate',
      environment: 'pypi-runtime',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    expect(publishSdk).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: ['validate', 'publish-runtime'],
      environment: 'pypi',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    const runtimeSteps = publishRuntime.steps.filter(isRecord)
    const sdkSteps = publishSdk.steps.filter(isRecord)
    const runtimePublish = runtimeSteps.find(step => step.name === 'Publish runtime wheels')
    const sdkPublish = sdkSteps.find(step => step.name === 'Publish SDK wheel')
    const runtimeHashes = runtimeSteps.find(step => step.name === 'Verify release artifact hashes')
    const sdkHashes = sdkSteps.find(step => step.name === 'Verify release artifact hashes')
    expect([...runtimeSteps, ...sdkSteps].some(
      step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )).toBe(false)
    expect([...runtimeSteps, ...sdkSteps].filter(
      step => step.uses === 'pypa/gh-action-pypi-publish@release/v1',
    )).toHaveLength(2)
    expect(runtimePublish).toMatchObject({
      with: { 'packages-dir': 'dist/runtime/', attestations: false },
    })
    expect(sdkPublish).toMatchObject({
      with: { 'packages-dir': 'dist/sdk/', attestations: false },
    })
    expect(runtimeHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
    expect(sdkHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
  })

  it('exposes the native wheel builder to the release caller with normalized versions and non-persistent checkouts', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    const call = workflowEvent(workflow, 'workflow_call')
    const plan = workflowJob(workflow, 'plan')
    const sdkWheel = workflowJob(workflow, 'sdk-wheel')
    const build = workflowJob(workflow, 'build')
    if (!isRecord(call.inputs) || !Array.isArray(plan.steps) || !Array.isArray(sdkWheel.steps) || !Array.isArray(build.steps)) {
      throw new TypeError('Python wheel builder must define workflow_call inputs and plan, SDK wheel, and build steps')
    }

    const buildSteps: unknown[] = build.steps
    const checkoutSteps = [plan.steps, sdkWheel.steps, build.steps]
      .flat()
      .filter(isRecord)
      .filter(step => step.uses === 'actions/checkout@v6')
    const pnpmSetup = buildSteps.find(step => isRecord(step) && step.uses === 'pnpm/action-setup@v6')
    const manylinuxAddon = buildSteps.find(step => isRecord(step) && step.name === 'Rebuild Linux node-pty against manylinux 2.28')
    const macosCheck = buildSteps.find(step => isRecord(step) && step.name === 'Check macOS deployment target')
    const manylinuxSmoke = buildSteps.find(step => isRecord(step) && step.name === 'Run wheel in a manylinux 2.28 container')
    expect(call.inputs).toHaveProperty('targets')
    expect(call.inputs).toMatchObject({
      ci: { type: 'boolean', default: false },
      release: { type: 'boolean', default: false },
    })
    expect(workflow.concurrency).toMatchObject({
      group: 'build-single-exe-${{ github.workflow }}-${{ github.ref }}',
    })
    expect(plan.if).toContain('inputs.ci')
    expect(plan.if).toContain('inputs.release')
    expect(JSON.stringify(plan.steps)).toContain('pep440_version')
    expect(JSON.stringify(workflow)).toContain('macosx_14_0_arm64')
    expect(checkoutSteps).toHaveLength(3)
    for (const checkout of checkoutSteps) {
      expect(checkout).toMatchObject({
        uses: 'actions/checkout@v6',
        with: { 'persist-credentials': false },
      })
    }
    expect(pnpmSetup).toMatchObject({
      with: {
        dest: runnerPrivatePnpmDestination,
        version: '11.7.0',
      },
    })
    expect(manylinuxAddon).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_x86_64')
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_aarch64')
    expect(JSON.stringify(manylinuxAddon)).toContain('$RUNNER_TEMP/setup-pnpm:$RUNNER_TEMP/setup-pnpm:ro')
    expect(JSON.stringify(manylinuxAddon)).not.toContain('$HOME/setup-pnpm')
    expect(JSON.stringify(manylinuxAddon)).toContain('node-pty-glibc-versions.txt')
    expect(JSON.stringify(manylinuxAddon)).toContain('le 2.28')
    expect(macosCheck).toMatchObject({ if: "runner.os == 'macOS'" })
    expect(JSON.stringify(macosCheck)).toContain('scripts/check-macos-deployment-target.py')
    expect(JSON.stringify(macosCheck)).toContain('$EXE-spawn-helper')
    expect(manylinuxSmoke).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxSmoke)).toContain('-e DSH_TELEMETRY_DISABLED')
  })

  it('uses the shared macOS deployment-target check in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const runtimeWheel = workflow['.runtime-wheel']
    if (!isRecord(runtimeWheel) || !Array.isArray(runtimeWheel.script)) {
      throw new TypeError('GitLab CI must define the runtime wheel script')
    }
    const runtimeScript: unknown[] = runtimeWheel.script
    const macosCheck = runtimeScript.find(
      step => typeof step === 'string' && step.includes('PLATFORM" = macos-arm64'),
    )
    if (typeof macosCheck !== 'string') {
      throw new TypeError('GitLab CI must check the macOS deployment target')
    }

    expect(macosCheck).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck).toContain('"$EXE" "$EXE-spawn-helper"')
  })
})

describe('Issue lifecycle workflow', () => {
  it('uses explicit review handoff events without rerunning when a draft becomes ready', () => {
    const lifecycle = loadWorkflow('.github/workflows/issue-lifecycle.yml')
    const lifecyclePullRequest = workflowEvent(lifecycle, 'pull_request')
    const lifecycleReview = workflowEvent(lifecycle, 'pull_request_review')
    const lifecycleJob = workflowJob(lifecycle, 'lifecycle')
    const policy = loadWorkflow('.github/workflows/issue-policy.yml')
    const policyPullRequest = workflowEvent(policy, 'pull_request')

    expect(lifecyclePullRequest.types).not.toContain('ready_for_review')
    expect(lifecyclePullRequest.types).toContain('review_requested')
    expect(lifecycleReview.types).toEqual(['submitted'])
    expect(lifecycleJob.if).toBe(
      "${{ github.event_name != 'pull_request_review' || (github.event.action == 'submitted' && github.event.review.state == 'changes_requested') }}",
    )
    expect(policyPullRequest.types).toContain('ready_for_review')
  })
})

describe('Git hooks', () => {
  it('leaves frozen Agent Note sidecars to the archive verifier', () => {
    const lefthook = loadWorkflow('lefthook.yml')

    for (const hookName of ['pre-commit', 'pre-merge-commit']) {
      const hook = lefthook[hookName]
      if (!isRecord(hook) || !Array.isArray(hook.jobs)) {
        throw new TypeError(`lefthook must define ${hookName} jobs`)
      }
      const pairing: unknown = hook.jobs.find(
        (job: unknown) => isRecord(job) && job.name === 'translation pairing (staged records)',
      )

      expect(pairing).toMatchObject({ exclude: ['.agents/notes/archived/**'] })
    }
  })
})

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function workflowEvent(workflow: Record<string, unknown>, event: string): Record<string, unknown> {
  if (!isRecord(workflow.on) || !isRecord(workflow.on[event])) {
    throw new TypeError(`workflow must define the ${event} event`)
  }
  return workflow.on[event]
}

function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

function workflowActionSteps(actionPrefix: string): Record<string, unknown>[] {
  return workflowPaths.flatMap((workflowPath) => {
    const workflow = loadWorkflow(workflowPath)
    if (!isRecord(workflow.jobs)) return []
    return Object.values(workflow.jobs).flatMap((job) => {
      if (!isRecord(job) || !Array.isArray(job.steps)) return []
      return job.steps.filter((step): step is Record<string, unknown> => (
        isRecord(step) && typeof step.uses === 'string' && step.uses.startsWith(actionPrefix)
      ))
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
