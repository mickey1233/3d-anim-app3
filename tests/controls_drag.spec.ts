import { test, expect } from '@playwright/test';

test.describe('Controls: Orbit disabled while TransformControls dragging', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:5173/?v=2', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
  });

  test('toggles OrbitControls.enabled based on dragging state', async ({ page }) => {
    await page.evaluate(() => (window as any).__V2_STORE__.getState().setTransformDragging(false));
    await page.waitForFunction(() => typeof (window as any).__V2_ORBIT_ENABLED__ === 'boolean');
    await expect.poll(() => page.evaluate(() => (window as any).__V2_ORBIT_ENABLED__)).toBe(true);

    await page.evaluate(() => (window as any).__V2_STORE__.getState().setTransformDragging(true));

    await expect
      .poll(() => page.evaluate(() => (window as any).__V2_ORBIT_ENABLED__))
      .toBe(false);

    await page.evaluate(() => (window as any).__V2_STORE__.getState().setTransformDragging(false));

    await expect
      .poll(() => page.evaluate(() => (window as any).__V2_ORBIT_ENABLED__))
      .toBe(true);

    await page.screenshot({ path: 'test-results/S2-controls-drag.png', fullPage: true });
  });
});
