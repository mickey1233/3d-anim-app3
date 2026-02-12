import { test, expect } from '@playwright/test';

test.describe('v2 mate methods', () => {
  test('supports method selection per side', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('http://127.0.0.1:5173/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.parts.order.length >= 2;
    });

    const preview = await page.evaluate(async () => {
      const store = (window as any).__V2_STORE__;
      const state = store.getState();
      const sourceId = state.parts.order[0];
      const targetId = state.parts.order[1];
      store.getState().setWorkspaceSection('mate');
      store.getState().setMateDraft({
        sourceId,
        targetId,
        sourceFace: 'bottom',
        targetFace: 'top',
        sourceMethod: 'geometry_aabb',
        targetMethod: 'planar_cluster',
      });
      const waitFor = (predicate: () => boolean) =>
        new Promise<void>((resolve) => {
          const tick = () => {
            if (predicate()) resolve();
            else requestAnimationFrame(tick);
          };
          tick();
        });
      await waitFor(() => {
        const p = store.getState().matePreview;
        return !!p?.source && !!p?.target;
      });
      return store.getState().matePreview;
    });

    expect(preview?.source).toBeTruthy();
    expect(preview?.target).toBeTruthy();
    expect(preview?.source?.methodUsed).toBeTruthy();
    expect(preview?.target?.methodUsed).toBeTruthy();
  });
});
