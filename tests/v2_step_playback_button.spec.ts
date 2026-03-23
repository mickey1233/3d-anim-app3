import { test, expect } from '@playwright/test';

test.describe('v2 per-step playback button', () => {
  test('startPlaybackAt animates only the target step from initial position', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5173/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.parts.order.length >= 1;
    });

    // 1. Move part, capture step snapshot, then reset to initial
    const { partId, stepId, expectedY } = await page.evaluate(() => {
      const store = (window as any).__V2_STORE__;
      const state = store.getState();
      const pid = state.parts.order[0];
      const base = state.getPartTransform(pid);
      if (!base) throw new Error('No part transform');

      const movedY = base.position[1] + 0.5;
      state.setPartOverride(pid, {
        ...base,
        position: [base.position[0], movedY, base.position[2]],
      });
      state.addStep('Test Step A');
      // Re-read fresh state after addStep (Zustand set() returns new reference)
      const fresh = store.getState();
      const sid = fresh.steps.list[fresh.steps.list.length - 1]?.id;
      if (!sid) throw new Error('Step not created');

      // Reset part to initial so there is something to animate
      store.getState().clearAllPartOverrides();

      return { partId: pid, stepId: sid, expectedY: movedY };
    });

    // 2. Trigger per-step playback (equivalent to clicking the ▶ button)
    await page.evaluate((payload) => {
      const store = (window as any).__V2_STORE__;
      store.getState().startPlaybackAt(payload.stepId, 300);
    }, { stepId });

    // 3. Wait for playback to finish
    await page.waitForFunction(
      () => !(window as any).__V2_STORE__?.getState?.().playback.running,
      null,
      { timeout: 8000 }
    );

    // 4. The part should now be at the stepped-to position
    const finalPos = await page.evaluate((pid) => {
      const state = (window as any).__V2_STORE__.getState();
      return state.getPartTransform(pid)?.position ?? null;
    }, partId);

    expect(finalPos).not.toBeNull();
    if (finalPos) {
      expect(Math.abs(finalPos[1] - expectedY)).toBeLessThan(0.02);
    }
  });

  test('startPlaybackAt with fromStepId plays intermediate steps instantly then animates target', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5173/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.parts.order.length >= 1;
    });

    const { partId, stepAId, stepBId, stepCId } = await page.evaluate(() => {
      const store = (window as any).__V2_STORE__;
      const state = store.getState();
      const pid = state.parts.order[0];
      const base = state.getPartTransform(pid);
      if (!base) throw new Error('No part transform');

      state.setPartOverride(pid, { ...base, position: [base.position[0], base.position[1] + 0.2, base.position[2]] });
      state.addStep('Step A');
      const sidA = store.getState().steps.list[store.getState().steps.list.length - 1]?.id;

      store.getState().setPartOverride(pid, { ...base, position: [base.position[0], base.position[1] + 0.4, base.position[2]] });
      store.getState().addStep('Step B');
      const sidB = store.getState().steps.list[store.getState().steps.list.length - 1]?.id;

      store.getState().setPartOverride(pid, { ...base, position: [base.position[0], base.position[1] + 0.6, base.position[2]] });
      store.getState().addStep('Step C');
      const sidC = store.getState().steps.list[store.getState().steps.list.length - 1]?.id;

      if (!sidA || !sidB || !sidC) throw new Error('Steps not created');

      // Select step A as current
      store.getState().selectStep(sidA);

      return { partId: pid, stepAId: sidA, stepBId: sidB, stepCId: sidC };
    });

    // Play from step A to step C — should animate step C (target), B is instant
    await page.evaluate((payload) => {
      const store = (window as any).__V2_STORE__;
      store.getState().startPlaybackAt(payload.stepCId, 400, payload.stepAId);
    }, { stepCId, stepAId });

    await page.waitForFunction(
      () => !(window as any).__V2_STORE__?.getState?.().playback.running,
      null,
      { timeout: 10000 }
    );

    const finalPos = await page.evaluate((pid) => {
      const state = (window as any).__V2_STORE__.getState();
      return state.getPartTransform(pid)?.position ?? null;
    }, partId);

    expect(finalPos).not.toBeNull();
    if (finalPos) {
      // Part should be at +0.6 (step C's position)
      expect(finalPos[1]).toBeGreaterThan(0.5);
    }
  });
});
