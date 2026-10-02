import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({
  ...base,
  testMatch: 'firebase-browser.spec.ts',
  use: { ...base.use, baseURL: 'http://127.0.0.1:5199' },
  webServer: {
    command: 'node --import tsx tests/firebase-browser-server.ts',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
