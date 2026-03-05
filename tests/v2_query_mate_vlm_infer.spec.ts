import { test, expect } from '@playwright/test';

test.describe('v2 query.mate_vlm_infer', () => {
  test('captures multi-view images and returns structured mate inference with VLM fallback-safe result', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('http://127.0.0.1:5173/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.connection.wsConnected === true && state.parts.order.length >= 2;
    });

    const ids = await page.evaluate(() => {
      const store = (window as any).__V2_STORE__.getState();
      const sourceId = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part2');
      const targetId = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part1');
      return { sourceId, targetId };
    });
    expect(ids.sourceId).toBeTruthy();
    expect(ids.targetId).toBeTruthy();

    const result = await page.evaluate(async ({ sourceId, targetId }) => {
      const mod = await import('/src/v2/network/mcpToolsClient.ts');
      return await mod.callMcpTool('query.mate_vlm_infer', {
        sourcePart: { partId: sourceId },
        targetPart: { partId: targetId },
        instruction: 'mate part2 to part1',
        maxViews: 6,
        maxWidthPx: 480,
        maxHeightPx: 320,
        format: 'jpeg',
      });
    }, ids);

    expect(result?.ok).toBe(true);
    expect(result?.data?.capture?.imageCount).toBeGreaterThanOrEqual(4);
    expect(result?.data?.capture?.views?.length).toBe(result?.data?.capture?.imageCount);
    expect(result?.data?.geometry?.expectedFromCenters?.sourceFace).toBeTruthy();
    expect(result?.data?.inferred?.sourcePartId).toBe(ids.sourceId);
    expect(result?.data?.inferred?.targetPartId).toBe(ids.targetId);
    expect(result?.data?.inferred?.sourceFace).toBeTruthy();
    expect(result?.data?.inferred?.targetFace).toBeTruthy();
    expect(result?.data?.inferred?.mode).toBeTruthy();
    expect(result?.data?.inferred?.intent).toBeTruthy();
    expect(['geometry', 'vlm', 'hybrid']).toContain(result?.data?.inferred?.origin);
    expect(typeof result?.data?.inferred?.confidence).toBe('number');
    expect(result?.data?.vlm?.used).toBe(true);
    expect(result?.data?.vlm?.mateInference).toBeTruthy();
    expect(result?.data?.vlm?.voteCount).toBeGreaterThan(0);
    expect(typeof result?.data?.vlm?.viewConsensus).toBe('number');
    expect(result?.data?.vlm?.viewConsensus).toBeGreaterThan(0);
  });
});
