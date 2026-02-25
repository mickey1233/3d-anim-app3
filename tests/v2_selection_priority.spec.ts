import { test, expect } from '@playwright/test';

test.describe('v2 selection priority', () => {
  test('dropdown selection blocks canvas selection', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.parts.order.length >= 2;
    });

    const result = await page.evaluate(() => {
      const store = (window as any).__V2_STORE__;
      const state = store.getState();
      const partA = state.parts.order[0];
      const partB = state.parts.order[1];
      store.getState().setSelection(partA, 'dropdown');
      store.getState().setSelection(partB, 'canvas');
      return store.getState().selection;
    });

    expect(result.partId).toBeTruthy();
    expect(result.source).toBe('dropdown');
  });
});
