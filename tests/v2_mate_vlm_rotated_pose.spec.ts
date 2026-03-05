import { test, expect } from '@playwright/test';

async function getSlotIds(page: any) {
  return await page.evaluate(() => {
    const store = (window as any).__V2_STORE__.getState();
    const sourceId = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part1');
    const targetId = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part2');
    return { sourceId, targetId };
  });
}

test.describe('v2 mate VLM rotated-pose invariance', () => {
  test('keeps insert intent under rotated and translated initial poses', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('http://127.0.0.1:5173/?v=2&fixture=slot', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.connection.wsConnected === true && state.parts.order.length >= 2;
    });

    const ids = await getSlotIds(page);
    expect(ids.sourceId).toBeTruthy();
    expect(ids.targetId).toBeTruthy();

    const data = await page.evaluate(async ({ sourceId, targetId }) => {
      const mod = await import('/src/v2/network/mcpToolsClient.ts');
      await mod.callMcpTool('action.rotate', {
        part: { partId: targetId },
        axis: { axisSpace: 'world', axis: 'x' },
        angleDeg: 32,
      });
      await mod.callMcpTool('action.rotate', {
        part: { partId: targetId },
        axis: { axisSpace: 'world', axis: 'z' },
        angleDeg: -26,
      });
      await mod.callMcpTool('action.translate', {
        part: { partId: targetId },
        delta: [1.2, 0.35, -0.65],
        space: 'world',
      });
      await mod.callMcpTool('action.rotate', {
        part: { partId: sourceId },
        axis: { axisSpace: 'world', axis: 'y' },
        angleDeg: 118,
      });
      await mod.callMcpTool('action.rotate', {
        part: { partId: sourceId },
        axis: { axisSpace: 'world', axis: 'x' },
        angleDeg: -22,
      });
      await mod.callMcpTool('action.translate', {
        part: { partId: sourceId },
        delta: [0.25, 1.05, -1.1],
        space: 'world',
      });

      const inferred = await mod.callMcpTool('query.mate_vlm_infer', {
        sourcePart: { partId: sourceId },
        targetPart: { partId: targetId },
        instruction: 'insert part1 into part2 slot',
        maxViews: 6,
        maxWidthPx: 480,
        maxHeightPx: 320,
        format: 'jpeg',
      });
      return { inferred };
    }, ids);

    expect(data.inferred.ok).toBe(true);
    expect(data.inferred.data.inferred.intent).toBe('insert');
    expect(['translate', 'both']).toContain(data.inferred.data.inferred.mode);
    expect(data.inferred.data.inferred.targetMethod).not.toBe('object_aabb');
    expect(data.inferred.data.vlm.voteCount).toBeGreaterThan(0);
    expect(data.inferred.data.capture.imageCount).toBeGreaterThanOrEqual(4);
  });

  test('chat still reports insert semantics after rotated initial poses', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('http://127.0.0.1:5173/?v=2&fixture=slot', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.connection.wsConnected === true && state.parts.order.length >= 2;
    });

    const ids = await getSlotIds(page);
    expect(ids.sourceId).toBeTruthy();
    expect(ids.targetId).toBeTruthy();

    await page.evaluate(async ({ sourceId, targetId }) => {
      const mod = await import('/src/v2/network/mcpToolsClient.ts');
      await mod.callMcpTool('action.rotate', {
        part: { partId: targetId },
        axis: { axisSpace: 'world', axis: 'y' },
        angleDeg: 90,
      });
      await mod.callMcpTool('action.translate', {
        part: { partId: targetId },
        delta: [-0.85, 0.28, 0.92],
        space: 'world',
      });
      await mod.callMcpTool('action.rotate', {
        part: { partId: sourceId },
        axis: { axisSpace: 'world', axis: 'z' },
        angleDeg: 41,
      });
      await mod.callMcpTool('action.translate', {
        part: { partId: sourceId },
        delta: [0.7, 0.66, 0.44],
        space: 'world',
      });
    }, ids);

    await page.getByTestId('workspace-tab-chat').click();
    await page.getByTestId('chat-input').fill('mate part1 and part2, part1 should insert into part2 slot');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('chat-messages')).toContainText('intent=insert', { timeout: 12_000 });
    await expect(page.getByTestId('chat-messages')).toContainText('via=', { timeout: 12_000 });
    await expect(page.getByTestId('chat-messages')).toContainText('診斷=', { timeout: 12_000 });
    await expect(page.getByTestId('chat-messages')).toContainText('arb=', { timeout: 12_000 });
    await expect(page.getByTestId('chat-messages')).not.toContainText('method=object_aabb/object_aabb', { timeout: 12_000 });
  });
});
