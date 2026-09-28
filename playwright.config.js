import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.js',
  workers: 1,
  timeout: 720000,
  use: {
    baseURL: process.env.HEAPSCAPE_BASE_URL ?? 'http://127.0.0.1:5077',
    channel: 'msedge',
    headless: true,
    viewport: { width: 1600, height: 1000 },
    launchOptions: { args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
});
