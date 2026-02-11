import { test, expect } from '@playwright/test';

test.describe('v2 scrubbable numbers', () => {
  test('dragging position value updates transform', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('http://127.0.0.1:5173/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.parts.order.length >= 2;
    });
    await page.waitForFunction(() => (window as any).__V2_STORE__?.getState?.().connection.wsConnected === true);

    const initial = await page.evaluate(() => {
      const store = (window as any).__V2_STORE__;
      const state = store.getState();
      const partId = state.parts.order.find((id: string) => state.parts.byId[id]?.name === 'part1');
      if (!partId) return null;
      store.setState({ selection: { partId } });
      return state.getPartTransform(partId)?.position[0] ?? 0;
    });
    expect(initial).not.toBeNull();

    const locator = page.getByTestId('position-x');
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2);
    await page.mouse.up();

    await page.waitForFunction(
      (initialValue) => {
        const store = (window as any).__V2_STORE__;
        const state = store?.getState?.();
        const partId = state?.selection?.partId;
        const next = partId ? state.getPartTransform(partId)?.position?.[0] : null;
        return typeof next === 'number' && typeof initialValue === 'number' && next > initialValue + 1e-6;
      },
      initial,
      { timeout: 5000 }
    );

    const after = await page.evaluate(() => {
      const store = (window as any).__V2_STORE__;
      const state = store.getState();
      const partId = state.selection.partId;
      if (!partId) return null;
      return state.getPartTransform(partId)?.position[0] ?? null;
    });
    expect(after).not.toBeNull();
    if (after !== null && initial !== null) {
      expect(after).toBeGreaterThan(initial);
    }
  });
});
