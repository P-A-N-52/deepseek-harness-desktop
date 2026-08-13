#!/usr/bin/env node
/**
 * Closed Desktop runtime entry. It exposes only the loopback Web application;
 * bare Cordis plugins resolve from the sealed executable closure.
 *
 * @module @deepseek-ai/dsh/packaged-desktop-bin
 */

import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { createDesktopParentTermination, watchDesktopParent } from './desktop-parent-watch.ts'
import { runProfile } from './profile-boot.ts'

/* v8 ignore file -- exercised by the Desktop runtime artifact smoke. */

const parentTermination = createDesktopParentTermination()
watchDesktopParent(process.ppid, undefined, () => { parentTermination.parentLost() })

await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: 'web',
  patchFiles: [],
  args: ['--host', '127.0.0.1', '--port', '0'],
  bareModuleBaseUrl: import.meta.url,
  supervisorSignal: parentTermination.signal,
  forceExit: (code) => { parentTermination.forceExit(code) },
})
