import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { lockedSeaPacker } from './prepare-desktop-release.ts'
import { SEA_NODE_RANGE, SeaTarget, seaRuntimeArchive } from './single-exe-build.ts'
import {
  assertEvidenceBytes,
  assertExactSidecarEntitlements,
  assertExpectedRuntimeManifestCommit,
  assertPinnedNodeSeaEvidence,
  compareMacOSVersions,
  isMachO,
  parseMacOSVersion,
  parseOtoolDeploymentTargets,
  SIDECAR_ENTITLEMENTS,
} from './verify-desktop-bundle.ts'

const root = resolve(import.meta.dirname, '..')
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('Desktop bundle verifier', () => {
  it('binds a runtime manifest to the immutable release commit when provided', () => {
    const commit = 'a'.repeat(40)
    expect(() => { assertExpectedRuntimeManifestCommit(commit, commit) }).not.toThrow()
    expect(() => { assertExpectedRuntimeManifestCommit(commit, undefined) }).not.toThrow()
    expect(() => { assertExpectedRuntimeManifestCommit(commit, 'b'.repeat(40)) })
      .toThrow(`runtime manifest commit mismatch: expected ${'b'.repeat(40)}, got ${commit}`)
  })

  it('compares numeric macOS versions rather than their string form', () => {
    expect(compareMacOSVersions(parseMacOSVersion('13.5'), parseMacOSVersion('13.5.0'))).toBe(0)
    expect(compareMacOSVersions(parseMacOSVersion('13.10'), parseMacOSVersion('13.5'))).toBeGreaterThan(0)
    expect(() => parseMacOSVersion('13.x')).toThrow('invalid macOS version')
  })

  it('recognizes thin and fat Mach-O headers without following arbitrary files', () => {
    expect(isMachO(Buffer.from([0xfe, 0xed, 0xfa, 0xcf]))).toBe(true)
    expect(isMachO(Buffer.from([0xca, 0xfe, 0xba, 0xbe]))).toBe(true)
    expect(isMachO(Buffer.from('dsh'))).toBe(false)
  })

  it('reads modern and legacy macOS deployment commands', () => {
    const targets = parseOtoolDeploymentTargets([
      '      cmd LC_BUILD_VERSION',
      '    minos 13.5',
      '      cmd LC_VERSION_MIN_MACOSX',
      '  version 11.0',
    ].join('\n'))
    expect(targets).toEqual([[13, 5], [11, 0]])
  })

  it('pins the sidecar entitlement file to exactly the hardened-runtime allowance', () => {
    const entitlements = readFileSync(resolve(root, 'apps/desktop/src-tauri/sidecar-entitlements.plist'), 'utf8')
    assertExactSidecarEntitlements(entitlements)
    expect(entitlements).not.toContain('com.apple.security.get-task-allow')
    for (const entitlement of SIDECAR_ENTITLEMENTS) expect(entitlements).toContain(entitlement)
  })

  it('rejects entitlement escalation and omitted required permissions', () => {
    expect(() => {
      assertExactSidecarEntitlements('<plist><dict><key>com.apple.security.get-task-allow</key><true/></dict></plist>')
    })
      .toThrow('sidecar entitlements')
    expect(() => {
      assertExactSidecarEntitlements([
        '<plist><dict>',
        '<key>com.apple.security.cs.allow-jit</key><true/>',
        '<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>',
        '<key>com.apple.security.cs.disable-executable-page-protection</key><true/>',
        '</dict></plist>',
      ].join(''))
    }).toThrow('sidecar entitlements')
  })

  it('requires every bundled release-evidence file to match its source bytes', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-desktop-evidence-'))
    temporaryRoots.push(temporary)
    const source = join(temporary, 'source')
    const bundled = join(temporary, 'bundle')
    await writeFile(source, 'source evidence')
    await writeFile(bundled, 'source evidence')

    await expect(assertEvidenceBytes(source, bundled, 'Contents/Resources/legal/NODE_LICENSE')).resolves.toBeUndefined()

    await writeFile(bundled, 'modified evidence')
    await expect(assertEvidenceBytes(source, bundled, 'Contents/Resources/legal/NODE_LICENSE'))
      .rejects.toThrow('Contents/Resources/legal/NODE_LICENSE')
  })

  it('anchors the bundled Node and SEA packer evidence to current source inputs', () => {
    const packer = lockedSeaPacker()
    const node = seaRuntimeArchive(SeaTarget.parse(`${SEA_NODE_RANGE}-macos-arm64`, 'test'))
    const license = Buffer.from('Node.js license text')
    const nodeSea = {
      declaredNodeRange: SEA_NODE_RANGE,
      packer: {
        declared: packer.declared,
        lockfile: packer.lockfile,
        integrity: packer.integrity,
        patchHash: packer.patchHash,
      },
      runtimeVersion: node.version,
      source: node.source,
      checksumSource: node.checksumSource,
      sha256: node.sha256,
      licenseSha256: createHash('sha256').update(license).digest('hex'),
      provenance: 'apps/desktop/src-tauri/resources/runtime/aarch64-apple-darwin/sea-provenance.json',
    }
    const provenance = {
      schemaVersion: 2,
      target: 'aarch64-apple-darwin',
      packer: { declared: packer.declared, patchHash: packer.patchHash },
      node: {
        version: node.version,
        source: node.source,
        checksumSource: node.checksumSource,
        sha256: node.sha256,
      },
    }

    expect(() => { assertPinnedNodeSeaEvidence(nodeSea, provenance, license) }).not.toThrow()
    expect(() => { assertPinnedNodeSeaEvidence({
      ...nodeSea,
      packer: { ...nodeSea.packer, patchHash: 'a'.repeat(64) },
    }, provenance, license) }).toThrow('runtime manifest nodeSea.packer.patchHash mismatch')
    expect(() => { assertPinnedNodeSeaEvidence(nodeSea, {
      ...provenance,
      node: { ...provenance.node, checksumSource: 'https://example.invalid/SHASUMS256.txt' },
    }, license) }).toThrow('SEA provenance.node.checksumSource mismatch')
    expect(() => { assertPinnedNodeSeaEvidence({
      ...nodeSea,
      licenseSha256: 'b'.repeat(64),
    }, provenance, license) }).toThrow('runtime manifest nodeSea.licenseSha256 mismatch')
  })
})
