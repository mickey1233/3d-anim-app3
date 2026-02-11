import { test, expect } from '@playwright/test';

test.describe('v2 mate rotation modes', () => {
  test('translate mode does not rotate', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('http://127.0.0.1:5173/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.parts.order.length >= 2;
    });

    const result = await page.evaluate(async () => {
      const store = (window as any).__V2_STORE__;
      const state = store.getState();
      const sourceId = state.parts.order.find((id: string) => state.parts.byId[id]?.name === 'part1');
      const targetId = state.parts.order.find((id: string) => state.parts.byId[id]?.name === 'part4');
      if (!sourceId || !targetId) return null;
      const before = state.getPartTransform(sourceId)?.quaternion || [0, 0, 0, 1];
      store.getState().requestMate({
        sourceId,
        targetId,
        sourceFace: 'bottom',
        targetFace: 'top',
        mode: 'translate',
      });
      const waitFor = (predicate: () => boolean) =>
        new Promise<void>((resolve) => {
          const tick = () => {
            if (predicate()) resolve();
            else requestAnimationFrame(tick);
          };
          tick();
        });
      await waitFor(() => !!store.getState().parts.overridesById[sourceId]);
      const after = store.getState().getPartTransform(sourceId)?.quaternion || [0, 0, 0, 1];
      return { before, after };
    });

    expect(result).not.toBeNull();
    if (result) {
      const [bx, by, bz, bw] = result.before;
      const [ax, ay, az, aw] = result.after;
      const diff = Math.abs(bx - ax) + Math.abs(by - ay) + Math.abs(bz - az) + Math.abs(bw - aw);
      expect(diff).toBeLessThan(1e-3);
    }
  });
});
