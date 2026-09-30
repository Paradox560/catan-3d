import { test, expect, type Page } from '@playwright/test';

async function placePair(page: Page) {
  await expect(page.locator('.actions-panel h2')).toContainText(/Place your/);
  if (!(await page.getByRole('button', { name: 'Place', exact: true }).isVisible()))
    await page.getByText('Keyboard placement', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Build location' }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Place', exact: true }).click();
  await expect(page.locator('.actions-panel h2')).toHaveText('Connect your settlement');
  // The same disclosure remains open when the founding phase changes.
  const summary = page.getByText('Keyboard placement', { exact: true });
  if (!(await page.getByRole('button', { name: 'Place', exact: true }).isVisible()))
    await summary.click();
  await page.getByRole('button', { name: 'Place', exact: true }).click();
}

test('four local players complete founding, roll, save, and resume', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('tab', { name: 'Local play' }).click();
  await page.getByRole('button', { name: 'Set sail', exact: true }).click();
  const order = [0, 1, 2, 3, 3, 2, 1, 0];
  for (let i = 0; i < 8; i++) {
    if (i === 0 || order[i] !== order[i - 1]) {
      await expect(page.getByRole('button', { name: 'I’m ready' })).toBeVisible();
      await page.getByRole('button', { name: 'I’m ready' }).click();
    }
    await placePair(page);
  }
  await expect(page.getByRole('button', { name: 'Roll the dice' })).toBeEnabled();
  await page.getByRole('button', { name: 'Roll the dice' }).click();
  await expect(page.locator('.dice-result strong')).not.toHaveText('—');
  await page.screenshot({ path: 'test-results/local-game.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: 'Resume local game' }).click();
  await page.getByRole('button', { name: 'I’m ready' }).click();
  await expect(page.locator('.player-card')).toHaveCount(4);
  await expect(page.locator('.dice-result strong')).not.toHaveText('—');
  expect(errors).toEqual([]);
});

for (const capacity of [4, 6])
  test(`${capacity} online players join a private room and complete setup`, async ({ browser }) => {
    test.setTimeout(capacity === 6 ? 240_000 : 120_000);
    const contexts = await Promise.all(
      Array.from({ length: capacity }, () =>
        browser.newContext({ viewport: { width: 1280, height: 900 } }),
      ),
    );
    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    const errors: string[] = [];
    pages.forEach((page) => page.on('pageerror', (e) => errors.push(e.message)));
    try {
      const host = pages[0];
      await host.goto('/');
      await host.getByRole('textbox', { name: 'YOUR NAME' }).fill('Captain');
      if (capacity === 6) await host.getByRole('button', { name: '5–6 extension' }).click();
      await host.getByRole('button', { name: 'Create an online table' }).click();
      await expect(host.locator('.room-code')).toBeVisible();
      const code = (await host.locator('.room-code>span').innerText())
        .replace('ROOM CODE', '')
        .trim();
      for (let i = 1; i < capacity; i++) {
        const p = pages[i];
        await p.goto(`/?room=${code}`);
        await p.getByRole('textbox', { name: 'YOUR NAME' }).fill(`Explorer ${i + 1}`);
        await p.getByRole('button', { name: 'Join the adventure' }).click();
        await expect(p.locator('.room-code')).toBeVisible();
      }
      await expect(host.locator('.lobby-seat.filled')).toHaveCount(capacity);
      await host.getByRole('button', { name: 'Begin the adventure' }).click();
      for (const p of pages) await expect(p.locator('.player-card')).toHaveCount(capacity);
      const order = [
        ...Array.from({ length: capacity }, (_, i) => i),
        ...Array.from({ length: capacity }, (_, i) => capacity - 1 - i),
      ];
      for (const index of order) await placePair(pages[index]);
      await expect(host.getByRole('button', { name: 'Roll the dice' })).toBeEnabled();
      await expect(pages[1].getByRole('button', { name: 'Roll the dice' })).toBeDisabled();
      await host.screenshot({ path: `test-results/online-${capacity}-game.png`, fullPage: true });
      // A refresh keeps the seat token; the explicit rejoin flow restores it.
      await pages[1].reload();
      await pages[1].getByRole('button', { name: 'Rejoin online table' }).click();
      await expect(pages[1].locator('.player-card')).toHaveCount(capacity);
      await host.getByRole('button', { name: 'Roll the dice' }).click();
      const robber = host
        .locator('.actions-panel h2')
        .filter({ hasText: 'Choose a new home for the robber' });
      await expect(host.locator('.dice-result strong')).not.toHaveText('—');
      if (await robber.isVisible()) {
        await host.getByText('Keyboard robber movement', { exact: true }).click();
        await host.getByRole('button', { name: 'Move', exact: true }).click();
        const victim = host.getByRole('button', { name: /Steal from/ }).first();
        if (await victim.isVisible()) await victim.click();
      }
      await host.getByRole('button', { name: 'Finish turn', exact: true }).click();
      const next = capacity === 6 ? pages[3] : pages[1];
      await expect(next.locator('.turn-label')).toContainText('YOUR TURN');
      if (capacity === 6) {
        await expect(next.locator('.turn-label')).toContainText('PAIRED');
        await expect(next.getByRole('button', { name: 'Trade', exact: true })).toBeEnabled();
        await next.getByRole('button', { name: 'Trade', exact: true }).click();
        await expect(next.getByRole('button', { name: 'Explorers', exact: true })).toBeDisabled();
      }
      expect(errors).toEqual([]);
    } finally {
      for (const c of contexts) await c.close();
    }
  });

test('mobile welcome, room selection and guide remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Local play' }).click();
  await page.getByRole('button', { name: '5–6 extension' }).click();
  await expect(page.getByRole('textbox', { name: 'Player 6 name' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Field guide' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/mobile-welcome.png', fullPage: true });
});
