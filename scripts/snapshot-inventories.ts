/** Snapshot-suite file inventories shared by Vitest configs and ownership tests. */

/** Keyless non-browser expected-output suites. */
export const SNAPSHOT_TEST_INCLUDES = [
  'scripts/**/*.snapshot.ts',
  'apps/cli/tests/**/*.snapshot.ts',
  'examples/*/tests/**/*.snapshot.ts',
]

/** Browser-carried Web expected-output and e2e suites. */
export const WEB_SNAPSHOT_TEST_INCLUDES = [
  'apps/web/tests/**/*.e2e.ts',
  'apps/web/tests/**/*.snapshot.ts',
]
