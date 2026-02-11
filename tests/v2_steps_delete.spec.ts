import { test, expect } from '@playwright/test';

test.describe('v2 steps delete', () => {
  test('deletes steps and updates list', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('http://127.0.0.1:5173/?v=2', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('workspace-tab-steps').click();
    await page.waitForSelector('[data-testid="step-add"]');

    await page.getByTestId('step-input').fill('Step A');
    await page.getByTestId('step-add').click();
    await page.getByTestId('step-input').fill('Step B');
    await page.getByTestId('step-add').click();

    await expect(page.getByTestId('step-delete')).toHaveCount(2);
    await page.getByTestId('step-delete').first().click();
    await expect(page.getByTestId('step-delete')).toHaveCount(1);
  });
});
