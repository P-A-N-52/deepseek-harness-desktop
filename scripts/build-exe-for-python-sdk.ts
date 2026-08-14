/**
 * Build the SDK runtime executables and Python node carrier. The fixed
 * `@yao-pkg/pkg --sea` route, deploy flags, and artifact layout are owned by
 * .agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md.
 * The shared pipeline keeps this product's closure symlink-free while this
 * wrapper preserves its Python-specific carrier and upload layout.
 */

import { statSync } from 'node:fs'
import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  REPOSITORY_ROOT,
  SEA_NODE_RANGE,
  SEA_PKG_SPEC,
  SingleExeBuild,
  parseSeaBuildCli,
  seaArtifactPaths,
} from './single-exe-build.ts'

/** The closure manifest whose dependencies define the executable. */
const DEPLOY_ROOT_PACKAGE = 'dsh-jsonrpc-agent-pkg'
/** The closed-runtime app entry inside the deployed closure. */
const ENTRY_BIN = 'node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js'
const OUTPUT_BASENAME = 'dsh-jsonrpc-agent-pkg'
const OUT_DIR = 'dist-exe'
/** Python package destination; created when absent. */
const PYTHON_RUNTIME_DIR = 'python/sdk-runtime/src/deepseek_harness_runtime/runtime'
/** The deployed closure doubles as the node-mode carrier. */
const PYTHON_NODE_SUBDIR = 'node'

/**
 * Whole-tree assets cover Cordis's runtime bare-package imports, which pkg's
 * static analysis cannot see. Package manifests are explicit because bare-name
 * resolution depends on them.
 */
const ASSET_GLOBS = [
  'package.json',
  'node_modules/**/*.js',
  'node_modules/**/*.cjs',
  'node_modules/**/*.mjs',
  'node_modules/**/package.json',
  'node_modules/**/*.json',
  'node_modules/**/*.node',
  'node_modules/**/*.wasm',
]

function usage(): string {
  return [
    'Usage: pnpm exec tsx scripts/build-exe-for-python-sdk.ts [flags]',
    '',
    `  --targets=<t1,t2,...>  pkg targets, e.g. ${SEA_NODE_RANGE}-linux-x64,${SEA_NODE_RANGE}-linux-arm64,${SEA_NODE_RANGE}-macos-arm64.`,
    `                         Default: the host platform only (on ${SEA_NODE_RANGE}).`,
    '  --skip-build           skip `pnpm run build` (lib/ artifacts must already exist).',
    '  --dry-run              print every command and config patch without executing.',
    '  --help                 print this help.',
    '',
    `Build route: ${SEA_PKG_SPEC} --sea; see .agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md.`,
    `Stages the node carrier in ${PYTHON_RUNTIME_DIR}/${PYTHON_NODE_SUBDIR} and writes executables to ${OUT_DIR}/.`,
  ].join('\n')
}

/**
 * Copy each product into the Python runtime package. The deployed node carrier
 * is already in place, and `dist-exe/` retains upload copies.
 * @param products - compiled executable and helper paths.
 * @param dryRun - whether to print instead of copying.
 */
async function syncToPythonRuntime(products: readonly string[], dryRun: boolean): Promise<void> {
  const destDir = resolve(REPOSITORY_ROOT, PYTHON_RUNTIME_DIR)
  if (dryRun) {
    for (const path of products) {
      console.log(`build-exe-for-python-sdk: [dry-run] cp ${path} ${join(destDir, basename(path))}`)
    }
    return
  }
  await mkdir(destDir, { recursive: true })
  for (const path of products) {
    const destination = join(destDir, basename(path))
    await copyFile(path, destination)
    await chmod(destination, statSync(path).mode & 0o777)
    console.log(`build-exe-for-python-sdk: synced ${destination}`)
  }
}

async function main(): Promise<void> {
  const cli = parseSeaBuildCli(process.argv.slice(2), {
    label: 'build-exe-for-python-sdk',
    usage: usage(),
  })
  const pipeline = new SingleExeBuild({
    label: 'build-exe-for-python-sdk',
    deployRootPackage: DEPLOY_ROOT_PACKAGE,
    entryBin: ENTRY_BIN,
    staging: resolve(REPOSITORY_ROOT, PYTHON_RUNTIME_DIR, PYTHON_NODE_SUBDIR),
    outputDir: resolve(REPOSITORY_ROOT, OUT_DIR),
    outputName: target => `${OUTPUT_BASENAME}-${target.platform}-${target.arch}`,
    assets: ASSET_GLOBS,
  }, cli)
  console.log(`build-exe-for-python-sdk: targets: ${cli.targets.map(target => target.spec).join(', ')}`)
  console.log(`build-exe-for-python-sdk: staging: ${pipeline.staging}`)
  await pipeline.verifyClosure()
  await pipeline.build()
  await pipeline.deployStaging()
  await pipeline.injectPkgConfig()
  const products: string[] = []
  for (const target of cli.targets) products.push(...seaArtifactPaths(await pipeline.pack(target)))
  pipeline.printProducts(products)
  await syncToPythonRuntime(products, cli.dryRun)
}

await main()
