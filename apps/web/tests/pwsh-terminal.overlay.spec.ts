/**
 * The pwsh terminal replay owns one host-executor override over the shipped
 * base + Web layers. This pins row ownership separately from the browser
 * assertion so composition drift fails even on hosts without PowerShell.
 */

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const BASE_PATCH = fileURLToPath(new URL('../../../packages/bundle/base/cordis.patch.yml', import.meta.url))
const WEB_PATCH = fileURLToPath(new URL('../../../packages/bundle/web-app/cordis.patch.yml', import.meta.url))
const PWSH_OVERLAY = fileURLToPath(new URL('./pwsh-terminal.overlay.yml', import.meta.url))

describe('pwsh terminal replay composition', () => {
  it('replaces both platform executors and re-enables the existing pwsh tool row', () => {
    const warnings: string[] = []
    const rows = composeEntries([
      loadOverlayPatches('pwsh terminal replay', BASE_PATCH),
      loadOverlayPatches('pwsh terminal replay', WEB_PATCH),
      loadOverlayPatches('pwsh terminal replay', PWSH_OVERLAY),
    ], warning => warnings.push(warning))
    const byId = new Map(rows.map(row => [row.id, row]))

    for (const id of ['bash-sandbox', 'pwsh-sandbox', 'pwsh-local', 'tool-pwsh', 'permission']) {
      expect(rows.filter(row => row.id === id), `row ${id}`).toHaveLength(1)
    }
    expect(byId.get('bash-sandbox')).toMatchObject({
      name: '@deepseek-ai/dsh-bash-sandbox',
      disabled: true,
    })
    expect(byId.get('pwsh-sandbox')).toMatchObject({
      name: '@deepseek-ai/dsh-pwsh-sandbox',
      disabled: true,
    })
    expect(byId.get('pwsh-local')).toMatchObject({ name: '@deepseek-ai/dsh-pwsh-local' })
    expect(byId.get('tool-pwsh')).toMatchObject({
      name: '@deepseek-ai/dsh-tool-pwsh',
      disabled: false,
    })
    expect(byId.get('permission')).toMatchObject({
      name: '@deepseek-ai/dsh-permission-presets',
      disabled: true,
    })
    expect(warnings).toEqual([])
  })
})
