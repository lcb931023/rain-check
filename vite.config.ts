import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'web',
  // es2022 (matching tsconfig's target) so main.ts's top-level await survives the build;
  // vite's default es2020 target rejects it.
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
  server: { proxy: { '/api': 'http://localhost:8787' } },
  test: { root: '.' },
});
