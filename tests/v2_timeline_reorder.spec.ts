import { test, expect } from '@playwright/test';

test.describe('v2 timeline reorder', () => {
  test('reorders steps in store', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('http://127.0.0.1:5173/?v=2', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);

    const order = await page.evaluate(() => {
      const store = (window as any).__V2_STORE__;
      store.getState().addStep('Step 1');
      store.getState().addStep('Step 2');
      const [a, b] = store.getState().steps.list.map((s: any) => s.id);
      store.getState().moveStep(b, a);
      return store.getState().steps.list.map((s: any) => s.label);
    });

    expect(order[0]).toBe('Step 2');
  });
});
