import { defineConfig } from 'vite';

export default defineConfig({
  root: 'Client',
  build: { outDir: '../Server/wwwroot', emptyOutDir: true },
});
