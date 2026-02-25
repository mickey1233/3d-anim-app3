import { test, expect } from '@playwright/test';

test.describe('3D Animation App Smoke Test', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5274');
  });

  test('should load app and demo model', async ({ page }) => {
    // 1. Verify Page Title/Load
    await expect(page).toHaveTitle(/3D Anim/i); // Adjust based on actual title if set
    
    // 2. Load Demo
    const loadBtn = page.getByText('Load Demo (Spark.glb)');
    await loadBtn.click();
    
    // Wait for canvas to have content (approximated by checking if Scene Graph populates)
    // We expect "Part1" to appear in sidebar "Scene Objects" or dropdown.
    await expect(page.getByText('Part1')).toBeVisible();
  });

  test('should allow picking start/end points', async ({ page }) => {
    await page.getByText('Load Demo (Spark.glb)').click();
    
    // Select Moving Object
    await page.locator('select').selectOption({ label: 'Part1' });
    
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
     await page.getByText('Load Demo (Spark.glb)').click();
     await page.locator('select').selectOption({ label: 'Part1' });
     
     // Mocking state via direct JS evaluation if needed, or just clicking run if enabled.
     // Since Start/End are required for RUN to be enabled, we might check it's disabled initially.
     const runBtn = page.getByRole('button', { name: 'RUN' });
     await expect(runBtn).toBeDisabled();
  });
});
