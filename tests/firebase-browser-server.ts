import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('./firebase-browser-services.ts', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  plugins: [react()],
  define: { 'import.meta.env.VITE_RANKINGS_TRANSPORT': JSON.stringify('firebase') },
  resolve: { alias: [{ find: '../firebase', replacement: fixture }] },
  server: { host: '127.0.0.1', port: 5199, strictPort: true },
});
await server.listen();
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
