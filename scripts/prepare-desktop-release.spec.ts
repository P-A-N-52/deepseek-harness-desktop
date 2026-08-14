import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import {
  desktopArchitecture,
  desktopNpmBom,
  ensureDesktopLegalResourceRoot,
  lockedSeaPacker,
  verifyNodeLicenseArchive,
} from './prepare-desktop-release.ts'
import type { SeaRuntimeArchive, SeaRuntimeProvenance } from './single-exe-build.ts'

const roots: string[] = []

async function manifest(directory: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), `${JSON.stringify(value, null, 2)}\n`)
}

function sri(payload: string): string {
  return `sha512-${createHash('sha512').update(payload).digest('base64')}`
}

async function lockfile(
  root: string,
  packages: Record<string, unknown>,
  snapshots: Record<string, unknown>,
): Promise<string> {
  const path = join(root, 'pnpm-lock.yaml')
  await writeFile(path, yaml.dump({
    lockfileVersion: '9.0',
    importers: {},
    packages,
    snapshots,
  }))
  return path
}

function seaPackerLock(patchHash: string, integrity = sri('pkg')): Record<string, unknown> {
  return {
    lockfileVersion: '9.0',
    importers: {
      '.': {
        devDependencies: {
          '@yao-pkg/pkg': { version: `6.21.0(patch_hash=${patchHash})` },
        },
      },
    },
    packages: {
      '@yao-pkg/pkg@6.21.0': { resolution: { integrity } },
    },
    snapshots: {},
    patchedDependencies: {
      '@yao-pkg/pkg@6.21.0': patchHash,
    },
  }
}

async function seaPackerInputs(root: string, patchContents: string, integrity?: string): Promise<string> {
  const patchHash = createHash('sha256').update(patchContents).digest('hex')
  const patch = join(root, 'patches', '@yao-pkg+pkg@6.21.0.patch')
  await mkdir(join(root, 'patches'), { recursive: true })
  await writeFile(patch, patchContents)
  await writeFile(join(root, 'pnpm-lock.yaml'), yaml.dump(seaPackerLock(patchHash, integrity)))
  await writeFile(join(root, 'pnpm-workspace.yaml'), yaml.dump({
    packages: [],
    patchedDependencies: {
      '@yao-pkg/pkg@6.21.0': 'patches/@yao-pkg+pkg@6.21.0.patch',
    },
  }))
  return patch
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe('Desktop release preparation', () => {
  it('materializes the exact legal directory configured as a Tauri resource', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-legal-root-'))
    roots.push(root)

    const legal = await ensureDesktopLegalResourceRoot(root)
    expect((await stat(legal)).isDirectory()).toBe(true)
    expect(legal).toBe(join(root, 'apps/desktop/src-tauri/resources/legal'))

    const config = JSON.parse(await readFile(
      resolve(import.meta.dirname, '../apps/desktop/src-tauri/tauri.release.conf.json'),
      'utf8',
    )) as { bundle: { resources: Record<string, string> } }
    expect(config.bundle.resources['resources/legal']).toBe('legal/')
    expect(config.bundle.resources['resources/legal/**/*']).toBeUndefined()
  })

  it('walks the physical SEA deployment with optional and peer resolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-sbom-'))
    roots.push(root)
    await manifest(root, {
      name: 'desktop-runtime',
      version: '1.2.3',
      dependencies: { '@scope/plugin': '1.0.0' },
      optionalDependencies: { 'host-only-missing': '1.0.0' },
    })
    await manifest(join(root, 'node_modules/@scope/plugin'), {
      name: '@scope/plugin',
      version: '1.0.0',
      license: 'MIT',
      peerDependencies: { cordis: '^4.0.0' },
    })
    await manifest(join(root, 'node_modules/cordis'), {
      name: 'cordis',
      version: '4.0.0',
      license: { type: 'MIT' },
    })
    const lock = await lockfile(root, {
      '@scope/plugin@1.0.0': { resolution: { integrity: sri('plugin') } },
      'cordis@4.0.0': { resolution: { integrity: sri('cordis') } },
    }, {
      '@scope/plugin@1.0.0': {},
      'cordis@4.0.0': {},
    })

    const bom = desktopNpmBom('aarch64-apple-darwin', root, lock)
    expect(bom.metadata.component).toMatchObject({
      name: 'desktop-runtime',
      version: '1.2.3',
    })
    expect(bom.components.map(component => component.name)).toEqual(['@scope/plugin', 'cordis'])
    expect(bom.components.find(component => component.name === '@scope/plugin')?.purl)
      .toBe('pkg:npm/%40scope/plugin@1.0.0')
    const plugin = bom.components.find(component => component.name === '@scope/plugin')
    expect(bom.dependencies.find(edge => edge.ref === plugin?.['bom-ref'])?.dependsOn).toHaveLength(1)
    expect(plugin?.hashes).toEqual([{
      alg: 'SHA-512',
      content: createHash('sha512').update('plugin').digest('hex'),
    }])
    expect(plugin?.properties).toContainEqual({ name: 'dsh:pnpm-snapshot', value: '@scope/plugin@1.0.0' })
    expect(JSON.stringify(bom)).not.toContain('host-only-missing')
  })

  it('includes an optional peer injected only by the frozen pnpm snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-sbom-'))
    roots.push(root)
    await manifest(root, {
      name: 'desktop-runtime',
      version: '1.2.3',
      dependencies: { debug: '4.4.3' },
    })
    await manifest(join(root, 'node_modules/debug'), {
      name: 'debug',
      version: '4.4.3',
      dependencies: { ms: '^2.1.3' },
    })
    await manifest(join(root, 'node_modules/ms'), {
      name: 'ms',
      version: '2.1.3',
    })
    await manifest(join(root, 'node_modules/supports-color'), {
      name: 'supports-color',
      version: '9.4.0',
    })
    const lock = await lockfile(root, {
      'debug@4.4.3': { resolution: { integrity: sri('debug') } },
      'ms@2.1.3': { resolution: { integrity: sri('ms') } },
      'supports-color@9.4.0': { resolution: { integrity: sri('supports-color') } },
    }, {
      'debug@4.4.3(supports-color@9.4.0)': {
        dependencies: { ms: '2.1.3' },
        optionalDependencies: { 'supports-color': '9.4.0' },
      },
      'ms@2.1.3': {},
      'supports-color@9.4.0': {},
    })

    const bom = desktopNpmBom('aarch64-apple-darwin', root, lock)
    const debug = bom.components.find(component => component.name === 'debug')
    const supportsColor = bom.components.find(component => component.name === 'supports-color')

    expect(bom.components.map(component => component.name)).toEqual(['debug', 'ms', 'supports-color'])
    expect(bom.dependencies.find(edge => edge.ref === debug?.['bom-ref'])?.dependsOn)
      .toContain(supportsColor?.['bom-ref'])
    expect(supportsColor?.hashes).toEqual([{
      alg: 'SHA-512',
      content: createHash('sha512').update('supports-color').digest('hex'),
    }])
  })

  it('rejects a physical deployed package with no frozen-lock resolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-sbom-'))
    roots.push(root)
    await manifest(root, {
      name: 'desktop-runtime',
      version: '1.2.3',
      dependencies: { plugin: '1.0.0' },
    })
    await manifest(join(root, 'node_modules/plugin'), {
      name: 'plugin',
      version: '1.0.0',
    })
    await manifest(join(root, 'node_modules/unmapped'), {
      name: 'unmapped',
      version: '1.0.0',
    })
    const lock = await lockfile(root, {
      'plugin@1.0.0': { resolution: { integrity: sri('plugin') } },
    }, {
      'plugin@1.0.0': {},
    })

    expect(() => desktopNpmBom('aarch64-apple-darwin', root, lock))
      .toThrow('unmapped@1.0.0 has no pnpm package resolution')
  })

  it('rejects a mapped physical package outside the runtime dependency closure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-sbom-'))
    roots.push(root)
    await manifest(root, {
      name: 'desktop-runtime',
      version: '1.2.3',
      dependencies: { plugin: '1.0.0' },
    })
    await manifest(join(root, 'node_modules/plugin'), {
      name: 'plugin',
      version: '1.0.0',
    })
    await manifest(join(root, 'node_modules/unreferenced'), {
      name: 'unreferenced',
      version: '1.0.0',
    })
    const lock = await lockfile(root, {
      'plugin@1.0.0': { resolution: { integrity: sri('plugin') } },
      'unreferenced@1.0.0': { resolution: { integrity: sri('unreferenced') } },
    }, {
      'plugin@1.0.0': {},
      'unreferenced@1.0.0': {},
    })

    expect(() => desktopNpmBom('aarch64-apple-darwin', root, lock))
      .toThrow('deployed physical package count 2 does not match reachable closure 1; unreferenced: unreferenced@1.0.0')
  })

  it('rejects a required dependency missing from the deployed closure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-sbom-'))
    roots.push(root)
    await manifest(root, {
      name: 'desktop-runtime',
      version: '1.2.3',
      dependencies: { missing: '1.0.0' },
    })
    expect(() => desktopNpmBom('aarch64-apple-darwin', root)).toThrow('missing required dependency missing')
  })

  it('rejects an ambiguous pnpm snapshot for a deployed package instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-sbom-'))
    roots.push(root)
    await manifest(root, {
      name: 'desktop-runtime',
      version: '1.2.3',
      dependencies: { plugin: '1.0.0' },
    })
    await manifest(join(root, 'node_modules/plugin'), {
      name: 'plugin',
      version: '1.0.0',
      license: 'MIT',
    })
    const lock = await lockfile(root, {
      'plugin@1.0.0': { resolution: { integrity: sri('plugin') } },
    }, {
      'plugin@1.0.0(peer-a@1.0.0)': {},
      'plugin@1.0.0(peer-b@1.0.0)': {},
    })

    expect(() => desktopNpmBom('aarch64-apple-darwin', root, lock))
      .toThrow('maps ambiguously to pnpm snapshots')
  })

  it('rejects a deployed package whose lock resolution lacks a SHA-512 SRI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-sbom-'))
    roots.push(root)
    await manifest(root, {
      name: 'desktop-runtime',
      version: '1.2.3',
      dependencies: { plugin: '1.0.0' },
    })
    await manifest(join(root, 'node_modules/plugin'), {
      name: 'plugin',
      version: '1.0.0',
      license: 'MIT',
    })
    const lock = await lockfile(root, {
      'plugin@1.0.0': { resolution: { integrity: 'sha256-not-a-sha512-digest' } },
    }, {
      'plugin@1.0.0': {},
    })

    expect(() => desktopNpmBom('aarch64-apple-darwin', root, lock))
      .toThrow('must contain exactly one sha512 SRI digest')
  })

  it('rejects a retained Node archive that no longer matches its provenance before license extraction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-license-'))
    roots.push(root)
    const archive = join(root, 'node-v0.0.0-darwin-arm64.tar.gz')
    const approved = createHash('sha256').update('approved archive').digest('hex')
    const identity: SeaRuntimeArchive = {
      version: '0.0.0',
      filename: 'node-v0.0.0-darwin-arm64.tar.gz',
      source: 'https://nodejs.org/dist/v0.0.0/node-v0.0.0-darwin-arm64.tar.gz',
      checksumSource: 'https://nodejs.org/dist/v0.0.0/SHASUMS256.txt',
      sha256: approved,
    }
    const provenance: SeaRuntimeProvenance = {
      schemaVersion: 2,
      target: 'aarch64-apple-darwin',
      packer: { declared: '@yao-pkg/pkg@6.21.0', patchHash: 'a'.repeat(64) },
      node: { version: identity.version, source: identity.source, checksumSource: identity.checksumSource, sha256: approved },
    }
    await writeFile(archive, 'tampered archive')

    expect(() => { verifyNodeLicenseArchive(archive, identity, provenance) })
      .toThrow('hash does not match SEA provenance')
  })

  it('binds the SEA patch bytes and root importer selection to the frozen lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-packer-'))
    roots.push(root)
    const patch = await seaPackerInputs(root, 'approved patch')
    const expectedPatchHash = createHash('sha256').update('approved patch').digest('hex')

    expect(lockedSeaPacker(root)).toMatchObject({
      declared: '@yao-pkg/pkg@6.21.0',
      lockfile: '@yao-pkg/pkg@6.21.0',
      integrity: sri('pkg'),
      patchHash: expectedPatchHash,
    })

    await writeFile(patch, 'tampered patch')
    expect(() => lockedSeaPacker(root)).toThrow('patch hash')
  })

  it('rejects a SEA packer lock record without a SHA-512 SRI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-packer-'))
    roots.push(root)
    await seaPackerInputs(root, 'approved patch', 'sha256-not-a-sha512-digest')

    expect(() => lockedSeaPacker(root)).toThrow('must contain exactly one sha512 SRI digest')
  })

  it('maps supported Tauri triples to their Mach-O architectures', () => {
    expect(desktopArchitecture('aarch64-apple-darwin')).toBe('arm64')
    expect(desktopArchitecture('x86_64-apple-darwin')).toBe('x86_64')
    expect(() => desktopArchitecture('universal-apple-darwin')).toThrow('unsupported Desktop target')
  })
})
