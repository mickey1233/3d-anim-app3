import { test, expect, type Page } from '@playwright/test';

async function openLegacyAnimationPanel(page: Page) {
  const loadDemo = page.getByText('Load Demo (Spark.glb)');
  if ((await loadDemo.count()) === 0) {
    await page.getByRole('button', { name: /markers & animation/i }).click();
  }
  await expect(loadDemo).toBeVisible();
  await loadDemo.scrollIntoViewIfNeeded();
  return loadDemo;
}

test.describe('UI: Parts list', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:5274', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__APP_STORE__?.getState);
  });

  test('searches and selects a part', async ({ page }) => {
    await (await openLegacyAnimationPanel(page)).click();

    await page.waitForFunction(() => {
      const store = (window as any).__APP_STORE__?.getState?.();
      return !!store?.parts && Object.keys(store.parts).length > 0;
    });

    await page.getByTestId('parts-search').fill('Part');

    const firstItem = page.getByTestId('parts-list-item').first();
    await firstItem.click();

    await expect
      .poll(() => page.evaluate(() => (window as any).__DEBUG_SELECTED_PART__))
      .not.toBeNull();
  });
});
