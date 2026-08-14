/**
 * Build the sealed Node 24 SEA sidecar consumed by the Tauri Desktop shell.
 *
 * The sidecar serves the existing `dsh web` application. Tauri owns only the
 * executable and native resource placement; its Rust host injects their final
 * absolute paths when it starts the sidecar.
 */

import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import {
  REPOSITORY_ROOT,
  SEA_NODE_RANGE,
  SEA_PKG_SPEC,
  SeaTarget,
  SingleExeBuild,
  parseSeaBuildCli,
  seaRuntimeProvenance,
} from './single-exe-build.ts'
import {
  DESKTOP_LEGAL_RESOURCE_ROOT,
  ensureDesktopLegalResourceRoot,
  lockedSeaPacker,
  type LockedSeaPacker,
} from './prepare-desktop-release.ts'

const LABEL = 'build-desktop'
const DEPLOY_ROOT_PACKAGE = 'dsh-desktop-runtime-pkg'
const CLOSURE_MANIFEST = 'native/desktop-runtime/package.json'
const ENTRY_BIN = 'node_modules/@deepseek-ai/dsh/lib/packaged-desktop-bin.js'
const SIDECAR_BASENAME = 'dsh-desktop-runtime'
const DESKTOP_RUNTIME_DIR = 'native/desktop-runtime'
const DESKTOP_STAGING_DIR = join(DESKTOP_RUNTIME_DIR, '.artifacts', 'node')
const DESKTOP_HELPER_DIR = join(DESKTOP_RUNTIME_DIR, '.artifacts', 'helpers')
const TAURI_BINARIES_DIR = 'apps/desktop/src-tauri/binaries'
const TAURI_RESOURCE_DIR = 'apps/desktop/src-tauri/resources/runtime'

/**
 * pkg cannot infer Cordis's dynamic plugin loading. The Web runtime also reads
 * its shipped configuration, bundle patch YAML, and Vite output as files, so
 * those payloads are explicit rather than hoping static analysis retains them.
 */
const DESKTOP_ASSET_GLOBS = [
  'package.json',
  'node_modules/**/*.js',
  'node_modules/**/*.cjs',
  'node_modules/**/*.mjs',
  'node_modules/**/*.css',
  'node_modules/**/package.json',
  'node_modules/**/*.json',
  'node_modules/**/*.yml',
  'node_modules/**/*.yaml',
  'node_modules/**/*.node',
  // pkg extracts the complete native-addon's package scope before dlopen, so
  // dependent shared libraries must be present in that virtual scope too.
  'node_modules/**/*.dylib',
  'node_modules/**/*.so',
  'node_modules/**/*.so.*',
  'node_modules/**/*.wasm',
  // Includes the shipped agent-preset YAML and the Cordis preset's SKILL.md
  // files without embedding every package README in the SEA filesystem.
  'node_modules/@deepseek-ai/dsh/config/**/*',
  // The skill-badge provider reads its Markdown and exposes its image assets
  // through the skill catalog rather than importing either into its JS bundle.
  'node_modules/@deepseek-ai/dsh-skill-badge/assets/**/*',
  // Vite names scripts, styles, fonts, and images by content hash, so the
  // complete frontend directory is the one correct closed-world asset unit.
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/**/*',
]

function usage(): string {
  return [
    'Usage: pnpm exec tsx scripts/build-desktop.ts [flags]',
    '',
    `  --targets=<target>     one host-matching pkg target, e.g. ${SEA_NODE_RANGE}-macos-arm64.`,
    `                         Default: the host platform only (on ${SEA_NODE_RANGE}).`,
    '  --skip-build           skip `pnpm run build` (lib/ and web dist must already exist).',
    '  --dry-run              print every command and artifact copy without executing.',
    '  --help                 print this help.',
    '',
    `Build route: ${SEA_PKG_SPEC} --sea. Native node-pty and ripgrep resources require a host-matching ${SEA_NODE_RANGE} target.`,
    `Writes the Tauri sidecar to ${TAURI_BINARIES_DIR}/ and resources to ${TAURI_RESOURCE_DIR}/.`,
  ].join('\n')
}

/**
 * Map one pkg platform and architecture pair to Tauri's sidecar suffix.
 * @param target - SEA target to package.
 * @returns Tauri target triple.
 */
function tauriTargetTriple(target: SeaTarget): string {
  if (target.platform === 'macos') {
    return target.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  }
  return target.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
}

/**
 * Reject target combinations whose native helper and ripgrep payload cannot be
 * produced by this host installation.
 * @param target - parsed SEA target.
 */
function validateDesktopTarget(target: SeaTarget): void {
  if (target.nodeRange !== SEA_NODE_RANGE) {
    throw new Error(`${LABEL}: desktop sidecars require ${SEA_NODE_RANGE}, got ${target.nodeRange}.`)
  }
  const host = SeaTarget.host(LABEL)
  if (target.platform !== host.platform || target.arch !== host.arch) {
    throw new Error(
      `${LABEL}: native node-pty and ripgrep resources require a host-matching target; `
      + `target ${target.platform}-${target.arch} does not match host ${host.platform}-${host.arch}.`,
    )
  }
}

/**
 * Name ripgrep's target-specific npm package for this SEA target.
 * @param target - SEA target whose native search executable is copied.
 * @returns package subpath resolving to its executable.
 */
function ripgrepSpecifier(target: SeaTarget): string {
  const platform = target.platform === 'macos' ? 'darwin' : 'linux'
  return `@vscode/ripgrep-${platform}-${target.arch}/bin/rg`
}

/**
 * Render the expected staged ripgrep path for dry-run output.
 * @param staging - deployed closure root.
 * @param target - SEA target whose package is staged.
 * @returns conventional hoisted package path.
 */
function expectedRipgrepSource(staging: string, target: SeaTarget): string {
  const platform = target.platform === 'macos' ? 'darwin' : 'linux'
  return join(staging, 'node_modules', '@vscode', `ripgrep-${platform}-${target.arch}`, 'bin', 'rg')
}

/**
 * Resolve ripgrep from the deployed closure rather than relying on pnpm's
 * internal hoist layout.
 * @param staging - deployed closure root.
 * @param target - SEA target whose package is resolved.
 * @returns absolute executable path in the staging tree.
 */
function resolveRipgrepSource(staging: string, target: SeaTarget): string {
  const specifier = ripgrepSpecifier(target)
  try {
    return createRequire(join(staging, 'package.json')).resolve(specifier)
  } catch (error) {
    throw new Error(
      `${LABEL}: staged closure does not contain ${specifier}; `
      + `the optional @vscode/ripgrep platform package is required for ${target.platform}-${target.arch}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Copy native executables out of pkg's virtual filesystem into Tauri resources.
 * @param pipeline - shared SEA pipeline owning the deployed closure.
 * @param target - target whose resource paths are written.
 * @param spawnHelper - macOS helper generated beside the SEA product, when present.
 * @returns final resource paths for artifact reporting.
 */
async function syncTauriResources(
  pipeline: SingleExeBuild,
  target: SeaTarget,
  spawnHelper: string | undefined,
): Promise<string[]> {
  const triple = tauriTargetTriple(target)
  const resourceDir = resolve(REPOSITORY_ROOT, TAURI_RESOURCE_DIR, triple)
  const ripgrepDestination = join(resourceDir, 'rg')
  const helperDestination = join(resourceDir, 'spawn-helper')
  if (pipeline.cli.dryRun) {
    console.log(`${LABEL}: [dry-run] cp ${expectedRipgrepSource(pipeline.staging, target)} ${ripgrepDestination}`)
    if (spawnHelper !== undefined) console.log(`${LABEL}: [dry-run] cp ${spawnHelper} ${helperDestination}`)
    return spawnHelper === undefined ? [ripgrepDestination] : [ripgrepDestination, helperDestination]
  }
  await mkdir(resourceDir, { recursive: true })
  await copyFile(resolveRipgrepSource(pipeline.staging, target), ripgrepDestination)
  await chmod(ripgrepDestination, 0o755)
  if (spawnHelper === undefined) return [ripgrepDestination]
  await copyFile(spawnHelper, helperDestination)
  await chmod(helperDestination, 0o755)
  return [ripgrepDestination, helperDestination]
}

/**
 * Record the exact verified Node archive consumed by the SEA packer.
 * @param pipeline - active Desktop build.
 * @param target - completed SEA target.
 * @returns generated provenance path.
 */
async function writeRuntimeProvenance(
  pipeline: SingleExeBuild,
  target: SeaTarget,
  packer: LockedSeaPacker,
): Promise<string> {
  const triple = tauriTargetTriple(target)
  const path = resolve(REPOSITORY_ROOT, TAURI_RESOURCE_DIR, triple, 'sea-provenance.json')
  if (pipeline.cli.dryRun) {
    console.log(`${LABEL}: [dry-run] write ${path}`)
    return path
  }
  const provenance = seaRuntimeProvenance(pipeline.seaRuntime(target), triple, {
    declared: packer.declared,
    patchHash: packer.patchHash,
  })
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(provenance, null, 2)}\n`)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
  return path
}

async function main(): Promise<void> {
  const cli = parseSeaBuildCli(process.argv.slice(2), {
    label: LABEL,
    usage: usage(),
    validateTarget: validateDesktopTarget,
  })
  const pipeline = new SingleExeBuild({
    label: LABEL,
    deployRootPackage: DEPLOY_ROOT_PACKAGE,
    closureManifest: CLOSURE_MANIFEST,
    flatWorkspaceClosure: true,
    entryBin: ENTRY_BIN,
    staging: resolve(REPOSITORY_ROOT, DESKTOP_STAGING_DIR),
    outputDir: resolve(REPOSITORY_ROOT, TAURI_BINARIES_DIR),
    outputName: target => `${SIDECAR_BASENAME}-${tauriTargetTriple(target)}`,
    assets: DESKTOP_ASSET_GLOBS,
    spawnHelperOutput: target => resolve(REPOSITORY_ROOT, DESKTOP_HELPER_DIR, `${SIDECAR_BASENAME}-${tauriTargetTriple(target)}-spawn-helper`),
  }, cli)
  const packer = lockedSeaPacker()
  console.log(`${LABEL}: targets: ${cli.targets.map(target => target.spec).join(', ')}`)
  console.log(`${LABEL}: staging: ${pipeline.staging}`)
  if (cli.dryRun) {
    console.log(`${LABEL}: [dry-run] mkdir ${resolve(REPOSITORY_ROOT, DESKTOP_LEGAL_RESOURCE_ROOT)}`)
  } else {
    await ensureDesktopLegalResourceRoot(REPOSITORY_ROOT)
  }
  await pipeline.verifyClosure()
  await pipeline.build()
  await pipeline.deployStaging()
  await pipeline.injectPkgConfig()
  const products: string[] = []
  for (const target of cli.targets) {
    const artifact = await pipeline.pack(target)
    products.push(
      artifact.executable,
      ...await syncTauriResources(pipeline, target, artifact.spawnHelper),
      await writeRuntimeProvenance(pipeline, target, packer),
    )
  }
  pipeline.printProducts(products)
}

await main()
