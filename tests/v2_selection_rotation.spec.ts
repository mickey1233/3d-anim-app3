import { test, expect } from '@playwright/test';

test.describe('v2 selection rotation', () => {
  test('shows rotation values for selected part', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('http://127.0.0.1:5173/?v=2', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.parts.order.length > 0;
    });

    const partId = await page.evaluate(() => (window as any).__V2_STORE__.getState().parts.order[0]);

    await page.evaluate((id) => {
      const store = (window as any).__V2_STORE__;
      const state = store.getState();
      const transform = state.getPartTransform(id);
      if (!transform) return;
      const angle = Math.PI / 2;
      const q: [number, number, number, number] = [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
      store.setState({
        selection: { partId: id },
        parts: { ...state.parts, overridesById: { ...state.parts.overridesById, [id]: { ...transform, quaternion: q } } },
      });
    }, partId);

    await expect(page.getByTestId('rotation-z')).toHaveText(/90\.0/);
  });
});
