import { defineConfig } from 'vite';

// Poki serves the build from a sub-path, so every asset URL must be relative.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    // Keep the font (and everything else) as real files; no base64 inlining.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 950,
    sourcemap: false,
  },
  // Minify-time only (plain .js modules are not esbuild-transformed one by one,
  // so the whole chunk is renamed consistently): private `_lower` members get
  // short names. `__ready` / `__perf...` (double underscore) and anything
  // accessed by a quoted string are left alone (mangleQuoted is off).
  esbuild: { mangleProps: /^_[a-z]/ },
});
