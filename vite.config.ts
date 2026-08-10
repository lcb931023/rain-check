import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:8787' } },
  test: { root: '.' },
});
