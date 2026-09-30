import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 180000,
  expect: { timeout: 12000 },
  reporter: 'list',
  use: {
    actionTimeout: 20000,
    baseURL: 'http://localhost:3001',
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
    trace: { mode: 'retain-on-failure', screenshots: false },
  },
  webServer: {
    command: 'npm start',
    url: 'http://localhost:3001/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
