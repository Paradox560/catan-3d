// Exercise the same Express entry point and browser transport deployed on Vercel.
// This fixture cannot access the real Firebase project or local room saves.
import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

if (!process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error('Start the local Firestore emulator before running HTTP browser tests.');
process.env.NODE_ENV = 'test';
process.env.RANKINGS_STORAGE = 'firestore';
process.env.FIREBASE_PROJECT_ID = 'demo-catan-browser';
process.env.FIRESTORE_RANKINGS_DOCUMENT = `browser-tests/${randomUUID()}`;
delete process.env.FIRESTORE_DATABASE_ID;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
delete process.env.RANKINGS_ADMIN_USERNAME;
delete process.env.RANKINGS_ADMIN_PASSWORD;

const { default: app } = await import('../api/index');
const { createRankingsFirestore } = await import('../server/firebase');
const connection = createRankingsFirestore();
app.use(express.static(path.resolve('dist')));
const server = app.listen(4317, '127.0.0.1');
async function stop() {
  server.close();
  await connection.firestore.recursiveDelete(connection.firestore.doc(connection.documentPath));
  await connection.close();
  process.exit(0);
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
