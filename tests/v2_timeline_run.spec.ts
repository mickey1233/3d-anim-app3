import { test, expect } from '@playwright/test';

test.describe('v2 timeline run', () => {
  test('plays steps sequentially with animation', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.parts.order.length >= 1;
    });

    const partId = await page.evaluate(() => {
      const store = (window as any).__V2_STORE__;
      return store.getState().parts.order[0];
    });

    await page.evaluate((pid) => {
      const store = (window as any).__V2_STORE__;
      const state = store.getState();
      const base = state.getPartTransform(pid);
      if (!base) return;
      state.setPartOverride(pid, {
        ...base,
        position: [base.position[0] + 0.2, base.position[1], base.position[2]],
      });
      state.addStep('Step A');
      state.setPartOverride(pid, {
        ...base,
        position: [base.position[0] + 0.4, base.position[1], base.position[2]],
      });
      state.addStep('Step B');
      state.startPlayback(200);
    }, partId);

    await page.waitForFunction(() => !(window as any).__V2_STORE__?.getState?.().playback.running, null, { timeout: 5000 });

    const finalPos = await page.evaluate((pid) => {
      const store = (window as any).__V2_STORE__;
      const t = store.getState().getPartTransform(pid);
      return t?.position || null;
    }, partId);

    expect(finalPos).not.toBeNull();
    if (finalPos) {
      expect(finalPos[0]).toBeGreaterThan(0.35);
    }
  });
});
