import { test, expect } from '@playwright/test';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// These fixed demo endpoints never use the project's production Firebase config.
process.env.METADATA_SERVER_DETECTION = 'none';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9100';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8182';
const fixture = initializeApp({ projectId: 'demo-catan-browser' }, 'browser-ui-fixture');
const database = getFirestore(fixture);
const accounts = getAuth(fixture);
const uid = 'catan-browser-owner';
const email = 'ui-owner@catan.test';
const password = 'Owner-browser-fixture-123!';
test.beforeAll(async () => {
  await database.recursiveDelete(database.doc('catan/rankings'));
  await accounts.deleteUser(uid).catch(() => {});
  await accounts.createUser({ uid, email, password });
});
test.afterAll(async () => {
  await database.recursiveDelete(database.doc('catan/rankings'));
  await accounts.deleteUser(uid).catch(() => {});
  await database.terminate();
  await deleteApp(fixture);
});
test('browser owner sign-in, shared game records, persistence and logout use Firebase directly', async ({
  page,
  browser,
}) => {
  const serverRankingsRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/rankings')) serverRankingsRequests.push(request.url());
  });
  await page.goto('/#rankings');
  await expect(page.getByRole('heading', { name: 'Rankings of the Realm' })).toBeVisible();
  await page.getByRole('button', { name: 'Owner sign in', exact: true }).click();
  await page.getByLabel('Owner email', { exact: true }).fill(email);
  await page.getByLabel('Owner password', { exact: true }).fill('incorrect-password');
  await page.getByRole('button', { name: 'Unlock editing' }).click();
  await expect(page.getByRole('alert')).toContainText('incorrect');
  await page.getByLabel('Owner password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Unlock editing' }).click();
  await expect(page.getByRole('button', { name: 'Lock editing' })).toBeVisible();
  await page.getByRole('button', { name: 'Record game', exact: true }).first().click();
  await page.getByLabel('Player 1 name', { exact: true }).fill('Ada');
  await page.getByLabel('Player 2 name', { exact: true }).fill('Bob');
  await page.getByLabel('Player 1 settlements', { exact: true }).fill('3');
  await page.getByLabel('Player 1 cities', { exact: true }).fill('2');
  await page.getByLabel('Player 1 victory point cards', { exact: true }).fill('1');
  await page.getByLabel('Player 1 Longest Road', { exact: true }).check();
  await page.getByRole('button', { name: 'Save game', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const table = page.getByRole('table', { name: /Players ranked by total victory points/ });
  await expect(
    table
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name: 'Ada', exact: true }) })
      .getByRole('cell')
      .last(),
  ).toHaveText('10');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Lock editing' })).toBeVisible();
  await expect(table).toContainText('Ada');
  const visitor = await browser.newContext();
  const publicPage = await visitor.newPage();
  await publicPage.goto('http://127.0.0.1:5199/#rankings');
  await expect(
    publicPage.getByRole('table', { name: /Players ranked by total victory points/ }),
  ).toContainText('Ada');
  await expect(publicPage.getByRole('button', { name: 'Record game', exact: true })).toHaveCount(0);
  await visitor.close();
  await page.getByRole('button', { name: /Edit game/ }).click();
  await page.getByLabel('Player 1 other victory points', { exact: true }).fill('2');
  await page.evaluate(async () => {
    const entry = '/src/rankings/client.ts';
    const client = await import(entry);
    const { data } = await client.loadRankings();
    data.games[0].notes = 'Another owner edit arrived while the dialog was open.';
    await client.saveRankings(data);
  });
  await page.getByRole('button', { name: 'Save game', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('draft is still here');
  await expect(page.getByLabel('Player 1 other victory points', { exact: true })).toHaveValue('2');
  await page.getByRole('button', { name: 'Review latest changes' }).click();
  await page.getByRole('button', { name: 'Keep my draft with the latest ledger' }).click();
  await page.getByRole('button', { name: 'Save game', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    table
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name: 'Ada', exact: true }) })
      .getByRole('cell')
      .last(),
  ).toHaveText('12');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/firebase-rankings-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Lock editing' }).click();
  await expect(page.getByRole('button', { name: 'Record game', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Owner sign in', exact: true })).toBeVisible();
  expect(serverRankingsRequests).toEqual([]);
});
