import { test, expect } from '@playwright/test';

test.describe('v2 responsive panel', () => {
  test('right panel scrolls to bottom on small viewport', async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('http://127.0.0.1:5173/?v=2', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForSelector('[data-testid="panel-right-scroll"]');

    await page.getByTestId('workspace-tab-mate').click();

    const metrics = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="panel-right-scroll"]') as HTMLElement;
      if (!el) return null;
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    });
    expect(metrics).not.toBeNull();
    if (metrics && metrics.scrollHeight > metrics.clientHeight) {
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="panel-right-scroll"]') as HTMLElement;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
      });
      const scrollTop = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="panel-right-scroll"]') as HTMLElement;
        return el ? el.scrollTop : 0;
      });
      expect(scrollTop).toBeGreaterThan(0);
    }

    await expect(page.getByTestId('mate-apply')).toBeVisible();
  });
});
