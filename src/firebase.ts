import { getApps, initializeApp, type FirebaseOptions } from 'firebase/app';
import { getFirestore, type Firestore } from 'firebase/firestore';

const CONFIG_FIELDS = {
  apiKey: 'VITE_FIREBASE_API_KEY',
  authDomain: 'VITE_FIREBASE_AUTH_DOMAIN',
  projectId: 'VITE_FIREBASE_PROJECT_ID',
  appId: 'VITE_FIREBASE_APP_ID',
  storageBucket: 'VITE_FIREBASE_STORAGE_BUCKET',
  messagingSenderId: 'VITE_FIREBASE_MESSAGING_SENDER_ID',
  measurementId: 'VITE_FIREBASE_MEASUREMENT_ID',
} as const;
const CONFIG_ERROR =
  'Set the Firebase web app configuration in Vercel and redeploy to connect the shared rankings.';

/** These are public Firebase app identifiers. Passwords and private keys never belong here. */
export function parseFirebaseConfig(
  env: Record<string, unknown> = {
    VITE_FIREBASE_API_KEY: import.meta.env.VITE_FIREBASE_API_KEY,
    VITE_FIREBASE_AUTH_DOMAIN: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    VITE_FIREBASE_PROJECT_ID: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    VITE_FIREBASE_APP_ID: import.meta.env.VITE_FIREBASE_APP_ID,
    VITE_FIREBASE_STORAGE_BUCKET: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    VITE_FIREBASE_MESSAGING_SENDER_ID: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    VITE_FIREBASE_MEASUREMENT_ID: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
  },
): FirebaseOptions {
  const options: FirebaseOptions = {};
  for (const [field, name] of Object.entries(CONFIG_FIELDS)) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > 2_048 ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new Error(CONFIG_ERROR);
    }
    options[field as keyof FirebaseOptions] = value.trim();
  }
  if (
    !options.apiKey ||
    !/^[A-Za-z0-9_-]{6,256}$/.test(options.apiKey) ||
    !options.authDomain ||
    !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(
      options.authDomain,
    ) ||
    !options.projectId ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.projectId) ||
    !options.appId ||
    !/^1:[1-9][0-9]*:web:[a-zA-Z0-9]+$/.test(options.appId) ||
    (options.messagingSenderId && options.messagingSenderId !== options.appId.split(':')[1])
  )
    throw new Error(CONFIG_ERROR);
  return options;
}

export interface FirebaseServices {
  db: Firestore;
}
let services: FirebaseServices | undefined;

/** The browser Firebase SDK reads public rankings; owner actions use the server API. */
export function getFirebaseServices(): FirebaseServices {
  if (services) return services;
  const config = parseFirebaseConfig();
  const app =
    getApps().find((entry) => entry.name === 'catan-rankings-browser') ??
    initializeApp(config, 'catan-rankings-browser');
  const db = getFirestore(app);
  services = { db };
  return services;
}
