import { defineConfig } from 'tsdown'

/**
 * The dsh app ships the public `bin` and a closed Desktop-runtime entry. The
 * root tsdown builds only `lib/types/index.js`, so this override points at the
 * two executable entries; each one's reachable mode modules bundle with it.
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js', 'lib/types/packaged-desktop-bin.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
