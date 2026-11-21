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
});
