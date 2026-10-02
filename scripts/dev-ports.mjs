import { createConnection, createServer } from 'node:net';

export function parseBackendPort(value = '3001') {
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a whole number between 1 and 65535.');
  }
  return port;
}

async function hasListener(port, host) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const finish = (listening) => {
      socket.destroy();
      resolve(listening);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(true));
  });
}

export async function isPortAvailable(port) {
  // On macOS, a wildcard bind can succeed even when another app owns localhost.
  if (
    (await Promise.all(['127.0.0.1', '::1'].map((host) => hasListener(port, host)))).some(Boolean)
  ) {
    return false;
  }
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
  });
}

export async function findFrontendPort(backendPort, start = 5173) {
  for (let port = start; port < Math.min(start + 100, 65536); port++) {
    if (port !== backendPort && (await isPortAvailable(port))) return port;
  }
  throw new Error(
    'No free development page port was found. Stop an unused development server and retry.',
  );
}
