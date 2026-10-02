import { spawn } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findFrontendPort, isPortAvailable, parseBackendPort } from './dev-ports.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = new Set();
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
  const timeout = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 4000);
  timeout.unref();
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
function supervise(child) {
  children.add(child);
  child.on('exit', (code) => {
    children.delete(child);
    if (!stopping) stop(code ?? 1);
  });
  child.on('error', (error) => {
    children.delete(child);
    console.error(`Could not start Catan: ${error.message}`);
    stop(1);
  });
  return child;
}

function waitForBackend(child, port) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => finish(new Error('Catan backend did not start. Check the server error above.')),
      15000,
    );
    const onExit = () => finish(new Error('Catan backend stopped before it was ready.'));
    const onData = (chunk) => {
      output = (output + chunk.toString()).slice(-4096);
      if (output.includes(`Catan server listening on http://localhost:${port}\n`)) finish();
    };
    function finish(error) {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', finish);
      if (error) reject(error);
      else resolve();
    }
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', finish);
  });
}

try {
  try {
    loadEnvFile(path.join(root, '.env'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const port = parseBackendPort(process.env.PORT);
  if (!(await isPortAvailable(port))) {
    throw new Error(
      `Catan backend port ${port} is already in use. Stop the earlier Catan terminal with Ctrl+C, then retry.\n` +
        'To choose another backend port, run PORT=3002 npm run dev (use an unused port).',
    );
  }
  const frontendPort = await findFrontendPort(port);
  if (stopping) process.exit(0);
  const env = { ...process.env, PORT: String(port) };
  const backend = supervise(
    spawn(process.execPath, ['--import', 'tsx', '--watch', 'server/index.ts'], {
      cwd: root,
      env,
      stdio: ['inherit', 'pipe', 'inherit'],
    }),
  );
  backend.stdout.pipe(process.stdout);
  await waitForBackend(backend, port);
  if (!stopping) {
    supervise(
      spawn(
        process.execPath,
        [
          'node_modules/vite/bin/vite.js',
          '--host',
          '0.0.0.0',
          '--port',
          String(frontendPort),
          '--strictPort',
        ],
        { cwd: root, env, stdio: 'inherit' },
      ),
    );
  }
} catch (error) {
  if (!stopping) console.error(error.message);
  stop(1);
}
