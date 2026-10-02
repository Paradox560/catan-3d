import { readFile, writeFile } from 'node:fs/promises';

const template = await readFile(new URL('../firestore.rules.example', import.meta.url), 'utf8');
if (!template.includes("request.auth.uid == '__CATAN_OWNER_UID__'")) {
  throw new Error('The production rules template must contain the expected owner UID placeholder.');
}
await writeFile(
  new URL('../tests/firestore.browser.rules', import.meta.url),
  '// GENERATED emulator fixture. Run scripts/prepare-browser-rules.mjs; do not deploy.\n' +
    template.replaceAll('__CATAN_OWNER_UID__', 'catan-browser-owner'),
);
console.log('Prepared browser emulator rules from firestore.rules.example.');
