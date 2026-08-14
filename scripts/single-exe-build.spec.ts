import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AUDITED_PNPM_VERSION,
  SeaTarget,
  assertAuditedPnpmVersion,
  assertReviewedDeployBuild,
  assertSeaPackerCacheSupport,
  isolatedSeaPkgCache,
  lockedDeployArgs,
  materializeLockedStagingLinks,
  materializeSeaRuntimeArchive,
  pkgSeaCacheEnvironment,
  reviewedDeployBuild,
  seaPackerInvocation,
  seaRuntimeArchive,
  seaRuntimeArchiveCachePath,
  seaRuntimeProvenance,
  verifySeaPackerInstallation,
  type SeaRuntimeArchive,
} from './single-exe-build.ts'

const roots: string[] = []
const PATCHED_SEA_SOURCE = [
  'const cacheRoot = process.env.DSH_PKG_SEA_CACHE_DIR;',
  "if (cacheRoot !== undefined && (cacheRoot.trim() === '' || !(0, path_1.isAbsolute)(cacheRoot))) {}",
  "const downloadDir = cacheRoot ?? (0, path_1.join)((0, os_1.homedir)(), '.pkg-cache', 'sea');",
].join('\n')

function fixtureArchive(payload: string): SeaRuntimeArchive {
  return {
    version: '0.0.0',
    filename: 'node-v0.0.0-darwin-arm64.tar.gz',
    source: 'https://nodejs.org/dist/v0.0.0/node-v0.0.0-darwin-arm64.tar.gz',
    checksumSource: 'https://nodejs.org/dist/v0.0.0/SHASUMS256.txt',
    sha256: createHash('sha256').update(payload).digest('hex'),
  }
}

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-sea-cache-'))
  roots.push(directory)
  return directory
}

async function packerFixture(bin: unknown): Promise<{ root: string; manifestPath: string; binPath: string }> {
  const directory = await root()
  const packageRoot = join(directory, 'pkg')
  const binPath = join(packageRoot, 'lib-es5', 'bin.js')
  const manifestPath = join(packageRoot, 'package.json')
  await mkdir(join(packageRoot, 'lib-es5'), { recursive: true })
  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify({ name: '@yao-pkg/pkg', version: '6.21.0', bin })}\n`),
    writeFile(binPath, '#!/usr/bin/env node\n'),
    writeFile(join(packageRoot, 'lib-es5', 'sea.js'), PATCHED_SEA_SOURCE),
  ])
  return { root: directory, manifestPath, binPath }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('SEA archive cache', () => {
  it('pins every supported product target to an official archive checksum', () => {
    expect(seaRuntimeArchive(SeaTarget.parse('node24.19.0-linux-arm64', 'test')).sha256)
      .toBe('d28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f')
    expect(seaRuntimeArchive(SeaTarget.parse('node24.19.0-linux-x64', 'test')).sha256)
      .toBe('f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4')
    expect(seaRuntimeArchive(SeaTarget.parse('node24.19.0-macos-arm64', 'test')).sha256)
      .toBe('8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d')
    expect(seaRuntimeArchive(SeaTarget.parse('node24.19.0-macos-x64', 'test')).sha256)
      .toBe('d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316')
  })

  it('records the exact patched packer with the verified Node runtime', () => {
    const target = SeaTarget.parse('node24.19.0-macos-arm64', 'test')
    const provenance = seaRuntimeProvenance({
      target,
      archive: '/tmp/node-v24.19.0-darwin-arm64.tar.gz',
      identity: seaRuntimeArchive(target),
      pkgCacheDir: '/tmp/pkg-cache',
    }, 'aarch64-apple-darwin', {
      declared: '@yao-pkg/pkg@6.21.0',
      patchHash: 'a'.repeat(64),
    })

    const node = seaRuntimeArchive(target)
    expect(provenance).toMatchObject({
      schemaVersion: 2,
      target: 'aarch64-apple-darwin',
      packer: {
        declared: '@yao-pkg/pkg@6.21.0',
        patchHash: 'a'.repeat(64),
      },
      node: {
        version: node.version,
        source: node.source,
        checksumSource: node.checksumSource,
        sha256: node.sha256,
      },
    })
    expect(() => seaRuntimeProvenance({
      target,
      archive: '/tmp/node-v24.19.0-darwin-arm64.tar.gz',
      identity: seaRuntimeArchive(target),
      pkgCacheDir: '/tmp/pkg-cache',
    }, 'aarch64-apple-darwin', {
      declared: '@yao-pkg/pkg@6.21.0',
      patchHash: 'not-a-sha256',
    })).toThrow('lowercase SHA-256 patch hash')
  })

  it('fails closed when a reusable pkg archive is poisoned despite its sentinel', async () => {
    const directory = await root()
    const identity = fixtureArchive('approved archive')
    const reusableCacheRoot = join(directory, 'user-home', '.pkg-cache', 'sea')
    await mkdir(reusableCacheRoot, { recursive: true })
    await writeFile(join(reusableCacheRoot, identity.filename), 'poisoned archive')
    await writeFile(join(reusableCacheRoot, `${identity.filename}.ok`), '')

    await expect(materializeSeaRuntimeArchive(identity, {
      cacheRoot: join(directory, 'build-cache'),
      reusableCacheRoot,
    })).rejects.toThrow('does not match')
    expect(existsSync(seaRuntimeArchiveCachePath(join(directory, 'build-cache'), identity))).toBe(false)
  })

  it('gives pkg a fresh cache without changing or exposing a user cache', async () => {
    const directory = await root()
    const identity = fixtureArchive('approved archive')
    const reusableCacheRoot = join(directory, 'user-home', '.pkg-cache', 'sea')
    const reusableArchive = join(reusableCacheRoot, identity.filename)
    const extractedNode = join(
      reusableCacheRoot,
      identity.filename.slice(0, -'.tar.gz'.length),
      'bin',
      'node',
    )
    await mkdir(join(reusableCacheRoot, identity.filename.slice(0, -'.tar.gz'.length), 'bin'), { recursive: true })
    await writeFile(reusableArchive, 'approved archive')
    await writeFile(`${reusableArchive}.ok`, '')
    await writeFile(extractedNode, 'untrusted extracted node')

    const cacheRoot = join(directory, 'build-cache')
    const archive = await materializeSeaRuntimeArchive(identity, { cacheRoot, reusableCacheRoot })
    const pkgCache = await isolatedSeaPkgCache(archive, identity, cacheRoot)

    expect(await readFile(reusableArchive, 'utf8')).toBe('approved archive')
    expect(existsSync(extractedNode)).toBe(true)
    expect(await readFile(join(pkgCache, identity.filename), 'utf8')).toBe('approved archive')
    expect(existsSync(join(pkgCache, identity.filename.slice(0, -'.tar.gz'.length), 'bin', 'node'))).toBe(false)
    expect(pkgSeaCacheEnvironment(pkgCache)).toEqual({ DSH_PKG_SEA_CACHE_DIR: pkgCache })
    expect(pkgSeaCacheEnvironment(pkgCache)).not.toHaveProperty('HOME')
    expect(pkgSeaCacheEnvironment(pkgCache)).not.toHaveProperty('USERPROFILE')
  })

  it('rejects a non-absolute pkg cache selection', () => {
    expect(() => pkgSeaCacheEnvironment('relative-cache')).toThrow('non-empty absolute path')
    expect(() => pkgSeaCacheEnvironment('')).toThrow('non-empty absolute path')
  })

  it('uses an offline shared-lock deploy and handles one reviewed lifecycle script', async () => {
    const directory = await root()
    const staging = join(directory, 'staging')
    const ignoredBuild = reviewedDeployBuild(directory)
    const args = lockedDeployArgs('runtime-pkg', staging)

    expect(args).toContain('--config.inject-workspace-packages=true')
    expect(args).toContain('--config.frozen-lockfile=true')
    expect(args).toContain('--config.strict-dep-builds=false')
    expect(args).toContain('--offline')
    expect(args).not.toContain('--legacy')
    expect(args).not.toContain('--config.auto-install-peers=false')
    expect(args).not.toContain('--config.link-workspace-packages=true')
    expect(() => { assertAuditedPnpmVersion(AUDITED_PNPM_VERSION) }).not.toThrow()
    expect(() => { assertAuditedPnpmVersion('11.19.0') }).toThrow('pnpm 11.7.0 is required')
    expect(() => { assertReviewedDeployBuild({ ignoredBuilds: [ignoredBuild] }, directory) }).not.toThrow()
    expect(() => { assertReviewedDeployBuild({ ignoredBuilds: [] }, directory) }).toThrow('got none')
    expect(() => {
      assertReviewedDeployBuild({ ignoredBuilds: [ignoredBuild, 'unreviewed@1.0.0'] }, directory)
    }).toThrow('unreviewed@1.0.0')
    expect(() => { assertReviewedDeployBuild({ ignoredBuilds: [42] }, directory) }).toThrow('must be a string array')
  })

  it.skipIf(process.platform === 'win32')('rejects a nested staged link that escapes the deploy root', async () => {
    const directory = await root()
    const staging = join(directory, 'staging')
    const packageSource = join(staging, 'store', 'package')
    const outside = join(directory, 'outside.txt')
    await Promise.all([
      mkdir(join(staging, 'node_modules'), { recursive: true }),
      mkdir(packageSource, { recursive: true }),
      writeFile(outside, 'outside deploy root'),
    ])
    await symlink(outside, join(packageSource, 'escape'))
    await symlink(packageSource, join(staging, 'node_modules', 'package'))

    await expect(materializeLockedStagingLinks(staging, 'test runtime'))
      .rejects.toThrow('resolves outside the deploy root')
  })

  it('refuses an unpatched or differently pinned installed SEA packer', () => {
    const manifest = { name: '@yao-pkg/pkg', version: '6.21.0' }

    expect(() => { assertSeaPackerCacheSupport(manifest, PATCHED_SEA_SOURCE) }).not.toThrow()
    expect(() => { assertSeaPackerCacheSupport(manifest, "const downloadDir = (0, path_1.join)((0, os_1.homedir)(), '.pkg-cache', 'sea');") })
      .toThrow('does not enforce DSH_PKG_SEA_CACHE_DIR')
    expect(() => { assertSeaPackerCacheSupport({ ...manifest, version: '6.21.1' }, PATCHED_SEA_SOURCE) })
      .toThrow('installed package must be @yao-pkg/pkg@6.21.0')
  })

  it('uses the verified sole pkg bin directly through Node', async () => {
    const stringFixture = await packerFixture('lib-es5/bin.js')
    const fixture = await packerFixture({ pkg: 'lib-es5/bin.js' })
    const [stringPacker, packer] = await Promise.all([
      verifySeaPackerInstallation(stringFixture.manifestPath),
      verifySeaPackerInstallation(fixture.manifestPath),
    ])
    const invocation = seaPackerInvocation(packer, ['/runtime', '--sea'])

    expect(stringPacker.binPath).toBe(await realpath(stringFixture.binPath))
    expect(packer.binPath).toBe(await realpath(fixture.binPath))
    expect(invocation).toEqual({
      command: process.execPath,
      args: [packer.binPath, '/runtime', '--sea'],
    })
    expect(invocation.command).not.toContain('pnpm')
    expect(invocation.args).not.toContain('pnpm')
  })

  it('rejects ambiguous, escaping, and non-file pkg bin declarations', async () => {
    const ambiguous = await packerFixture({ pkg: 'lib-es5/bin.js', alternate: 'lib-es5/bin.js' })
    await expect(verifySeaPackerInstallation(ambiguous.manifestPath)).rejects.toThrow('must expose one pkg bin entry')

    const escaping = await packerFixture({ pkg: '../outside.js' })
    await writeFile(join(escaping.root, 'outside.js'), '#!/usr/bin/env node\n')
    await expect(verifySeaPackerInstallation(escaping.manifestPath)).rejects.toThrow('must remain below package root')

    const directory = await packerFixture({ pkg: 'lib-es5/bin-directory' })
    await mkdir(join(directory.root, 'pkg', 'lib-es5', 'bin-directory'))
    await expect(verifySeaPackerInstallation(directory.manifestPath)).rejects.toThrow('bin is not a regular file')
  })
})
