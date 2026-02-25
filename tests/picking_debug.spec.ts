import { test, expect } from '@playwright/test';

test.describe('Picking Debug Test', () => {
  test.beforeEach(async ({ page }) => {
    // Enable console logs to terminal
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    await page.goto('http://localhost:5274');
  });

  test('should select part on click', async ({ page }) => {
    // 1. Load Demo
    await page.getByText('Load Demo (Spark.glb)').click();
    
    // 2. Wait for loading (approximate by waiting for sidebar list item?)
    // Or wait for window.__DEBUG_SELECTED_PART__ to be defined/null
    await page.waitForTimeout(5000); // Wait for model load

    // 3. Verify Initial State
    const initialPart = await page.evaluate(() => (window as any).__DEBUG_SELECTED_PART__);
    console.log('Initial Selection:', initialPart);
    expect(initialPart).toBeNull();

    // 4. Click Center (Raycast Test)
    // We click (500, 300) assuming default window size 1280x720?
    // Playwright default viewport is 1280x720.
    // Center is 640, 360.
    // Let's click 500, 300 (Left-ish).
    // Or better, click center of viewport.
    await page.mouse.click(640, 360);
    await page.waitForTimeout(1000);

    // 5. Check State
    const newPart = await page.evaluate(() => (window as any).__DEBUG_SELECTED_PART__);
    console.log('Selection after Click(640,360):', newPart);
    
    // If null, try another spot
    if (!newPart) {
        console.log("Click 1 failed, trying (500, 300)...");
        await page.mouse.click(500, 300);
        await page.waitForTimeout(1000);
        const retryPart = await page.evaluate(() => (window as any).__DEBUG_SELECTED_PART__);
        console.log('Selection after Click(500,300):', retryPart);
        expect(retryPart).toBeTruthy();
    } else {
        expect(newPart).toBeTruthy();
    }
  });
});
