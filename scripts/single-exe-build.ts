/**
 * Shared Node SEA build machinery for closed Harness runtime products.
 *
 * Each product owns its deploy manifest, entry module, assets, and artifact
 * sink. This module owns the common closure materialization and fixed
 * `@yao-pkg/pkg --sea` invocation so products cannot drift in their native
 * addon or symlink handling.
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

/** Repository root, resolved from this shared script. */
export const REPOSITORY_ROOT = resolve(import.meta.dirname, '..')

/** Node range used by every first-party SEA runtime. */
export const SEA_NODE_RANGE = 'node24'

/** Pinned SEA packer for reproducible runtime products. */
export const SEA_PKG_SPEC = '@yao-pkg/pkg@6.21.0'

const PLATFORMS = ['linux', 'macos'] as const
const ARCHES = ['x64', 'arm64'] as const

/** Platform tags accepted by the packaged Node runtime. */
export type SeaPlatform = (typeof PLATFORMS)[number]

/** CPU tags accepted by the packaged Node runtime. */
export type SeaArch = (typeof ARCHES)[number]

function isPlatform(value: string): value is SeaPlatform {
  return (PLATFORMS as readonly string[]).includes(value)
}

function isArch(value: string): value is SeaArch {
  return (ARCHES as readonly string[]).includes(value)
}

/** One validated `@yao-pkg/pkg` target triple. */
export class SeaTarget {
  private constructor(
    /** pkg Node range (`node<major>`). */
    readonly nodeRange: string,
    /** pkg platform tag. */
    readonly platform: SeaPlatform,
    /** pkg CPU tag. */
    readonly arch: SeaArch,
  ) {}

  /** The pkg `--targets` string. */
  get spec(): string {
    return `${this.nodeRange}-${this.platform}-${this.arch}`
  }

  /**
   * Parse one explicit pkg target.
   * @param spec - raw target text such as `node24-macos-arm64`.
   * @param label - product prefix used in errors.
   * @returns its validated target.
   */
  static parse(spec: string, label: string): SeaTarget {
    const parts = spec.split('-')
    const [nodeRange, platform, arch] = parts
    if (parts.length !== 3 || nodeRange === undefined || platform === undefined || arch === undefined) {
      throw new Error(`${label}: target ${JSON.stringify(spec)} must be <nodeRange>-<platform>-<arch>, e.g. node24-linux-x64.`)
    }
    if (!/^node\d+$/.test(nodeRange)) {
      throw new Error(`${label}: target ${JSON.stringify(spec)}: node range must look like node24, got ${JSON.stringify(nodeRange)}.`)
    }
    if (!isPlatform(platform)) {
      throw new Error(`${label}: target ${JSON.stringify(spec)}: platform must be one of ${PLATFORMS.join(', ')}, got ${JSON.stringify(platform)}.`)
    }
    if (!isArch(arch)) {
      throw new Error(`${label}: target ${JSON.stringify(spec)}: arch must be one of ${ARCHES.join(', ')}, got ${JSON.stringify(arch)}.`)
    }
    return new SeaTarget(nodeRange, platform, arch)
  }

  /**
   * Resolve the current host to a default Node 24 SEA target.
   * @param label - product prefix used in errors.
   * @returns the host target.
   */
  static host(label: string): SeaTarget {
    const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : undefined
    if (platform === undefined) {
      throw new Error(`${label}: unsupported host platform ${process.platform}; pass --targets explicitly.`)
    }
    const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined
    if (arch === undefined) {
      throw new Error(`${label}: unsupported host arch ${process.arch}; pass --targets explicitly.`)
    }
    return new SeaTarget(SEA_NODE_RANGE, platform, arch)
  }
}

/** Parsed shared command-line flags for one SEA product. */
export interface SeaBuildCli {
  /** Targets to package. */
  readonly targets: readonly SeaTarget[]
  /** Skip `pnpm run build`; built artifacts must already exist. */
  readonly skipBuild: boolean
  /** Print every action instead of making filesystem or subprocess changes. */
  readonly dryRun: boolean
}

/** Product-specific parser details for {@link parseSeaBuildCli}. */
export interface SeaBuildCliSpec {
  /** Prefix used in errors and diagnostics. */
  readonly label: string
  /** Full help text. */
  readonly usage: string
  /** Optional product policy applied to every parsed target. */
  readonly validateTarget?: (target: SeaTarget) => void
}

/**
 * Parse the standard SEA build flags.
 * @param argv - command-line arguments after the script name.
 * @param spec - product-specific parser details.
 * @returns validated build options, or exits after help/a parse error.
 */
export function parseSeaBuildCli(argv: readonly string[], spec: SeaBuildCliSpec): SeaBuildCli {
  let values: {
    targets?: string
    'skip-build'?: boolean
    'dry-run'?: boolean
    help?: boolean
  }
  try {
    values = parseArgs({
      args: argv,
      options: {
        targets: { type: 'string' },
        'skip-build': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }).values
  } catch (error) {
    console.error(`${spec.label}: ${error instanceof Error ? error.message : String(error)}\n`)
    console.error(spec.usage)
    process.exit(1)
  }
  if (values.help === true) {
    console.log(spec.usage)
    process.exit(0)
  }
  const targets = values.targets === undefined
    ? [SeaTarget.host(spec.label)]
    : values.targets.split(',').map(part => part.trim()).filter(part => part !== '').map(target => SeaTarget.parse(target, spec.label))
  if (targets.length === 0) throw new Error(`${spec.label}: --targets is empty.`)
  const seen = new Set<string>()
  for (const target of targets) {
    const key = `${target.platform}-${target.arch}`
    if (seen.has(key)) {
      throw new Error(`${spec.label}: duplicate platform-arch ${key} in --targets; canonical product names would collide.`)
    }
    seen.add(key)
    spec.validateTarget?.(target)
  }
  return {
    targets,
    skipBuild: values['skip-build'] === true,
    dryRun: values['dry-run'] === true,
  }
}

/** Product-owned settings passed to the common SEA pipeline. */
export interface SingleExeBuildSpec {
  /** Prefix used in logs and failures. */
  readonly label: string
  /** Workspace package selected by `pnpm deploy`. */
  readonly deployRootPackage: string
  /** Optional deploy manifest passed to the workspace-peer closure gate. */
  readonly closureManifest?: string
  /** Require every reachable workspace package at the deploy root. */
  readonly flatWorkspaceClosure?: boolean
  /** Closed-runtime entry relative to the deployed staging root. */
  readonly entryBin: string
  /** Symlink-free deploy directory. */
  readonly staging: string
  /** Workspace install containing direct dependencies omitted by legacy deploy. */
  readonly sourceNodeModules: string
  /** Directory receiving SEA executables. */
  readonly outputDir: string
  /** Target-to-filename mapping inside {@link outputDir}. */
  readonly outputName: (target: SeaTarget) => string
  /** Files pkg must include because runtime loading is dynamic. */
  readonly assets: readonly string[]
  /** Root-level staged documentation files omitted from a product carrier. */
  readonly stagingDocs?: readonly string[]
  /** Optional destination for a macOS node-pty spawn helper. */
  readonly spawnHelperOutput?: (target: SeaTarget, executable: string) => string
}

/** One compiled executable and its optional external node-pty helper. */
export interface SeaArtifact {
  /** Target represented by this artifact. */
  readonly target: SeaTarget
  /** SEA executable path. */
  readonly executable: string
  /** macOS node-pty spawn helper path, when the product emits one. */
  readonly spawnHelper?: string
}

/**
 * List every file a completed SEA pack emitted.
 * @param artifact - one product-target output.
 * @returns executable followed by its optional helper.
 */
export function seaArtifactPaths(artifact: SeaArtifact): string[] {
  return artifact.spawnHelper === undefined
    ? [artifact.executable]
    : [artifact.executable, artifact.spawnHelper]
}

function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

/**
 * Render a command for logs and failures, quoting arguments containing spaces.
 * @param command - executable name.
 * @param args - argument vector.
 * @returns a human-readable command line.
 */
function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

/** Common sequential materialization and SEA packaging pipeline. */
export class SingleExeBuild {
  /** The deploy root and pkg input for this product. */
  readonly staging: string

  /**
   * Construct one product pipeline.
   * @param spec - product-owned deploy and artifact details.
   * @param cli - validated invocation flags.
   */
  constructor(
    private readonly spec: SingleExeBuildSpec,
    readonly cli: SeaBuildCli,
  ) {
    this.staging = spec.staging
  }

  /** Verify the product's complete workspace peer closure. */
  async verifyClosure(): Promise<void> {
    const args = ['run', 'verify-runtime-closure']
    if (this.spec.closureManifest !== undefined) args.push('--manifest', this.spec.closureManifest)
    if (this.spec.flatWorkspaceClosure === true) args.push('--flat')
    await this.run('runtime dependency closure', pnpmBin(), args)
  }

  /** Build workspace artifacts unless the caller explicitly supplied them. */
  async build(): Promise<void> {
    if (this.cli.skipBuild) {
      console.log(`${this.spec.label}: skipping pnpm run build (--skip-build)`)
      return
    }
    await this.run('build', pnpmBin(), ['run', 'build'])
  }

  /** Clear, deploy, de-link, and normalize this product's runtime closure. */
  async deployStaging(): Promise<void> {
    if (this.staging === REPOSITORY_ROOT || REPOSITORY_ROOT.startsWith(this.staging + sep)) {
      throw new Error(`${this.spec.label}: refusing to clear staging dir ${this.staging}: it contains the repo root.`)
    }
    if (this.cli.dryRun) console.log(`${this.spec.label}: [dry-run] rm -rf ${this.staging}`)
    else await rm(this.staging, { recursive: true, force: true })
    await this.run('deploy', pnpmBin(), [
      '--filter',
      this.spec.deployRootPackage,
      'deploy',
      '--legacy',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      this.staging,
    ])
    await this.restoreLegacyHoists()
    await this.materializeStagedLinks()
    const docs = this.spec.stagingDocs ?? []
    if (this.cli.dryRun) {
      for (const name of docs) console.log(`${this.spec.label}: [dry-run] rm -f ${join(this.staging, name)}`)
    } else {
      await Promise.all(docs.map(name => rm(join(this.staging, name), { force: true })))
    }
  }

  /** Add the entry and dynamic asset list to the deployed manifest. */
  async injectPkgConfig(): Promise<void> {
    const patch = { bin: this.spec.entryBin, pkg: { assets: this.spec.assets } }
    const manifestPath = join(this.staging, 'package.json')
    if (this.cli.dryRun) {
      console.log(`${this.spec.label}: [dry-run] patch ${manifestPath} with ${JSON.stringify(patch)}`)
      return
    }
    if (!existsSync(manifestPath)) {
      throw new Error(`${this.spec.label}: ${manifestPath} missing — pnpm deploy did not produce a staged package.`)
    }
    if (!existsSync(join(this.staging, this.spec.entryBin))) {
      throw new Error(`${this.spec.label}: ${join(this.staging, this.spec.entryBin)} missing — run without --skip-build so lib/ artifacts exist.`)
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`)
    console.log(`${this.spec.label}: injected pkg config into ${manifestPath}`)
  }

  /**
   * Build one target and materialize its macOS node-pty helper when needed.
   * @param target - pkg target to compile.
   * @returns the completed SEA artifact.
   */
  async pack(target: SeaTarget): Promise<SeaArtifact> {
    const executable = this.productPath(target)
    await this.prepareNativePty(target)
    if (!this.cli.dryRun) await mkdir(this.spec.outputDir, { recursive: true })
    await this.run(`pkg ${target.spec}`, pnpmBin(), [
      'dlx',
      SEA_PKG_SPEC,
      this.staging,
      '--sea',
      '--targets',
      target.spec,
      '--output',
      executable,
    ])
    if (!this.cli.dryRun && !existsSync(executable)) {
      throw new Error(`${this.spec.label}: product ${executable} is missing after the pkg run; inspect ${this.spec.outputDir}.`)
    }
    if (target.platform !== 'macos') return { target, executable }
    const spawnHelper = this.spec.spawnHelperOutput?.(target, executable) ?? `${executable}-spawn-helper`
    const source = join(this.staging, 'node_modules', 'node-pty', 'prebuilds', `darwin-${target.arch}`, 'spawn-helper')
    if (this.cli.dryRun) {
      console.log(`${this.spec.label}: [dry-run] cp ${source} ${spawnHelper}`)
    } else {
      await mkdir(dirname(spawnHelper), { recursive: true })
      await copyFile(source, spawnHelper)
      await chmod(spawnHelper, 0o755)
    }
    return { target, executable, spawnHelper }
  }

  /**
   * Print completed product files and their sizes.
   * @param products - generated executable or helper paths.
   */
  printProducts(products: readonly string[]): void {
    console.log(this.cli.dryRun ? `${this.spec.label}: [dry-run] would produce:` : `${this.spec.label}: products:`)
    for (const path of products) {
      if (this.cli.dryRun) {
        console.log(`  ${path}`)
        continue
      }
      const megabytes = statSync(path).size / (1024 * 1024)
      console.log(`  ${path}  (${megabytes.toFixed(1)} MB)`)
    }
  }

  /** Restore direct packages legacy deploy leaves beside its source manifest. */
  private async restoreLegacyHoists(): Promise<void> {
    if (this.cli.dryRun) {
      console.log(`${this.spec.label}: [dry-run] restore direct dependencies omitted by legacy deploy`)
      return
    }
    const manifestPath = join(this.staging, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const sourceNodeModules = this.spec.sourceNodeModules
    const restored: string[] = []
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      const destination = join(this.staging, 'node_modules', dependency)
      if (existsSync(destination)) continue
      const source = join(sourceNodeModules, dependency)
      if (!existsSync(source)) {
        throw new Error(`${this.spec.label}: deployed dependency ${dependency} is absent from both ${destination} and ${source}.`)
      }
      await mkdir(dirname(destination), { recursive: true })
      const nestedNodeModules = join(source, 'node_modules')
      await cp(source, destination, {
        recursive: true,
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
      })
      restored.push(dependency)
    }
    const stillMissing = Object.keys(manifest.dependencies ?? {})
      .filter(dependency => !existsSync(join(this.staging, 'node_modules', dependency)))
    if (stillMissing.length > 0) {
      throw new Error(`${this.spec.label}: staged dependencies remain missing: ${stillMissing.join(', ')}.`)
    }
    if (restored.length > 0) {
      console.log(`${this.spec.label}: restored legacy deploy hoists: ${restored.join(', ')}`)
    }
  }

  /** Replace deploy-time package links with files and reject every remaining link. */
  private async materializeStagedLinks(): Promise<void> {
    if (this.cli.dryRun) {
      console.log(`${this.spec.label}: [dry-run] materialize staged package links`)
      return
    }
    const nodeModules = join(this.staging, 'node_modules')
    let remaining = await this.findSymlink(nodeModules)
    while (remaining !== undefined) {
      const segments = remaining.slice(nodeModules.length + 1).split(sep)
      const binIndex = segments.lastIndexOf('.bin')
      if (binIndex >= 0) {
        await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
        remaining = await this.findSymlink(nodeModules)
        continue
      }
      const destination = remaining
      const source = await realpath(destination)
      const nestedNodeModules = join(source, 'node_modules')
      await rm(destination, { recursive: true, force: true })
      await cp(source, destination, {
        recursive: true,
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
      })
      remaining = await this.findSymlink(nodeModules)
    }
  }

  /**
   * Return the first symbolic link below one staged directory.
   * @param directory - directory to inspect recursively.
   * @returns the first symlink, when present.
   */
  private async findSymlink(directory: string): Promise<string | undefined> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) return path
      if (metadata.isDirectory()) {
        const nested = await this.findSymlink(path)
        if (nested !== undefined) return nested
      }
    }
    return undefined
  }

  /**
   * Place the target node-pty addon in the staged closure. Linux npm installs
   * it from source, but legacy deploy omits that side-effect directory.
   * @param target - pkg target whose native addon is staged.
   */
  private async prepareNativePty(target: SeaTarget): Promise<void> {
    const stagedBuild = join(this.staging, 'node_modules', 'node-pty', 'build')
    if (this.cli.dryRun) console.log(`${this.spec.label}: [dry-run] rm -rf ${stagedBuild}`)
    else await rm(stagedBuild, { recursive: true, force: true })
    if (target.platform !== 'linux') return
    const source = join(REPOSITORY_ROOT, 'packages', 'subprocess', 'subprocess-local', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node')
    const destination = join(stagedBuild, 'Release', 'pty.node')
    if (this.cli.dryRun) {
      console.log(`${this.spec.label}: [dry-run] cp ${source} ${destination}`)
      return
    }
    const host = SeaTarget.host(this.spec.label)
    if (target.platform !== host.platform || target.arch !== host.arch) {
      throw new Error(
        `${this.spec.label}: build the Linux runtime on its target architecture; `
        + `target ${target.platform}-${target.arch} does not match host ${host.platform}-${host.arch}.`,
      )
    }
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }

  /**
   * Resolve and validate the product filename for a target.
   * @param target - target being packed.
   * @returns absolute SEA output path.
   */
  private productPath(target: SeaTarget): string {
    const name = this.spec.outputName(target)
    if (name === '' || basename(name) !== name) {
      throw new Error(`${this.spec.label}: output name ${JSON.stringify(name)} must be one filename.`)
    }
    return join(this.spec.outputDir, name)
  }

  /**
   * Run one subprocess with inherited stdio.
   * @param label - step name for logs and failures.
   * @param command - executable name.
   * @param args - argument vector.
   */
  private async run(label: string, command: string, args: string[]): Promise<void> {
    const printable = formatCommand(command, args)
    if (this.cli.dryRun) {
      console.log(`${this.spec.label}: [dry-run] ${printable}`)
      return
    }
    console.log(`${this.spec.label}: ${label}: ${printable}`)
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: REPOSITORY_ROOT,
        stdio: 'inherit',
        // Artifact builds must not mutate or validate a developer's Git hooks.
        env: { ...process.env, CI: 'true' },
      })
      child.once('error', (error) => {
        reject(new Error(`${this.spec.label}: ${label} failed to spawn: ${error.message} (${printable})`))
      })
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolvePromise()
          return
        }
        const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
        reject(new Error(`${this.spec.label}: ${label} failed (${cause}): ${printable}`))
      })
    })
  }
}
