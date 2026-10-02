import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const backend = `http://127.0.0.1:${process.env.PORT ?? 3001}`;
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/socket.io': { target: backend, ws: true },
      '/api': { target: backend, xfwd: true },
    },
  },
  build: { chunkSizeWarningLimit: 900 },
});
