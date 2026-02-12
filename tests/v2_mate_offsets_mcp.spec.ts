import { test, expect } from '@playwright/test';

test.describe('v2 mate offsets (MCP schema + executor)', () => {
  test('action.mate_execute respects sourceOffset/targetOffset', async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto('http://127.0.0.1:5173/?v=2&fixture=lid', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.connection.wsConnected === true && state.parts.order.length >= 2;
    });

    const ids = await page.evaluate(() => {
      const store = (window as any).__V2_STORE__.getState();
      const part1 = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part1');
      const part2 = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part2');
      return { part1, part2 };
    });
    expect(ids.part1).toBeTruthy();
    expect(ids.part2).toBeTruthy();

    const yNoOffset = await page.evaluate(async ({ sourceId, targetId }) => {
      const store = (window as any).__V2_STORE__.getState();
      const { callMcpTool } = await import('/src/v2/network/mcpToolsClient.ts');
      await callMcpTool('action.mate_execute', {
        sourcePart: { partId: sourceId },
        targetPart: { partId: targetId },
        sourceFace: 'bottom',
        targetFace: 'top',
        sourceMethod: 'auto',
        targetMethod: 'auto',
        mode: 'translate',
        commit: true,
        pushHistory: false,
      });
      const next = store.getPartTransform(sourceId);
      return next?.position?.[1] ?? null;
    }, { sourceId: ids.part1, targetId: ids.part2 });
    expect(yNoOffset).not.toBeNull();

    await page.evaluate((sourceId) => {
      const store = (window as any).__V2_STORE__.getState();
      store.clearPartOverride(sourceId);
    }, ids.part1);

    await page.waitForFunction(
      (sourceId) => {
        const store = (window as any).__V2_STORE__.getState();
        return !store.parts.overridesById[sourceId];
      },
      ids.part1,
      { timeout: 8000 }
    );

    const yWithOffset = await page.evaluate(async ({ sourceId, targetId }) => {
      const store = (window as any).__V2_STORE__.getState();
      const { callMcpTool } = await import('/src/v2/network/mcpToolsClient.ts');
      await callMcpTool('action.mate_execute', {
        sourcePart: { partId: sourceId },
        targetPart: { partId: targetId },
        sourceFace: 'bottom',
        targetFace: 'top',
        sourceMethod: 'auto',
        targetMethod: 'auto',
        sourceOffset: [0, 0.05, 0],
        targetOffset: [0, 0, 0],
        mode: 'translate',
        commit: true,
        pushHistory: false,
      });
      const next = store.getPartTransform(sourceId);
      return next?.position?.[1] ?? null;
    }, { sourceId: ids.part1, targetId: ids.part2 });
    expect(yWithOffset).not.toBeNull();

    const delta = Number(yWithOffset) - Number(yNoOffset);
    // A positive sourceOffset in local Y moves the anchor upward,
    // so the final part position should be lower by about the same amount.
    expect(delta).toBeLessThan(-0.03);
  });
});

