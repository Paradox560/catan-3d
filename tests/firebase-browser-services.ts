// Browser-test fixture only: the production initializer contains no emulator hooks.
import { initializeApp } from 'firebase/app';
import {
  browserSessionPersistence,
  connectAuthEmulator,
  getAuth,
  setPersistence,
} from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
const app = initializeApp(
  {
    apiKey: 'demo-browser-key',
    authDomain: 'demo-catan-browser.firebaseapp.com',
    projectId: 'demo-catan-browser',
    appId: '1:123456789:web:abcdef123456',
  },
  'catan-browser-ui',
);
const auth = getAuth(app);
connectAuthEmulator(auth, 'http://127.0.0.1:9100', { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, '127.0.0.1', 8182);
const ready = setPersistence(auth, browserSessionPersistence).then(() => auth.authStateReady());
export const getFirebaseServices = () => ({ db, auth, ready });
