import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'browser.spec.ts',
  grep: /online players/,
  workers: 1,
  expect: { timeout: 20_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4317',
    actionTimeout: 25_000,
    reducedMotion: 'reduce',
    trace: { mode: 'retain-on-failure', screenshots: false },
  },
  webServer: {
    command: 'node --import tsx tests/http-fixture.ts',
    url: 'http://127.0.0.1:4317/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
