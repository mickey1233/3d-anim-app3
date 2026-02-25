import { test, expect } from '@playwright/test';

async function getPartIds(page: any) {
  return await page.evaluate(() => {
    const store = (window as any).__V2_STORE__.getState();
    const part1 = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part1');
    const part2 = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part2');
    return { part1, part2 };
  });
}

test.describe('v2 query.mate_suggestions fixtures', () => {
  test('side fixture prefers right->left', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=side', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.connection.wsConnected === true && state.parts.order.length >= 2;
    });

    const ids = await getPartIds(page);
    expect(ids.part1).toBeTruthy();
    expect(ids.part2).toBeTruthy();

    const result = await page.evaluate(async ({ sourceId, targetId }) => {
      const mod = await import('/src/v2/network/mcpToolsClient.ts');
      return await mod.callMcpTool('query.mate_suggestions', {
        sourcePart: { partId: sourceId },
        targetPart: { partId: targetId },
        maxPairs: 12,
      });
    }, { sourceId: ids.part1, targetId: ids.part2 });

    expect(result.ok).toBe(true);
    expect(result.data.expectedFromCenters.sourceFace).toBe('right');
    expect(result.data.expectedFromCenters.targetFace).toBe('left');
    expect(result.data.ranking.length).toBeGreaterThan(0);
    expect(result.data.ranking[0].sourceFace).toBe('right');
    expect(result.data.ranking[0].targetFace).toBe('left');
  });

  test('lid fixture infers cover intent and suggests both mode', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=lid', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.connection.wsConnected === true && state.parts.order.length >= 2;
    });

    const ids = await getPartIds(page);
    expect(ids.part1).toBeTruthy();
    expect(ids.part2).toBeTruthy();

    const result = await page.evaluate(async ({ sourceId, targetId }) => {
      const mod = await import('/src/v2/network/mcpToolsClient.ts');
      return await mod.callMcpTool('query.mate_suggestions', {
        sourcePart: { partId: sourceId },
        targetPart: { partId: targetId },
        maxPairs: 12,
      });
    }, { sourceId: ids.part1, targetId: ids.part2 });

    expect(result.ok).toBe(true);
    expect(result.data.intent).toBe('cover');
    expect(result.data.suggestedMode).toBe('both');
    expect(result.data.ranking.length).toBeGreaterThan(0);
  });

  test('slot fixture avoids object_aabb-only anchor for insert intent', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=slot', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.connection.wsConnected === true && state.parts.order.length >= 2;
    });

    const ids = await getPartIds(page);
    expect(ids.part1).toBeTruthy();
    expect(ids.part2).toBeTruthy();

    const result = await page.evaluate(async ({ sourceId, targetId }) => {
      const mod = await import('/src/v2/network/mcpToolsClient.ts');
      return await mod.callMcpTool('query.mate_suggestions', {
        sourcePart: { partId: sourceId },
        targetPart: { partId: targetId },
        instruction: 'insert part1 into part2 slot',
        maxPairs: 12,
      });
    }, { sourceId: ids.part1, targetId: ids.part2 });

    expect(result.ok).toBe(true);
    expect(result.data.intent).toBe('insert');
    expect(result.data.ranking.length).toBeGreaterThan(0);
    expect(result.data.ranking[0].targetMethod).not.toBe('object_aabb');

    const anchors = await page.evaluate(async ({ targetId }) => {
      const mod = await import('/src/v2/network/mcpToolsClient.ts');
      const objectTop = await mod.callMcpTool('query.face_info', {
        part: { partId: targetId },
        face: 'top',
        method: 'object_aabb',
      });
      const planarTop = await mod.callMcpTool('query.face_info', {
        part: { partId: targetId },
        face: 'top',
        method: 'planar_cluster',
      });
      return { objectTop, planarTop };
    }, { targetId: ids.part2 });

    expect(anchors.objectTop.ok).toBe(true);
    expect(anchors.planarTop.ok).toBe(true);

    const objectY = anchors.objectTop.data.frameWorld.origin[1];
    const planarY = anchors.planarTop.data.frameWorld.origin[1];
    expect(planarY).toBeLessThan(objectY - 0.08);
  });
});
