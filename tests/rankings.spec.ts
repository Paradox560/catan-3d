import type { Page } from '@playwright/test';
import { test, expect } from './rankings-fixture';

const password = 'private-ledger-test-passphrase';
const username = 'ledger-owner';

async function signInOwner(page: Page, url: string) {
  await page.goto(`${url}/#rankings`);
  await page.getByRole('button', { name: 'Owner sign in', exact: true }).click();
  await page.getByLabel('Owner username', { exact: true }).fill(username);
  await page.getByLabel('Owner password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Unlock editing' }).click();
  await expect(page.getByRole('button', { name: 'Lock editing' })).toBeVisible();
}

function standings(page: Page) {
  return page.getByRole('table', { name: /Players ranked by total victory points/ });
}
async function scoreIs(page: Page, name: string, points: number) {
  const row = standings(page)
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name, exact: true }) });
  await expect(row.getByRole('cell').last()).toHaveText(String(points));
}
async function recordFirstGame(page: Page) {
  await page.getByRole('button', { name: 'Record game', exact: true }).first().click();
  await page.getByLabel('Game date', { exact: true }).fill('2026-09-30');
  await page.getByLabel('Player 1 name', { exact: true }).fill('Ada');
  await page.getByLabel('Player 2 name', { exact: true }).fill('Bob');
  await page.getByLabel('Player 1 settlements', { exact: true }).fill('3');
  await page.getByLabel('Player 1 cities', { exact: true }).fill('2');
  await page.getByLabel('Player 1 victory point cards', { exact: true }).fill('1');
  await page.getByLabel('Player 1 Longest Road', { exact: true }).check();
  await page.getByLabel('Player 2 settlements', { exact: true }).fill('2');
  await page.getByLabel('Player 2 cities', { exact: true }).fill('1');
  await page.getByLabel('Player 2 victory point cards', { exact: true }).fill('1');
  await expect(page.getByLabel('Player 1 total victory points')).toContainText('10');
  await page.getByRole('button', { name: 'Save game', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await scoreIs(page, 'Ada', 10);
  await scoreIs(page, 'Bob', 5);
}

test('owner records, edits, renames and deletes games; public visitors only read', async ({
  page,
  browser,
  rankingsURL,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signInOwner(page, rankingsURL);
  await recordFirstGame(page);

  await page.getByRole('button', { name: 'Record game', exact: true }).click();
  await page.getByLabel('Game date', { exact: true }).fill('2026-10-01');
  await page.getByLabel('Player 1 settlements', { exact: true }).fill('2');
  await page.getByLabel('Player 1 cities', { exact: true }).fill('1');
  await page.getByLabel('Player 2 settlements', { exact: true }).fill('3');
  await page.getByLabel('Player 2 cities', { exact: true }).fill('2');
  await page.getByLabel('Player 2 victory point cards', { exact: true }).fill('1');
  await page.getByLabel('Player 2 Largest Army', { exact: true }).check();
  await page.getByRole('button', { name: 'Save game', exact: true }).click();
  await scoreIs(page, 'Ada', 14);
  await scoreIs(page, 'Bob', 15);
  await expect(standings(page).getByRole('row').nth(1)).toContainText('Bob');

  await page
    .getByRole('button', { name: /Edit game/ })
    .last()
    .click();
  await page.getByLabel('Game date', { exact: true }).fill('2026-09-29');
  await page.getByLabel('Player 1 other victory points', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Save game', exact: true }).click();
  await scoreIs(page, 'Ada', 16);
  await expect(standings(page).getByRole('row').nth(1)).toContainText('Ada');
  await page.getByRole('button', { name: 'Manage players', exact: true }).click();
  await page.getByLabel('Rename Bob', { exact: true }).fill('Bobby');
  await page.getByRole('button', { name: 'Save players', exact: true }).click();
  await scoreIs(page, 'Bobby', 15);
  await page.screenshot({ path: 'test-results/rankings-desktop.png', fullPage: true });

  const visitor = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    const publicPage = await visitor.newPage();
    await publicPage.goto(`${rankingsURL}/#rankings`);
    await scoreIs(publicPage, 'Ada', 16);
    await expect(publicPage.getByRole('button', { name: 'Record game', exact: true })).toHaveCount(
      0,
    );
    await expect(publicPage.getByRole('button', { name: /Edit game/ })).toHaveCount(0);
    await publicPage.getByRole('button', { name: 'View victory point breakdown' }).first().click();
    await expect(publicPage.getByRole('table', { name: /Victory point breakdown/ })).toBeVisible();
  } finally {
    await visitor.close();
  }

  await page
    .getByRole('button', { name: /Delete game/ })
    .first()
    .click();
  await page
    .getByRole('dialog', { name: 'Delete game', exact: true })
    .getByRole('button', { name: 'Delete game', exact: true })
    .click();
  await scoreIs(page, 'Ada', 12);
  await scoreIs(page, 'Bobby', 5);
  await page.reload();
  await scoreIs(page, 'Ada', 12);
  await expect(page.getByRole('button', { name: 'Lock editing' })).toBeVisible();
  await page.getByRole('button', { name: 'Lock editing' }).click();
  await expect(page.getByRole('button', { name: 'Record game', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Owner sign in', exact: true }).click();
  await page.getByLabel('Owner username', { exact: true }).fill('wrong-owner');
  await page.getByLabel('Owner password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Unlock editing' }).click();
  await expect(page.getByRole('alert')).toContainText('incorrect');
  await page.getByLabel('Owner username', { exact: true }).fill(username);
  await page.getByLabel('Owner password', { exact: true }).fill('incorrect-password');
  await page.getByRole('button', { name: 'Unlock editing' }).click();
  await expect(page.getByRole('alert')).toContainText('incorrect');
  await page.getByLabel('Owner password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Unlock editing' }).click();
  await expect(page.getByRole('button', { name: 'Lock editing' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('six-player records and their breakdown work on mobile; navigation returns to the island', async ({
  page,
  rankingsURL,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInOwner(page, rankingsURL);
  await page.getByRole('button', { name: 'Record game', exact: true }).first().click();
  for (let index = 1; index <= 6; index++) {
    if (index > 2) await page.getByRole('button', { name: 'Add player', exact: true }).click();
    await page.getByLabel(`Player ${index} name`, { exact: true }).fill(`Explorer ${index}`);
    await page.getByLabel(`Player ${index} settlements`, { exact: true }).fill('2');
    await page.getByLabel(`Player ${index} cities`, { exact: true }).fill(String(index % 4));
    if (index === 2) {
      await page.screenshot({ path: 'test-results/rankings-mobile-editor.png' });
    }
  }
  await expect(page.getByRole('button', { name: 'Add player', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save game', exact: true }).click();
  await expect(standings(page).getByRole('row')).toHaveCount(7);
  const totalColumn = await standings(page)
    .getByRole('columnheader', { name: 'Total VP', exact: true })
    .boundingBox();
  expect(totalColumn).not.toBeNull();
  expect(totalColumn!.x).toBeGreaterThanOrEqual(0);
  expect(totalColumn!.x + totalColumn!.width).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'View victory point breakdown' }).click();
  await expect(
    page.getByRole('table', { name: /Victory point breakdown/ }).getByRole('row'),
  ).toHaveCount(7);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/rankings-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Back to Catan' }).click();
  await expect(page.getByRole('button', { name: 'Rankings', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: /Interactive 3D island/ })).toBeVisible();
  await page.getByRole('button', { name: 'Rankings', exact: true }).click();
  await expect(standings(page).getByRole('row')).toHaveCount(7);
});

test('a conflict or expired session preserves the owner draft', async ({ page, rankingsURL }) => {
  await signInOwner(page, rankingsURL);
  await recordFirstGame(page);
  await page.getByRole('button', { name: /Edit game/ }).click();
  await page.getByLabel('Player 1 other victory points', { exact: true }).fill('2');
  const latest = await page.request
    .get(`${rankingsURL}/api/rankings`)
    .then((response) => response.json());
  latest.data.games.push({
    ...latest.data.games[0],
    id: 'another-owners-game',
    date: '2026-09-28',
    notes: 'Another owner tab recorded this game.',
  });
  const remoteSave = await page.request.put(`${rankingsURL}/api/rankings`, {
    headers: { Origin: rankingsURL },
    data: latest.data,
  });
  expect(remoteSave.status()).toBe(200);
  await page.getByRole('button', { name: 'Save game', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('draft is still here');
  await expect(page.getByLabel('Player 1 other victory points', { exact: true })).toHaveValue('2');
  await expect(page.getByRole('button', { name: 'Save game', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Review latest changes' }).click();
  await expect(page.getByText('Latest ledger · 2 games')).toBeVisible();
  await page.getByRole('button', { name: 'Keep my draft with the latest ledger' }).click();
  await page.getByRole('button', { name: 'Save game', exact: true }).click();
  await scoreIs(page, 'Ada', 22);
  await expect(page.getByRole('button', { name: /Edit game/ })).toHaveCount(2);

  await page
    .getByRole('button', { name: /Edit game/ })
    .first()
    .click();
  await page.getByLabel('Player 1 other victory points', { exact: true }).fill('3');
  await page.request.post(`${rankingsURL}/api/rankings/logout`, {
    headers: { Origin: rankingsURL },
    data: {},
  });
  await page.getByRole('button', { name: 'Save game', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Owner sign in', exact: true })).toBeVisible();
  await page.getByLabel('Owner username', { exact: true }).fill(username);
  await page.getByLabel('Owner password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Unlock editing' }).click();
  await expect(page.getByLabel('Player 1 other victory points', { exact: true })).toHaveValue('3');
  await page.getByRole('button', { name: 'Save game', exact: true }).click();
  await scoreIs(page, 'Ada', 23);
});

test.describe('owner configuration is controlled by environment variables', () => {
  test.use({ ownerConfigured: false });
  test('public ledger stays readable without offering account creation', async ({
    page,
    rankingsURL,
  }) => {
    await page.goto(`${rankingsURL}/#rankings`);
    await expect(page.getByRole('heading', { name: 'Rankings of the Realm' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Owner sign in', exact: true })).toBeDisabled();
    await expect(
      page.getByText('Owner access has not been configured. The ledger is available to read.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Set up owner access' })).toHaveCount(0);
    const takeover = await page.request.post(`${rankingsURL}/api/rankings/setup`, {
      headers: { Origin: rankingsURL },
      data: { username, password },
    });
    expect(takeover.status()).toBe(403);
    const publicLedger = await page.request.get(`${rankingsURL}/api/rankings`);
    expect(publicLedger.status()).toBe(200);
    expect((await publicLedger.json()).access).toEqual({
      configured: false,
      authenticated: false,
      canSetup: false,
    });
  });
});
