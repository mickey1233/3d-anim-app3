import { test, expect } from '@playwright/test';

test.describe('v2 mate trace', () => {
  test('records pivot/axis for twist', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('http://127.0.0.1:5173/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.parts.order.length >= 2;
    });

    const trace = await page.evaluate(async () => {
      const store = (window as any).__V2_STORE__;
      const state = store.getState();
      const sourceId = state.parts.order.find((id: string) => state.parts.byId[id]?.name === 'part1');
      const targetId = state.parts.order.find((id: string) => state.parts.byId[id]?.name === 'part4');
      if (!sourceId || !targetId) return null;
      store.getState().requestMate({
        sourceId,
        targetId,
        sourceFace: 'bottom',
        targetFace: 'top',
        mode: 'twist',
        twistSpec: { axisSpace: 'world', axis: 'y', angleDeg: 45 },
      });
      const waitFor = (predicate: () => boolean) =>
        new Promise<void>((resolve) => {
          const tick = () => {
            if (predicate()) resolve();
            else requestAnimationFrame(tick);
          };
          tick();
        });
      await waitFor(() => !!store.getState().mateTrace);
      return store.getState().mateTrace;
    });

    expect(trace).not.toBeNull();
    if (trace) {
      expect(trace.mode).toBe('twist');
      expect(trace.pivotWorld.length).toBe(3);
      expect(trace.twist).toBeTruthy();
    }
  });
});
