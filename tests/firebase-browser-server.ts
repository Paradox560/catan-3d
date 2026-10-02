import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getApps, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { rankingsRouter } from '../server/rankings.js';
process.env.METADATA_SERVER_DETECTION = 'none';
process.env.NODE_ENV = 'test';
process.env.RANKINGS_STORAGE = 'firestore';
process.env.FIREBASE_AUTH_MODE = 'admin';
process.env.FIREBASE_PROJECT_ID = 'demo-catan-browser';
process.env.FIRESTORE_RANKINGS_DOCUMENT = 'catan/rankings';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8182';
process.env.RANKINGS_ADMIN_USERNAME = 'catan-owner';
process.env.RANKINGS_ADMIN_PASSWORD = 'Owner-browser-fixture-123!';
delete process.env.VERCEL;
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const directory = await mkdtemp(path.join(tmpdir(), 'catan-browser-api-'));
const app = express();
app.use('/api/rankings', rankingsRouter(directory));
const backend = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
const backendPort = (backend.address() as { port: number }).port;
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('./firebase-browser-services.ts', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  plugins: [react()],
  define: { 'import.meta.env.VITE_RANKINGS_TRANSPORT': JSON.stringify('firebase') },
  resolve: { alias: [{ find: '../firebase', replacement: fixture }] },
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: true } },
  },
});
await server.listen();
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void (async () => {
      await server.close();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
      for (const app of getApps()) {
        await getFirestore(app).terminate();
        await deleteApp(app);
      }
      await rm(directory, { recursive: true, force: true });
      process.exit(0);
    })();
  });
