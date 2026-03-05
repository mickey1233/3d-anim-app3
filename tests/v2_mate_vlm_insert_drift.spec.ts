import { test, expect } from '@playwright/test';

async function getSlotIds(page: any) {
  return await page.evaluate(() => {
    const store = (window as any).__V2_STORE__.getState();
    const sourceId = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part1');
    const targetId = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part2');
    return { sourceId, targetId };
  });
}

test.describe('v2 mate VLM insert drift arbitration', () => {
  test('keeps slot insertion as bottom->top with non-object_aabb target method after lateral offset', async ({ page }) => {
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
      await mod.callMcpTool('action.translate', {
        part: { partId: sourceId },
        delta: [0.9, 0, 0],
        space: 'world',
      });

      const suggestions = await mod.callMcpTool('query.mate_suggestions', {
        sourcePart: { partId: sourceId },
        targetPart: { partId: targetId },
        instruction: 'insert part1 into part2 slot',
        maxPairs: 12,
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

      return { suggestions, inferred };
    }, ids);

    expect(data.suggestions.ok).toBe(true);
    expect(data.suggestions.data.intent).toBe('insert');
    expect(['left', 'right']).toContain(data.suggestions.data.expectedFromCenters.sourceFace);
    expect(['left', 'right']).toContain(data.suggestions.data.expectedFromCenters.targetFace);

    expect(data.inferred.ok).toBe(true);
    expect(data.inferred.data.inferred.intent).toBe('insert');
    expect(data.inferred.data.inferred.mode).toBe('both');
    expect(data.inferred.data.inferred.sourceFace).toBe('bottom');
    expect(data.inferred.data.inferred.targetFace).toBe('top');
    expect(data.inferred.data.inferred.targetMethod).not.toBe('object_aabb');
    expect(data.inferred.data.vlm.voteCount).toBeGreaterThan(0);
    expect(data.inferred.data.vlm.viewConsensus).toBeGreaterThan(0.35);
    expect(
      (data.inferred.data.inferred.arbitration as string[]).some((tag) =>
        [
          'insert_vertical_face_override',
          'insert_center_drift_guard',
          'vlm_view_consensus_applied',
          'vlm_view_consensus_low',
        ].includes(tag)
      )
    ).toBe(true);
  });

  test('chat reply surfaces insert drift arbitration diagnostics', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('http://127.0.0.1:5173/?v=2&fixture=slot', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.connection.wsConnected === true && state.parts.order.length >= 2;
    });

    const ids = await getSlotIds(page);
    expect(ids.sourceId).toBeTruthy();

    await page.evaluate(async ({ sourceId }) => {
      const mod = await import('/src/v2/network/mcpToolsClient.ts');
      await mod.callMcpTool('action.translate', {
        part: { partId: sourceId },
        delta: [0.9, 0, 0],
        space: 'world',
      });
    }, ids);

    await page.getByTestId('workspace-tab-chat').click();
    await page.getByTestId('chat-input').fill('mate part1 to part2 insert into slot');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('chat-messages')).toContainText('part1(bottom) -> part2(top)', { timeout: 12_000 });
    await expect(page.getByTestId('chat-messages')).toContainText('mode=both', { timeout: 12_000 });
    await expect(page.getByTestId('chat-messages')).toContainText('intent=insert', { timeout: 12_000 });
    await expect(page.getByTestId('chat-messages')).toContainText('cons=', { timeout: 12_000 });
    await expect(page.getByTestId('chat-messages')).toContainText('診斷=', { timeout: 12_000 });
    await expect(page.getByTestId('chat-messages')).toContainText('arb=', { timeout: 12_000 });
  });
});
