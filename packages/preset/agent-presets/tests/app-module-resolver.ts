/** Test installation of the application-owned module resolver service. */

import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'

/**
 * Give a focused test context the same module-resolution service app boot
 * installs in a complete application.
 * @param ctx - context receiving the base URL and resolver service.
 * @param contextBaseUrl - base URL for config-relative Loader entries.
 * @param moduleBaseUrl - package tree for bare Loader entries.
 */
export function installTestAppModuleResolver(
  ctx: Context,
  contextBaseUrl: string,
  moduleBaseUrl: string = contextBaseUrl,
): void {
  const appRequire = createRequire(moduleBaseUrl)
  ctx.baseUrl = contextBaseUrl
  ctx.provide('appModuleResolver', {
    moduleBaseUrl,
    resolve: specifier => appRequire.resolve(specifier),
  })
}
