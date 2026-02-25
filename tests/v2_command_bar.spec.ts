import { test, expect } from '@playwright/test';

test.describe('v2 command bar', () => {
  test('enter submits command', async ({ page }) => {
    await page.goto('http://127.0.0.1:5274/?v=2', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => (window as any).__V2_STORE__?.getState?.().connection.wsConnected === true);

    await page.getByTestId('command-input').fill('grid off');
    await page.keyboard.press('Enter');

    await page.waitForFunction(
      () => (window as any).__V2_STORE__?.getState?.().view.showGrid === false,
      null,
      { timeout: 5000 }
    );
    const gridOff = await page.evaluate(() => (window as any).__V2_STORE__.getState().view.showGrid);
    expect(gridOff).toBe(false);

    await page.getByTestId('command-input').fill('grid on');
    await page.keyboard.press('Enter');

    await page.waitForFunction(
      () => (window as any).__V2_STORE__?.getState?.().view.showGrid === true,
      null,
      { timeout: 5000 }
    );
    const gridOn = await page.evaluate(() => (window as any).__V2_STORE__.getState().view.showGrid);
    expect(gridOn).toBe(true);
  });
});
