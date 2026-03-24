import { test, expect } from '@playwright/test';

test.describe('v2 mate markers visibility', () => {
  test('does not show Source/Target markers on initial non-mate context', async ({ page }) => {
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.parts.order.length >= 2;
    });

    await expect(page.getByText('Source', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Target', { exact: true })).toHaveCount(0);

    await page.evaluate(() => {
      const store = (window as any).__V2_STORE__.getState();
      const sourceId = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part1');
      const targetId = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part2');
      store.setWorkspaceSection('mate');
      store.setMateDraft({
        sourceId,
        targetId,
        sourceFace: 'bottom',
        targetFace: 'top',
      });
    });

    await page.waitForTimeout(120);
    await expect(page.getByText('Source', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Target', { exact: true })).toHaveCount(0);
  });
});
