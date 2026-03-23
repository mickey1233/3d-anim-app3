import { test, expect } from '@playwright/test';

test.describe('v2 mate mode=both rotation correction', () => {
  test('aligns face normals: pre-rotated part should match base orientation after mode=both', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5173/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const s = (window as any).__V2_STORE__.getState();
      return s.parts.order.length >= 2 && s.connection?.wsConnected;
    }, { timeout: 30_000 });

    // Pre-rotate part1 by 45° around Z and position it above base
    const partIds = await page.evaluate(() => {
      const store = (window as any).__V2_STORE__.getState();
      const sourceId = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part1');
      const targetId = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'base');
      if (!sourceId || !targetId) return null;
      const tgt = store.getPartTransform(targetId);
      const sinH = Math.sin(Math.PI / 8), cosH = Math.cos(Math.PI / 8); // 45°/2 half-angle
      store.setPartOverride(sourceId, {
        position: [tgt.position[0], tgt.position[1] + 0.5, tgt.position[2]],
        quaternion: [0, 0, sinH, cosH], // 45° around +Z
        scale: [1, 1, 1],
      });
      return { sourceId, targetId };
    });
    expect(partIds).not.toBeNull();
    if (!partIds) return;

    // Trigger mate via chat
    await page.getByTestId('workspace-tab-chat').click();
    await page.getByTestId('chat-input').fill('mate part1 to base');
    await page.keyboard.press('Enter');

    // Wait for mode=both response and store update
    await expect(page.getByTestId('chat-messages')).toContainText('mode=both', { timeout: 20_000 });

    // Wait until part1's quaternion changes (mate applied)
    await page.waitForFunction((sourceId) => {
      const store = (window as any).__V2_STORE__.getState();
      const t = store.getPartTransform(sourceId);
      if (!t) return false;
      const [, , , qw] = t.quaternion;
      const halfAngleRad = Math.acos(Math.min(1, Math.abs(qw)));
      return halfAngleRad * 2 < (10 * Math.PI / 180);
    }, partIds.sourceId, { timeout: 15_000 });

    const result = await page.evaluate((sourceId) => {
      const store = (window as any).__V2_STORE__.getState();
      return store.getPartTransform(sourceId)?.quaternion;
    }, partIds.sourceId);

    expect(result).toBeTruthy();
    if (result) {
      const [, , , qw] = result as [number, number, number, number];
      const angleDeg = 2 * Math.acos(Math.min(1, Math.abs(qw))) * (180 / Math.PI);
      expect(angleDeg).toBeLessThan(10); // within 10° of base orientation
    }
  });
});
