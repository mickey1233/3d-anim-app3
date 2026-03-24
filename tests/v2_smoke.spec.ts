import { test, expect } from '@playwright/test';

test.describe('v2 smoke', () => {
  test('load v2, select part, mate, add step, vlm analyze (mock)', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5274/?v=2', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && Object.keys(state.parts.byId || {}).length > 0;
    });
    await page.waitForSelector('[data-testid="command-input"]');

    const firstPartId = await page.evaluate(() => {
      const state = (window as any).__V2_STORE__.getState();
      return state.parts.order[0];
    });

    const viewAfter = await page.evaluate(() => {
      const store = (window as any).__V2_STORE__;
      store.getState().setGridVisible(false);
      store.getState().setEnvironment('studio');
      return store.getState().view;
    });
    expect(viewAfter.showGrid).toBe(false);
    expect(viewAfter.environment).toBe('studio');

    // Configure mate using first two parts from store
    const partIds = await page.evaluate(() => {
      const state = (window as any).__V2_STORE__.getState();
      return state.parts.order.slice(0, 2);
    });
    if (partIds.length >= 2) {
      await page.evaluate(([sourceId, targetId]) => {
        const store = (window as any).__V2_STORE__;
        store.getState().setMarker('start', {
          type: 'face',
          partId: sourceId,
          faceId: 'bottom',
          position: [0, 0, 0],
          normal: [0, 1, 0],
        });
        store.getState().setMarker('end', {
          type: 'face',
          partId: targetId,
          faceId: 'top',
          position: [0, 0, 0],
          normal: [0, 1, 0],
        });
      }, partIds);
    }

    const overridesCount = await page.evaluate((partId) => {
      const store = (window as any).__V2_STORE__;
      const state = store.getState();
      const transform = state.getPartTransform(partId);
      if (transform) {
        const next = {
          ...transform,
          position: [transform.position[0] + 0.01, transform.position[1], transform.position[2]],
        };
        state.setPartOverride(partId, next);
      }
      return Object.keys(store.getState().parts.overridesById || {}).length;
    }, firstPartId);
    expect(overridesCount).toBeGreaterThan(0);

    // Add SOP step (store-driven to avoid DOM stalls)
    const stepCount = await page.evaluate(() => {
      const store = (window as any).__V2_STORE__;
      store.getState().addStep('Step 1');
      return store.getState().steps.list.length;
    });
    expect(stepCount).toBeGreaterThan(0);

    // VLM mock analyze (inject images + result)
    const vlmCount = await page.evaluate(() => {
      const store = (window as any).__V2_STORE__;
      const file1 = new File([new Uint8Array([137, 80, 78, 71])], 'Spark1.png', { type: 'image/png' });
      const file2 = new File([new Uint8Array([137, 80, 78, 71])], 'Spark2.png', { type: 'image/png' });
      store.getState().addVlmImages([file1, file2]);
      store.getState().setVlmResult({
        steps: [{ from_image: 'Spark1.png', to_image: 'Spark2.png', inferred_action: 'move', changes: ['cap->bottle'] }],
        objects: [{ label: 'cap', confidence: 0.9 }, { label: 'bottle', confidence: 0.9 }],
        mapping_candidates: [{ label: 'cap', scene_part_names: ['OutterBase_01'], chosen: 'OutterBase_01', confidence: 0.7 }],
      });
      return store.getState().vlm.result?.steps?.length || 0;
    });
    expect(vlmCount).toBeGreaterThan(0);
  });
});
