import { test, expect } from '@playwright/test';

test.describe('v2 chat', () => {
  test('chat responds to help', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('http://127.0.0.1:5173/?v=2', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('workspace-tab-chat').click();
    await page.waitForSelector('[data-testid="chat-input"]');

    await page.getByTestId('chat-input').fill('/help');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('chat-messages')).toContainText('Examples:');
  });
});
