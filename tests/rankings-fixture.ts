import { test as base } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export const test = base.extend<{ rankingsURL: string }>({
  rankingsURL: async ({}, use) => {
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', resolve);
    });
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const directory = mkdtempSync(path.join(tmpdir(), 'catan-rankings-browser-'));
    const url = `http://127.0.0.1:${port}`;
    const environment = { ...process.env };
    delete environment.RANKINGS_ADMIN_PASSWORD;
    const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: root,
      env: {
        ...environment,
        PORT: String(port),
        NODE_ENV: 'test',
        CATAN_DATA_DIR: directory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    server.stdout.on('data', (data) => {
      logs += String(data);
    });
    server.stderr.on('data', (data) => {
      logs += String(data);
    });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (server.exitCode !== null) throw new Error(`Test server stopped: ${logs}`);
        try {
          const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(300) });
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          /* Wait for the private test server to bind. */
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!ready) throw new Error(`Test server did not start: ${logs}`);
      await use(url);
    } finally {
      if (server.exitCode === null) {
        await new Promise<void>((resolve) => {
          const force = setTimeout(() => server.kill('SIGKILL'), 3000);
          server.once('exit', () => {
            clearTimeout(force);
            resolve();
          });
          server.kill('SIGTERM');
        });
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
});

export { expect } from '@playwright/test';
