import { test, expect } from '@playwright/test';

/**
 * Part B regression tests: vlm.capture_for_mate multi-angle capture.
 *
 * These tests run with no GEMINI_API_KEY / MATE_VLM_ENABLE, so VLM inference
 * is always skipped (meetsThreshold=false). We verify:
 *  - 6 images are captured by default (one per preset angle)
 *  - angleLabels filtering captures only the requested subset
 *  - camera position is fully restored after capture
 */

test.describe('v2 vlm.capture_for_mate', () => {
  test('default capture returns 6 angles, meetsThreshold=false without VLM key', async ({ page }) => {
    test.skip(
      Boolean(process.env.MATE_VLM_MOCK_RESPONSE),
      'Skipped when mock VLM server is active — meetsThreshold will be true'
    );
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const s = (window as any).__V2_STORE__.getState();
      return s.connection.wsConnected && s.parts.order.length >= 2;
    });

    const result = await page.evaluate(async () => {
      const store = (window as any).__V2_STORE__.getState();
      const [sourceId, targetId] = store.parts.order as string[];
      const { executeMcpToolRequest } = await import('/src/v2/network/mcpToolExecutor.ts');
      return await executeMcpToolRequest({
        tool: 'vlm.capture_for_mate',
        args: {
          sourcePart: { partId: sourceId },
          targetPart: { partId: targetId },
          userText: 'mate part1 and part2',
          maxWidthPx: 256,
          maxHeightPx: 192,
          confidenceThreshold: 0.75,
        },
      });
    });

    expect(result?.ok).toBe(true);
    expect(result.data.imageCount).toBe(6);
    expect(result.data.capturedAngles).toHaveLength(6);
    expect(result.data.capturedAngles).toContain('front');
    expect(result.data.capturedAngles).toContain('top');
    expect(result.data.capturedAngles).toContain('iso');
    // No VLM key in test env → vlmInference null → meetsThreshold false
    expect(result.data.meetsThreshold).toBe(false);
    expect(result.data.vlmInference).toBeNull();
    expect(result.data.fallbackReason).toBeTruthy();
  });

  test('angleLabels filter captures only specified angles', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const s = (window as any).__V2_STORE__.getState();
      return s.connection.wsConnected && s.parts.order.length >= 2;
    });

    const result = await page.evaluate(async () => {
      const store = (window as any).__V2_STORE__.getState();
      const [sourceId, targetId] = store.parts.order as string[];
      const { executeMcpToolRequest } = await import('/src/v2/network/mcpToolExecutor.ts');
      return await executeMcpToolRequest({
        tool: 'vlm.capture_for_mate',
        args: {
          sourcePart: { partId: sourceId },
          targetPart: { partId: targetId },
          angleLabels: ['front', 'top', 'iso'],
          maxWidthPx: 256,
          maxHeightPx: 192,
        },
      });
    });

    expect(result?.ok).toBe(true);
    expect(result.data.imageCount).toBe(3);
    expect(result.data.capturedAngles).toEqual(['front', 'top', 'iso']);
  });

  test('camera position is restored after multi-angle capture', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const s = (window as any).__V2_STORE__.getState();
      return s.connection.wsConnected && s.parts.order.length >= 2;
    });

    const { before, after } = await page.evaluate(async () => {
      const { getV2Camera } = await import('/src/v2/three/SceneRegistry.ts');
      const { captureMultiAngles } = await import('/src/v2/three/captureMultiAngle.ts');

      const camBefore = getV2Camera();
      const posBefore = camBefore
        ? [camBefore.position.x, camBefore.position.y, camBefore.position.z]
        : null;

      await captureMultiAngles({ maxWidthPx: 128, maxHeightPx: 96 });

      const camAfter = getV2Camera();
      const posAfter = camAfter
        ? [camAfter.position.x, camAfter.position.y, camAfter.position.z]
        : null;

      return { before: posBefore, after: posAfter };
    });

    expect(before).not.toBeNull();
    expect(after).not.toBeNull();

    // Position must be restored within floating-point tolerance.
    const dist = Math.sqrt(
      (before as number[]).reduce((sum, v, i) => sum + (v - (after as number[])[i]) ** 2, 0)
    );
    expect(dist).toBeLessThan(1e-4);
  });
});

/**
 * Part E integration test: VLM mock response flows through wsGateway →
 * mockProvider → action.mate_execute with VLM-inferred face params.
 *
 * Requires the MCP server to be started with MATE_VLM_MOCK_RESPONSE set.
 * In CI this is handled by restarting the server with the env var.
 * In local dev, run: MATE_VLM_MOCK_RESPONSE='...' npx tsx mcp-server/v2/index.ts
 */
test.describe('v2 VLM mate E2E (mock server)', () => {
  test.skip(
    !process.env.MATE_VLM_MOCK_RESPONSE,
    'Skipped unless MATE_VLM_MOCK_RESPONSE is set on the test runner'
  );

  test('VLM mock inference flows into mate_execute face params', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const s = (window as any).__V2_STORE__.getState();
      return s.connection.wsConnected && s.parts.order.length >= 2;
    });

    // Grab part names for the chat command.
    const partNames = await page.evaluate(() => {
      const s = (window as any).__V2_STORE__.getState();
      return s.parts.order.map((id: string) => s.parts.byId[id].name) as string[];
    });

    // Send a generic mate command via chat.
    await page.getByTestId('workspace-tab-chat').click();
    const chatInput = page.getByTestId('chat-input');
    await chatInput.fill(`mate ${partNames[0]} and ${partNames[1]}`);
    await page.keyboard.press('Enter');

    // The VLM mock should inject right→left faces (from MATE_VLM_MOCK_RESPONSE).
    // We verify the chat reply contains the VLM-inferred face labels.
    const mockFaces = JSON.parse(process.env.MATE_VLM_MOCK_RESPONSE!);
    await expect(page.getByTestId('chat-messages')).toContainText(
      mockFaces.sourceFace,
      { timeout: 20_000 }
    );
  });
});
