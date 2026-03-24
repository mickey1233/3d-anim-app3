import { test, expect } from '@playwright/test';

test.describe('v2 view.capture_image', () => {
  test('returns a dataUrl screenshot of the canvas', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.connection.wsConnected === true && state.parts.order.length >= 1;
    });

    const result = await page.evaluate(async () => {
      const mod = await import('/src/v2/network/mcpToolsClient.ts');
      return await mod.callMcpTool('view.capture_image', {
        maxWidthPx: 320,
        maxHeightPx: 240,
        format: 'png',
      });
    });

    expect(result?.ok).toBe(true);
    const dataUrl = result.data.image.dataUrl as string;
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(result.data.image.widthPx).toBeGreaterThan(0);
    expect(result.data.image.heightPx).toBeGreaterThan(0);
    expect(result.data.image.widthPx).toBeLessThanOrEqual(320);
    expect(result.data.image.heightPx).toBeLessThanOrEqual(240);
    expect(dataUrl.length).toBeGreaterThan(2000);
  });
});

