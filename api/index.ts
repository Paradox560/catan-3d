import express from 'express';
import { onlineRouter } from '../server/online.js';

// Vercel invokes this app per request; it must not listen on a port or use local saves.
const app = express();
app.disable('x-powered-by');
// Vercel overwrites X-Forwarded-For at its edge; only trust that hop on Vercel.
if (process.env.VERCEL === '1') app.set('trust proxy', 1);
app.get('/api/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, service: 'catan-3d', hosting: 'vercel', transport: 'http' });
});
// Retire the server owner-password API; browser rankings use Firebase Auth + Rules.
app.use('/api/rankings', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res
    .status(410)
    .json({
      error:
        'Rankings now connect directly to Firebase. Refresh the website to use the current version.',
    });
});
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (process.env.RANKINGS_STORAGE !== undefined && process.env.RANKINGS_STORAGE !== 'firestore') {
    return void res.status(503).json({
      error:
        'Cloud storage is not configured. Set the required Firestore environment variables and redeploy.',
    });
  }
  next();
});
app.use('/api/online', onlineRouter());
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

export default app;
