import { defineConfig } from 'vite';

export default defineConfig({
  appType: 'spa',
  build: { outDir: 'dist', emptyOutDir: true },
});
