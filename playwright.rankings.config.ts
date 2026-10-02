import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Rankings tests start isolated servers and never write to the live ledger.
export default defineConfig({ ...base, testMatch: 'rankings.spec.ts', webServer: undefined });
