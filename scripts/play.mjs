import { spawn } from 'node:child_process';

const port = process.env.PORT || '3001';
const url = `http://localhost:${port}`;
try {
  const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
  if (response.ok && (await response.json()).service === 'catan-3d') {
    spawn('open', [url], { stdio: 'ignore' }).unref();
    console.log(`Your Catan server is already running: ${url}`);
    process.exit(0);
  }
} catch {}
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  stdio: 'inherit',
});
let stopped = false;
server.once('exit', (code) => {
  stopped = true;
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    stopped = true;
    server.kill(signal);
  });
for (let attempt = 0; attempt < 50 && !stopped; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    const response = await fetch(`${url}/api/health`);
    if (response.ok) {
      spawn('open', [url], { stdio: 'ignore' }).unref();
      console.log(
        `\nYour island is ready: ${url}\nKeep this window open while playing. Press Control-C to stop.\n`,
      );
      break;
    }
  } catch {}
}
