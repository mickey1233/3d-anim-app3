import { test, expect } from '@playwright/test';

test.describe('UI: Parts list', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__APP_STORE__?.getState);
  });

  test('searches and selects a part', async ({ page }) => {
    await page.getByText('Load Demo (Spark.glb)').click();

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

