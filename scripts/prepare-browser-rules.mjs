import { readFile, writeFile } from 'node:fs/promises';

const template = await readFile(new URL('../firestore.rules.example', import.meta.url), 'utf8');
if (
  !template.includes('match /catan/rankings') ||
  /allow\s+[^:;]*(?:write|create|update|delete)\s*[:;,]/.test(template)
) {
  throw new Error('The production rules template must grant only the exact public rankings reads.');
}
await writeFile(
  new URL('../tests/firestore.browser.rules', import.meta.url),
  '// GENERATED emulator fixture. Run scripts/prepare-browser-rules.mjs; do not deploy.\n' +
    template,
);
console.log('Prepared browser emulator rules from firestore.rules.example.');
