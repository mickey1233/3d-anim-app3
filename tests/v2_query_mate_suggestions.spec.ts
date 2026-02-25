import { test, expect } from '@playwright/test';

test.describe('v2 query.mate_suggestions', () => {
  test('returns ranked face pairs from live scene geometry', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });

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

    const result = await page.evaluate(async ({ sourceId, targetId }) => {
      const mod = await import('/src/v2/network/mcpToolsClient.ts');
      return await mod.callMcpTool('query.mate_suggestions', {
        sourcePart: { partId: sourceId },
        targetPart: { partId: targetId },
        instruction: 'mate part1 and part2',
        maxPairs: 12,
      });
    }, ids);

    expect(result?.ok).toBe(true);
    expect(result?.data?.ranking?.length).toBeGreaterThan(0);
    expect(result?.data?.expectedFromCenters?.sourceFace).toBeTruthy();
    expect(result?.data?.expectedFromCenters?.targetFace).toBeTruthy();
    expect(result?.data?.sourceBoxWorld?.size).toBeTruthy();
    expect(result?.data?.targetBoxWorld?.size).toBeTruthy();

    const first = result.data.ranking[0];
    expect(typeof first.score).toBe('number');
    expect(Number.isFinite(first.score)).toBe(true);
    expect(first.sourceFace).toBeTruthy();
    expect(first.targetFace).toBeTruthy();
    expect(first.sourceMethod).toBeTruthy();
    expect(first.targetMethod).toBeTruthy();
  });
});

