import { test, expect } from '@playwright/test';

async function getLidIds(page: any) {
  return await page.evaluate(() => {
    const store = (window as any).__V2_STORE__.getState();
    const lidId = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part1');
    const baseId = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part2');
    return { lidId, baseId };
  });
}

test.describe('v2 mate VLM cover drift arbitration', () => {
  test('keeps lid-style bottom->top inference after lateral offset drift', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('http://127.0.0.1:5173/?v=2&fixture=lid', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.connection.wsConnected === true && state.parts.order.length >= 2;
    });

    const ids = await getLidIds(page);
    expect(ids.lidId).toBeTruthy();
    expect(ids.baseId).toBeTruthy();

    const data = await page.evaluate(async ({ lidId, baseId }) => {
      const mod = await import('/src/v2/network/mcpToolsClient.ts');
      await mod.callMcpTool('action.translate', {
        part: { partId: lidId },
        delta: [1.2, 0, 0],
        space: 'world',
      });

      const suggestions = await mod.callMcpTool('query.mate_suggestions', {
        sourcePart: { partId: lidId },
        targetPart: { partId: baseId },
        instruction: 'mate part1 to part2 cover',
        maxPairs: 12,
      });

      const inferred = await mod.callMcpTool('query.mate_vlm_infer', {
        sourcePart: { partId: lidId },
        targetPart: { partId: baseId },
        instruction: 'mate part1 to part2 cover',
        maxViews: 6,
        maxWidthPx: 480,
        maxHeightPx: 320,
        format: 'jpeg',
      });

      return { suggestions, inferred };
    }, ids);

    expect(data.suggestions.ok).toBe(true);
    expect(['left', 'right']).toContain(data.suggestions.data.expectedFromCenters.sourceFace);
    expect(['left', 'right']).toContain(data.suggestions.data.expectedFromCenters.targetFace);

    expect(data.inferred.ok).toBe(true);
    expect(data.inferred.data.inferred.intent).toBe('cover');
    expect(data.inferred.data.inferred.mode).toBe('both');
    expect(data.inferred.data.inferred.sourceFace).toBe('bottom');
    expect(data.inferred.data.inferred.targetFace).toBe('top');
    expect(data.inferred.data.vlm.voteCount).toBeGreaterThan(0);
    expect(data.inferred.data.vlm.viewConsensus).toBeGreaterThan(0.5);
    expect(
      (data.inferred.data.inferred.arbitration as string[]).some((tag) =>
        ['cover_vertical_face_override', 'cover_center_drift_guard', 'vlm_view_consensus_applied'].includes(tag)
      )
    ).toBe(true);
  });

  test('chat reply surfaces arbitration diagnostics for cover drift case', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('http://127.0.0.1:5173/?v=2&fixture=lid', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.connection.wsConnected === true && state.parts.order.length >= 2;
    });

    const ids = await getLidIds(page);
    expect(ids.lidId).toBeTruthy();

    await page.evaluate(async ({ lidId }) => {
      const mod = await import('/src/v2/network/mcpToolsClient.ts');
      await mod.callMcpTool('action.translate', {
        part: { partId: lidId },
        delta: [1.2, 0, 0],
        space: 'world',
      });
    }, ids);

    await page.getByTestId('workspace-tab-chat').click();
    await page.getByTestId('chat-input').fill('mate part1 to part2 cover');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('chat-messages')).toContainText('part1(bottom) -> part2(top)', { timeout: 12_000 });
    await expect(page.getByTestId('chat-messages')).toContainText('mode=both', { timeout: 12_000 });
    await expect(page.getByTestId('chat-messages')).toContainText('intent=cover', { timeout: 12_000 });
    await expect(page.getByTestId('chat-messages')).toContainText('cons=', { timeout: 12_000 });
    await expect(page.getByTestId('chat-messages')).toContainText('診斷=', { timeout: 12_000 });
    await expect(page.getByTestId('chat-messages')).toContainText('arb=', { timeout: 12_000 });
  });
});
