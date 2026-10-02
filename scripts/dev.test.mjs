import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { findFrontendPort, isPortAvailable, parseBackendPort } from './dev-ports.mjs';

const exec = promisify(execFile);
const scripts = path.dirname(fileURLToPath(import.meta.url));

async function listener(host = '127.0.0.1') {
  const server = createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test('backend PORT defaults and accepts the valid numeric range', () => {
  assert.equal(parseBackendPort(), 3001);
  assert.equal(parseBackendPort(undefined), 3001);
  for (const [input, expected] of [
    ['1', 1],
    ['3002', 3002],
    ['65535', 65535],
    ['003001', 3001],
  ]) {
    assert.equal(parseBackendPort(input), expected);
  }
});

test('backend PORT rejects malformed, fractional and out-of-range values', () => {
  for (const input of [
    '',
    ' ',
    '3001 ',
    ' 3001',
    '-1',
    '0',
    '65536',
    '3001.5',
    '1e3',
    '0x10',
    '+3001',
    'NaN',
    'Infinity',
    'abc',
  ]) {
    assert.throws(
      () => parseBackendPort(input),
      /PORT must be a whole number between 1 and 65535/,
      input,
    );
  }
});

test('a listener bound only to IPv4 loopback makes the backend port unavailable', async () => {
  const occupied = await listener();
  try {
    assert.equal(await isPortAvailable(occupied.port), false);
  } finally {
    await occupied.close();
  }
  assert.equal(await isPortAvailable(occupied.port), true);
});

test('a listener bound only to IPv6 loopback makes the backend port unavailable', async (t) => {
  let occupied;
  try {
    occupied = await listener('::1');
  } catch (error) {
    if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) {
      t.skip('IPv6 loopback is not available on this host.');
      return;
    }
    throw error;
  }
  try {
    assert.equal(await isPortAvailable(occupied.port), false);
  } finally {
    await occupied.close();
  }
});

test('frontend selection skips an occupied loopback port and the backend port', async () => {
  let occupied = await listener();
  while (occupied.port > 65435 || !(await isPortAvailable(occupied.port + 1))) {
    await occupied.close();
    occupied = await listener();
  }
  const backendPort = occupied.port + 1;
  try {
    const chosen = await findFrontendPort(backendPort, occupied.port);
    assert.ok(chosen > backendPort && chosen < occupied.port + 100);
    assert.equal(await isPortAvailable(chosen), true);
  } finally {
    await occupied.close();
  }
});

test('frontend selection refuses a range containing only the excluded backend port', async () => {
  await assert.rejects(findFrontendPort(65535, 65535), /No free development page port was found/);
});

test('launcher rejects an occupied shell PORT before spawning backend or Vite, overriding .env', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'catan-dev-regression-'));
  const occupied = await listener();
  try {
    const fixtureScripts = path.join(fixture, 'scripts');
    await mkdir(fixtureScripts);
    for (const file of ['dev.mjs', 'dev-ports.mjs']) {
      await copyFile(path.join(scripts, file), path.join(fixtureScripts, file));
    }
    const dotenvPort = occupied.port === 3002 ? 3003 : 3002;
    await writeFile(path.join(fixture, '.env'), `PORT=${dotenvPort}\n`);
    // Instrument the built-in spawn function before the real launcher imports it.
    // This catches any attempted child, without installing or running tsx/Vite.
    const marker = path.join(fixture, 'unexpected-child.json');
    const preload = path.join(fixture, 'record-spawns.mjs');
    await writeFile(
      preload,
      `
import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
childProcess.spawn = (...args) => {
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify(args));
  throw new Error('Regression: a child started before backend port validation.');
};
syncBuiltinESMExports();
`,
    );
    let failure;
    try {
      await exec(process.execPath, [path.join(fixtureScripts, 'dev.mjs')], {
        cwd: fixture,
        env: {
          PATH: process.env.PATH ?? '',
          PORT: String(occupied.port),
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        },
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, 'the launcher must fail when its backend port is occupied');
    assert.equal(failure.code, 1);
    assert.equal(failure.killed, false, 'the launcher exits itself before the timeout');
    assert.match(
      failure.stderr,
      new RegExp(`Catan backend port ${occupied.port} is already in use`),
    );
    assert.match(failure.stderr, /PORT=3002 npm run dev/);
    assert.doesNotMatch(failure.stderr, /Regression: a child started/);
    assert.equal(failure.stdout, '');
    await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'no child process was attempted');
    assert.equal(await readFile(path.join(fixture, '.env'), 'utf8'), `PORT=${dotenvPort}\n`);
  } finally {
    await occupied.close();
    await rm(fixture, { recursive: true, force: true });
  }
});
