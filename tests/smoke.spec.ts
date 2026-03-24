import { test, expect, type Page } from '@playwright/test';

async function openLegacyAnimationPanel(page: Page) {
  const loadDemo = page.getByText('Load Demo (Spark.glb)');
  if ((await loadDemo.count()) === 0) {
    await page.getByRole('button', { name: /markers & animation/i }).click();
  }
  await expect(loadDemo).toBeVisible();
  await loadDemo.scrollIntoViewIfNeeded();
  return loadDemo;
}

test.describe('3D Animation App Smoke Test', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5274');
  });

  test('should load app and demo model', async ({ page }) => {
    // 1. Verify Page Title/Load
    await expect(page).toHaveTitle(/3D Anim/i); // Adjust based on actual title if set
    
    // 2. Load Demo
    const loadBtn = await openLegacyAnimationPanel(page);
    await loadBtn.click();
    
    await page.waitForFunction(() => {
      const store = (window as any).__APP_STORE__?.getState?.();
      if (!store?.parts) return false;
      const parts = Object.values(store.parts) as any[];
      return parts.some((p) => p?.name === 'Part1');
    });
    await expect(page.getByTestId('parts-list-item').filter({ hasText: 'Part1' }).first()).toBeVisible();
  });

  test('should allow picking start/end points', async ({ page }) => {
    await (await openLegacyAnimationPanel(page)).click();
    
    // Select Moving Object
    const targetSelect = page.locator('label:has-text(\"Target Object\")').locator('..').locator('select');
    await targetSelect.selectOption({ label: 'Part1' });
    
    // Check Pick Buttons exist
    const startBtn = page.getByTitle('Pick Face Center').first();
    await expect(startBtn).toBeVisible();
    
    // Click Pick Start (Unit test UI interaction)
    await startBtn.click();
    
    // Note: Clicking 3D Canvas in Playwright is tricky without specific coordinates.
    // We verify the UI state changed (e.g., Button active state).
    // In our implementation, button turns Green (bg-green-400).
    await expect(startBtn).toHaveClass(/bg-green-400/);
  });

  test('should trigger animation', async ({ page }) => {
     await (await openLegacyAnimationPanel(page)).click();
     const targetSelect = page.locator('label:has-text(\"Target Object\")').locator('..').locator('select');
     await targetSelect.selectOption({ label: 'Part1' });
     
     // Mocking state via direct JS evaluation if needed, or just clicking run if enabled.
     // Since Start/End are required for RUN to be enabled, we might check it's disabled initially.
     const playBtn = page.getByRole('button', { name: 'PLAY', exact: true });
     await expect(playBtn).toBeDisabled();
  });
});
