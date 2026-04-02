import { test, expect } from '@playwright/test';

/**
 * Self-verification tests for:
 *   A. Full timing report returned from mate execution
 *   B. Group source geometry is NOT representative-part-only (uses combined bbox)
 */

// ---------------------------------------------------------------------------
// Test A — Full timing breakdown from action.smart_mate_execute
// ---------------------------------------------------------------------------

test.describe('Test A: timing report fields present', () => {
  test('smart_mate_execute returns all required timing fields', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.parts.order.length >= 2 && !!(window as any).__executeMcpTool;
    }, null, { timeout: 15_000 });
    await page.waitForTimeout(400);

    const result = await page.evaluate(async () => {
      const store = (window as any).__V2_STORE__.getState();
      const exec = (window as any).__executeMcpTool;
      const [srcId, tgtId] = store.parts.order;

      const res = await exec({
        tool: 'action.smart_mate_execute',
        args: {
          sourcePart: { partId: srcId },
          targetPart: { partId: tgtId },
          instruction: 'mate them',
          noCaptureFastPath: true,
          commit: false,
        },
      });

      return {
        ok: res?.ok,
        error: res?.error?.message ?? null,
        timing: res?.data?.timing ?? null,
        mateExecTiming: res?.data?.mateExecTiming ?? null,
        usedNoCaptureFastPath: res?.data?.usedNoCaptureFastPath,
      };
    });

    expect(result.ok, `smart_mate_execute failed: ${result.error}`).toBe(true);

    // ── Outer timing (from smart_mate_execute) ──────────────────────────────
    const t = result.timing;
    expect(t, 'timing object must be present').not.toBeNull();
    expect(typeof t.captureMs, 'captureMs must be number').toBe('number');
    expect(typeof t.agentMs, 'agentMs must be number').toBe('number');
    expect(typeof t.mateExecuteMs, 'mateExecuteMs must be number').toBe('number');
    expect(typeof t.totalMs, 'totalMs must be number').toBe('number');

    // On fast path both LLM stages are 0
    expect(t.captureMs, 'fast path: captureMs must be 0').toBe(0);
    expect(t.agentMs, 'fast path: agentMs must be 0').toBe(0);
    expect(t.totalMs, 'totalMs must be >= mateExecuteMs').toBeGreaterThanOrEqual(t.mateExecuteMs);

    // ── Inner mate-execution sub-stages (from action.mate_execute) ──────────
    // commit=false: mateExecTiming may be absent (no commit/propagation path)
    // but planGenMs, previewMs must be present
    const me = result.mateExecTiming;
    expect(me, 'mateExecTiming must be present').not.toBeNull();
    expect(typeof me.planGenMs, 'planGenMs must be number').toBe('number');
    expect(typeof me.candidateGenMs, 'candidateGenMs must be number').toBe('number');
    expect(typeof me.solverMs, 'solverMs must be number').toBe('number');
    expect(typeof me.previewMs, 'previewMs must be number').toBe('number');
    expect(typeof me.totalMs, 'mateExecTiming.totalMs must be number').toBe('number');

    // planGenMs should encompass candidateGenMs + solverMs
    expect(me.planGenMs, 'planGenMs >= candidateGenMs').toBeGreaterThanOrEqual(me.candidateGenMs);
  });

  test('demo_mate_and_apply returns nested timing with mateStageTiming + mateExecTiming', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.parts.order.length >= 2 && !!(window as any).__executeMcpTool;
    }, null, { timeout: 15_000 });
    await page.waitForTimeout(400);

    const result = await page.evaluate(async () => {
      const store = (window as any).__V2_STORE__.getState();
      const exec = (window as any).__executeMcpTool;
      const [srcId, tgtId] = store.parts.order;

      const res = await exec({
        tool: 'action.demo_mate_and_apply',
        args: {
          sourcePart: { partId: srcId },
          targetPart: { partId: tgtId },
          instruction: 'mate them',
          noCaptureFastPath: true,
          autoStep: false,
        },
      });

      return {
        ok: res?.ok,
        error: res?.error?.message ?? null,
        timing: res?.data?.timing ?? null,
        mateExecTiming: res?.data?.mateExecTiming ?? null,
      };
    });

    expect(result.ok, `demo_mate_and_apply failed: ${result.error}`).toBe(true);

    const t = result.timing;
    expect(t, 'outer timing must be present').not.toBeNull();
    expect(typeof t.mateExecuteMs).toBe('number');
    expect(typeof t.stepMs).toBe('number');
    expect(typeof t.totalMs).toBe('number');

    // mateStageTiming = inner smart_mate_execute timing
    const mst = t.mateStageTiming;
    expect(mst, 'mateStageTiming must be present').not.toBeNull();
    expect(typeof mst.captureMs).toBe('number');
    expect(typeof mst.agentMs).toBe('number');
    expect(typeof mst.totalMs).toBe('number');

    // mateExecTiming = inner action.mate_execute sub-stage timing
    const me = result.mateExecTiming;
    expect(me, 'mateExecTiming must be present').not.toBeNull();
    expect(typeof me.planGenMs).toBe('number');
    expect(typeof me.candidateGenMs).toBe('number');
    expect(typeof me.solverMs).toBe('number');
    expect(typeof me.previewMs).toBe('number');
    expect(typeof me.commitMs).toBe('number');
    expect(typeof me.groupPropagationMs).toBe('number');
    expect(typeof me.totalMs).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Test B — Group source geometry uses combined bbox, not representative-part only
// ---------------------------------------------------------------------------

test.describe('Test B: group source geometry is not representative-part-only', () => {
  test('mate_execute with sourceGroupId uses group_bbox for anchor, not representative_part', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.parts.order.length >= 3 && !!(window as any).__executeMcpTool;
    }, null, { timeout: 15_000 });
    await page.waitForTimeout(400);

    // Setup: place part1 and part2 at DIFFERENT Y positions so combined AABB differs
    // from rep-part-only bbox. Then create a group of those two parts.
    const setup = await page.evaluate(() => {
      const store = (window as any).__V2_STORE__.getState();
      const part1Id = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part1');
      const part2Id = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part2');
      const part3Id = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part3');
      if (!part1Id || !part2Id || !part3Id) throw new Error('parts not found');

      // part1 at y=0, part2 at y=0.5 (offset so their combined bbox != part1-only bbox)
      store.setPartOverride(part1Id, { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] });
      store.setPartOverride(part2Id, { position: [0.3, 0.5, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] });
      store.setPartOverride(part3Id, { position: [0, -0.6, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] });

      const groupId = store.createAssemblyGroup([part1Id, part2Id]);
      return { part1Id, part2Id, part3Id, groupId };
    });

    const { part1Id, part3Id, groupId } = setup;

    const result = await page.evaluate(
      async ({ p1, p3, gid }: { p1: string; p3: string; gid: string }) => {
        const exec = (window as any).__executeMcpTool;
        const res = await exec({
          tool: 'action.mate_execute',
          args: {
            sourcePart: { partId: p1 },
            targetPart: { partId: p3 },
            sourceGroupId: gid,
            sourceFace: 'bottom',
            targetFace: 'top',
            mode: 'translate',
            durationMs: 0,
            sampleCount: 2,
            commit: false,
          },
        });
        return {
          ok: res?.ok,
          error: res?.error?.message ?? null,
          groupSourceGeometry: res?.data?.groupSourceGeometry ?? null,
          mateExecTiming: res?.data?.mateExecTiming ?? null,
        };
      },
      { p1: part1Id, p3: part3Id, gid: groupId }
    );

    expect(result.ok, `mate_execute failed: ${result.error}`).toBe(true);

    // ── Group geometry diagnostics ──────────────────────────────────────────
    const g = result.groupSourceGeometry;
    expect(g, 'groupSourceGeometry diagnostic must be present for sourceGroupId calls').not.toBeNull();
    expect(g.sourceResolvedAs, 'sourceResolvedAs must be "group"').toBe('group');
    expect(g.sourceGroupId, 'sourceGroupId must be set').toBeTruthy();
    expect(g.representativePartId, 'representativePartId must be set').toBeTruthy();
    expect(g.groupMemberIds.length, 'groupMemberIds must have >= 2 members').toBeGreaterThanOrEqual(2);
    expect(g.groupMemberCount, 'groupMemberCount must match groupMemberIds.length').toBe(g.groupMemberIds.length);

    // KEY ASSERTION: group must use group-level geometry, not just representative part
    expect(g.groupStartPointMode, 'groupStartPointMode must be "group_bbox" (combined AABB computed)').toBe('group_bbox');
    expect(g.groupBboxCenter, 'groupBboxCenter must be present').not.toBeNull();
    expect(g.groupBboxSize, 'groupBboxSize must be present').not.toBeNull();

    // The offset must have been applied (because part2 is at y=0.5, so combined bbox
    // bottom is different from part1-only bottom when part2 sits lower).
    // Either groupStartPointFrom = 'group_bbox' (offset applied) OR it remains
    // 'representative_part' only if combined AABB face center == rep part face center
    // (which shouldn't happen when parts are at different Y).
    // We don't assert the exact value here, but document the current state:
    console.log(`groupStartPointFrom=${g.groupStartPointFrom} offsetApplied=${JSON.stringify(g.offsetApplied)}`);

    // If parts are at significantly different Y, offset MUST be non-zero
    // (combined AABB bottom < part1-only bottom because part2 hangs lower)
    // Assert that groupStartPointFrom is 'group_bbox' (the fix is active)
    expect(g.groupStartPointFrom, 'groupStartPointFrom must be "group_bbox" when members are spatially offset').toBe('group_bbox');
    expect(g.offsetApplied, 'offsetApplied must be non-null when group bbox differs from rep-part bbox').not.toBeNull();

    // ── Timing sub-stages present ───────────────────────────────────────────
    const me = result.mateExecTiming;
    expect(me, 'mateExecTiming must be present').not.toBeNull();
    expect(typeof me.planGenMs).toBe('number');
    expect(typeof me.candidateGenMs).toBe('number');
    expect(typeof me.solverMs).toBe('number');
    expect(typeof me.previewMs).toBe('number');
  });

  test('groupSourceGeometry.groupFeatureCount reflects actual mesh count', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.parts.order.length >= 3 && !!(window as any).__executeMcpTool;
    }, null, { timeout: 15_000 });
    await page.waitForTimeout(400);

    const setup = await page.evaluate(() => {
      const store = (window as any).__V2_STORE__.getState();
      const part1Id = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part1');
      const part2Id = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part2');
      const part3Id = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part3');
      if (!part1Id || !part2Id || !part3Id) throw new Error('parts not found');
      store.setPartOverride(part1Id, { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] });
      store.setPartOverride(part2Id, { position: [0.3, 0.5, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] });
      store.setPartOverride(part3Id, { position: [0, -0.6, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] });
      const groupId = store.createAssemblyGroup([part1Id, part2Id]);
      return { part1Id, part3Id, groupId };
    });

    const result = await page.evaluate(
      async ({ p1, p3, gid }: { p1: string; p3: string; gid: string }) => {
        const exec = (window as any).__executeMcpTool;
        const res = await exec({
          tool: 'action.mate_execute',
          args: {
            sourcePart: { partId: p1 },
            targetPart: { partId: p3 },
            sourceGroupId: gid,
            sourceFace: 'bottom',
            targetFace: 'top',
            mode: 'translate',
            durationMs: 0,
            sampleCount: 2,
            commit: false,
          },
        });
        return res?.data?.groupSourceGeometry ?? null;
      },
      { p1: setup.part1Id, p3: setup.part3Id, gid: setup.groupId }
    );

    expect(result, 'groupSourceGeometry must be present').not.toBeNull();
    // groupFeatureCount >= 2 (at least one mesh per group member)
    expect(result.groupFeatureCount, 'groupFeatureCount must be >= 2 (one mesh per member minimum)').toBeGreaterThanOrEqual(2);
    // groupCentroid must be present and be a 3-element array
    expect(result.groupCentroid, 'groupCentroid must be present').not.toBeNull();
    expect(Array.isArray(result.groupCentroid), 'groupCentroid must be array').toBe(true);
    expect(result.groupCentroid.length, 'groupCentroid must be [x,y,z]').toBe(3);
  });
});
