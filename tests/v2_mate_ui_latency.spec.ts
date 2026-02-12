import { test, expect } from '@playwright/test';

test.describe('v2 mate panel responsiveness', () => {
  test('keeps option switching responsive on fixture scene', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5173/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.parts.order.length >= 2;
    });

    await page.evaluate(() => {
      const store = (window as any).__V2_STORE__.getState();
      store.setWorkspaceSection('mate');
      const [sourceId, targetId] = store.parts.order;
      store.setMateDraft({ sourceId, targetId });
    });

    const measureSelect = async (
      selector: string,
      option: string,
      settleMs = 80
    ) => {
      const locator = page.locator(selector).first();
      const start = Date.now();
      await locator.selectOption(option);
      await page.waitForTimeout(settleMs);
      return Date.now() - start;
    };

    const timings = {
      sourceFace: await measureSelect('[data-testid="mate-source-face"]', 'bottom'),
      targetFace: await measureSelect('[data-testid="mate-target-face"]', 'top'),
      sourceMethod: await measureSelect('[data-testid="mate-source-method"]', 'geometry_aabb'),
      targetMethod: await measureSelect('[data-testid="mate-target-method"]', 'geometry_aabb'),
      mateMode: await measureSelect('[data-testid="mate-mode"]', 'both'),
    };

    const maxLatency = Math.max(...Object.values(timings));
    expect(maxLatency).toBeLessThan(600);
  });
});
