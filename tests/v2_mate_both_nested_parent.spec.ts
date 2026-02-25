import { test, expect } from '@playwright/test';

test.describe('v2 mate both: nested parent transform', () => {
  /**
   * Regression: generic "幫我把X和Y組裝起來" must default to mode=translate,
   * NOT mode=both, even when geometry infers 'cover' intent (parts stacked on Y).
   * Bug: defaultModeForIntent('cover')='both' + mockProvider propagating suggestedMode='both'
   * caused unexpected face-alignment rotation instead of a straight translate.
   */
  test('generic assembly command uses translate not both', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=nested', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.connection.wsConnected === true && state.parts.order.length >= 2;
    });

    await page.getByTestId('workspace-tab-chat').click();

    // "幫我把part2和part1組裝起來" — pure generic assembly, no explicit mode keyword
    await page.getByTestId('chat-input').fill('幫我把part2和part1組裝起來');
    await page.keyboard.press('Enter');

    // Must see 'mode=translate' in the parsed reply, NOT mode=both
    await expect(page.getByTestId('chat-messages')).toContainText('mode=translate', { timeout: 12_000 });
    await expect(page.getByTestId('chat-messages')).not.toContainText('mode=both', { timeout: 3_000 });
  });

  test('cover/both moves the source (not rotate-in-place)', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=nested', { waitUntil: 'domcontentloaded' });

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

    await page.getByTestId('workspace-tab-chat').click();

    const before = await page.evaluate((partId) => {
      const store = (window as any).__V2_STORE__.getState();
      return store.getPartTransform(partId);
    }, ids.part2);

    await page.getByTestId('chat-input').fill('mate part2 bottom to part1 top cover');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('chat-messages')).toContainText('mode=both', { timeout: 12_000 });

    await page.waitForFunction(
      (payload) => {
        const store = (window as any).__V2_STORE__.getState();
        const current = store.getPartTransform(payload.partId);
        const before = payload.before;
        if (!current || !before) return false;
        const dy = current.position[1] - before.position[1];
        return dy < -2e-3;
      },
      { partId: ids.part2, before },
      { timeout: 12_000 }
    );

    const after = await page.evaluate((partId) => {
      const store = (window as any).__V2_STORE__.getState();
      return store.getPartTransform(partId);
    }, ids.part2);

    expect(after).toBeTruthy();
    expect(before).toBeTruthy();
    expect(after.position[1]).toBeLessThan(before.position[1] - 2e-3);
  });
});

