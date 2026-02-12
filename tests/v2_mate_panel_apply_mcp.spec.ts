import { test, expect } from '@playwright/test';

test.describe('v2 Mate panel apply uses MCP', () => {
  test('Apply Mate triggers MCP tool path', async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto('http://127.0.0.1:5173/?v=2&fixture=lid', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.connection.wsConnected === true && state.parts.order.length >= 2;
    });

    await page.getByTestId('workspace-tab-mate').click();

    const ids = await page.evaluate(() => {
      const store = (window as any).__V2_STORE__.getState();
      const part1 = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part1');
      const part2 = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part2');
      return { part1, part2 };
    });
    expect(ids.part1).toBeTruthy();
    expect(ids.part2).toBeTruthy();

    const traceBefore = await page.evaluate(() => (window as any).__V2_STORE__.getState().mateTrace ?? null);
    expect(traceBefore).toBeNull();

    await page.getByTestId('mate-source').selectOption({ value: ids.part1 });
    await page.getByTestId('mate-target').selectOption({ value: ids.part2 });

    const before = await page.evaluate((sourceId) => {
      const store = (window as any).__V2_STORE__.getState();
      return store.getPartTransform(sourceId);
    }, ids.part1);

    await page.getByTestId('mate-apply').click();

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
      { sourceId: ids.part1, before },
      { timeout: 12_000 }
    );

    const traceAfter = await page.evaluate(() => (window as any).__V2_STORE__.getState().mateTrace ?? null);
    // MateExecutor is the only writer of mateTrace; MCP apply should not go through it.
    expect(traceAfter).toBeNull();
  });
});

