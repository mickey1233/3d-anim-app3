import { test, expect } from '@playwright/test';

test.describe('v2 chat router', () => {
  test('supports conversational reply and natural language tool control', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.connection.wsConnected === true;
    });

    await page.getByTestId('workspace-tab-chat').click();

    await page.getByTestId('chat-input').fill('你好');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('chat-messages')).toContainText('你好', { timeout: 5000 });
    await expect(page.getByTestId('chat-messages')).not.toContainText('已執行 0 個工具', { timeout: 5000 });

    await page.getByTestId('chat-input').fill('把格線關掉');
    await page.keyboard.press('Enter');

    await page.waitForFunction(() => (window as any).__V2_STORE__?.getState?.().view.showGrid === false, null, {
      timeout: 7000,
    });

    const gridVisible = await page.evaluate(() => (window as any).__V2_STORE__.getState().view.showGrid);
    expect(gridVisible).toBe(false);

    await page.getByTestId('chat-input').fill('你是使用mock還是什麼');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('chat-messages')).toContainText('router=', { timeout: 5000 });

    await page.getByTestId('chat-input').fill('今天天氣好嗎');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('chat-messages')).toContainText('我需要地點', { timeout: 5000 });
  });

  test('supports step Q&A, model Q&A, and natural mate parsing', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.connection.wsConnected === true && state.parts.order.length >= 2;
    });

    await page.getByTestId('workspace-tab-chat').click();

    await page.getByTestId('chat-input').fill('我要如何新增step');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('chat-messages')).toContainText('新增 step', { timeout: 5000 });

    await page.getByTestId('chat-input').fill('這個 usd 的 3d model');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('chat-messages')).toContainText('模型資訊', { timeout: 5000 });

    const before = await page.evaluate(() => {
      const state = (window as any).__V2_STORE__.getState();
      const sourceId = state.parts.order.find((id: string) => state.parts.byId[id]?.name === 'part1');
      return sourceId ? state.getPartTransform(sourceId).position : null;
    });
    expect(before).not.toBeNull();

    await page.getByTestId('chat-input').fill('mate part1 and part2');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('mate-capture-overlay')).toBeVisible({ timeout: 7000 });
    await expect(page.getByTestId('mate-capture-overlay')).toBeHidden({ timeout: 12000 });
    await expect(page.getByTestId('chat-messages')).toContainText('已解析：part1(', { timeout: 7000 });
    await expect(page.getByTestId('chat-messages')).toContainText('-> part2(', { timeout: 7000 });
    await expect(page.getByTestId('chat-messages')).toContainText('via=', { timeout: 7000 });
    await expect(page.getByTestId('chat-messages')).not.toContainText('method=auto', { timeout: 7000 });

    await page.waitForFunction(
      (beforePos) => {
        const state = (window as any).__V2_STORE__.getState();
        const sourceId = state.parts.order.find((id: string) => state.parts.byId[id]?.name === 'part1');
        if (!sourceId) return false;
        const current = state.getPartTransform(sourceId).position;
        return (
          Math.abs(current[0] - beforePos[0]) > 1e-4 ||
          Math.abs(current[1] - beforePos[1]) > 1e-4 ||
          Math.abs(current[2] - beforePos[2]) > 1e-4
        );
      },
      before,
      { timeout: 10000 }
    );

    await page.getByTestId('chat-input').fill('mate part1 bottom and part2 top use object aabb method');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('chat-messages')).toContainText('method=object_aabb', { timeout: 5000 });
    await expect(page.getByTestId('chat-messages')).toContainText('part1(bottom) -> part2(top)', { timeout: 5000 });

    await page.getByTestId('chat-input').fill('mate part1 and part2 like cover a lid');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('chat-messages')).toContainText('mode=both', { timeout: 7000 });

    await page.getByTestId('chat-input').fill('請幫我把 part1 跟 part2 對齊');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('chat-messages')).toContainText('已解析', { timeout: 5000 });
  });
});
