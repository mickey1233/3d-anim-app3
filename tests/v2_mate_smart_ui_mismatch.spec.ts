import { test, expect } from '@playwright/test';

test.describe('v2 mate smart vs UI parity (shelf fixture)', () => {
  test('smart mate matches UI auto/auto', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=shelf', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.connection.wsConnected === true && state.parts.order.length >= 2;
    });

    const ids = await page.evaluate(() => {
      const store = (window as any).__V2_STORE__.getState();
      const sourceId = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part1');
      const targetId = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part2');
      return { sourceId, targetId };
    });
    expect(ids.sourceId).toBeTruthy();
    expect(ids.targetId).toBeTruthy();

    await page.getByTestId('workspace-tab-chat').click();
    const beforeChat = await page.evaluate((sourceId) => {
      const store = (window as any).__V2_STORE__.getState();
      return store.getPartTransform(sourceId);
    }, ids.sourceId);

    // This sentence is intentionally crafted to reproduce the issue:
    // - It explicitly sets faces/mode, but not methods (router prints auto/auto).
    // - Smart mate currently may infer planar_cluster, which can pick an interior shelf face.
    await page.getByTestId('chat-input').fill('mate part1 bottom to part2 top translate');
    await page.keyboard.press('Enter');

    await page.waitForFunction(
      (payload) => {
        const store = (window as any).__V2_STORE__?.getState?.();
        const current = store?.getPartTransform?.(payload.sourceId);
        const before = payload.before;
        if (!current || !before) return false;
        return (
          Math.abs(current.position[0] - before.position[0]) > 1e-4 ||
          Math.abs(current.position[1] - before.position[1]) > 1e-4 ||
          Math.abs(current.position[2] - before.position[2]) > 1e-4
        );
      },
      { sourceId: ids.sourceId, before: beforeChat },
      { timeout: 12_000 }
    );

    const chatTransform = await page.evaluate((sourceId) => {
      const store = (window as any).__V2_STORE__.getState();
      return store.getPartTransform(sourceId);
    }, ids.sourceId);

    await page.evaluate((sourceId) => {
      const store = (window as any).__V2_STORE__.getState();
      store.clearPartOverride(sourceId);
    }, ids.sourceId);

    await page.waitForFunction(
      (sourceId) => {
        const store = (window as any).__V2_STORE__.getState();
        return !store.parts.overridesById[sourceId];
      },
      ids.sourceId,
      { timeout: 5000 }
    );

    const beforeManual = await page.evaluate((sourceId) => {
      const store = (window as any).__V2_STORE__.getState();
      return store.getPartTransform(sourceId);
    }, ids.sourceId);

    // Manual mate uses UI's default auto/auto implementation (geometry AABB first).
    await page.evaluate(
      ({ sourceId, targetId }) => {
        const store = (window as any).__V2_STORE__.getState();
        store.requestMate({
          sourceId,
          targetId,
          sourceFace: 'bottom',
          targetFace: 'top',
          mode: 'translate',
          sourceMethod: 'auto',
          targetMethod: 'auto',
          sourceOffset: [0, 0, 0],
          targetOffset: [0, 0, 0],
        });
      },
      { sourceId: ids.sourceId, targetId: ids.targetId }
    );

    await page.waitForFunction(
      (payload) => {
        const store = (window as any).__V2_STORE__?.getState?.();
        const current = store?.getPartTransform?.(payload.sourceId);
        const before = payload.before;
        if (!current || !before) return false;
        return (
          Math.abs(current.position[0] - before.position[0]) > 1e-4 ||
          Math.abs(current.position[1] - before.position[1]) > 1e-4 ||
          Math.abs(current.position[2] - before.position[2]) > 1e-4
        );
      },
      { sourceId: ids.sourceId, before: beforeManual },
      { timeout: 12_000 }
    );

    const manualTransform = await page.evaluate((sourceId) => {
      const store = (window as any).__V2_STORE__.getState();
      return store.getPartTransform(sourceId);
    }, ids.sourceId);

    expect(chatTransform).toBeTruthy();
    expect(manualTransform).toBeTruthy();

    const posDiff =
      Math.abs(chatTransform.position[0] - manualTransform.position[0]) +
      Math.abs(chatTransform.position[1] - manualTransform.position[1]) +
      Math.abs(chatTransform.position[2] - manualTransform.position[2]);

    expect(posDiff).toBeLessThan(1e-3);
  });
});
