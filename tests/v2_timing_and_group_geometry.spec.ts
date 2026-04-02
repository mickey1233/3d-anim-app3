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

// ---------------------------------------------------------------------------
// Test C — Fan-group → THERMAL regression (2-part group → standalone target)
// Simulates the "fan module Group 1 → THERMAL" real case using the boxes fixture:
//   "fan_A" (part1) + "fan_B" (part2) grouped as fan-module
//   "THERMAL" (part3) = standalone structural target
// ---------------------------------------------------------------------------

test.describe('Test C: fan-group → THERMAL regression', () => {
  test('2-part group mates to standalone target with group-aware anchor and rigid propagation', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('http://127.0.0.1:5274/?v=2&fixture=boxes', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);
    await page.waitForFunction(() => {
      const state = (window as any).__V2_STORE__?.getState?.();
      return !!state && state.parts.order.length >= 3 && !!(window as any).__executeMcpTool;
    }, null, { timeout: 15_000 });
    await page.waitForTimeout(400);

    // Setup: fan_A at (0,0.5,0), fan_B at (0.4,0.5,0) — spatially offset so combined
    // AABB bottom ≠ fan_A-only AABB bottom. THERMAL at (0,-0.5,0).
    const setup = await page.evaluate(() => {
      const store = (window as any).__V2_STORE__.getState();
      const fanAId = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part1');
      const fanBId = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part2');
      const thermalId = store.parts.order.find((id: string) => store.parts.byId[id]?.name === 'part3');
      if (!fanAId || !fanBId || !thermalId) throw new Error('parts not found: need part1, part2, part3');

      // Fan_A and fan_B side-by-side at y=0.5 (the "fan module")
      store.setPartOverride(fanAId, { position: [0, 0.5, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] });
      store.setPartOverride(fanBId, { position: [0.4, 0.5, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] });
      // THERMAL below the fan module
      store.setPartOverride(thermalId, { position: [0.2, -0.2, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] });

      // Record fan_B's world position BEFORE mate for relative-transform check
      const fanBPosBefore = [0.4, 0.5, 0];

      const groupId = store.createAssemblyGroup([fanAId, fanBId]);
      return { fanAId, fanBId, thermalId, groupId, fanBPosBefore };
    });

    const { fanAId, fanBId, thermalId, groupId, fanBPosBefore } = setup;

    // Execute the fan-group → THERMAL mate
    const result = await page.evaluate(
      async ({ fanA, fanB, thermal, gid }: { fanA: string; fanB: string; thermal: string; gid: string }) => {
        const exec = (window as any).__executeMcpTool;
        const res = await exec({
          tool: 'action.mate_execute',
          args: {
            sourcePart: { partId: fanA },
            targetPart: { partId: thermal },
            sourceGroupId: gid,
            sourceFace: 'bottom',
            targetFace: 'top',
            mode: 'translate',
            durationMs: 0,
            sampleCount: 2,
            commit: true,
            pushHistory: false,
          },
        });

        // Read final transforms from store
        const store = (window as any).__V2_STORE__.getState();
        const fanATransform = store.getPartTransform(fanA);
        const fanBTransform = store.getPartTransform(fanB);

        return {
          ok: res?.ok,
          error: res?.error?.message ?? null,
          groupSourceGeometry: res?.data?.groupSourceGeometry ?? null,
          groupRigidBody: res?.data?.groupRigidBody ?? null,
          mateExecTiming: res?.data?.mateExecTiming ?? null,
          fanAFinalPos: fanATransform?.position ?? null,
          fanBFinalPos: fanBTransform?.position ?? null,
        };
      },
      { fanA: fanAId, fanB: fanBId, thermal: thermalId, gid: groupId }
    );

    expect(result.ok, `fan-group mate failed: ${result.error}`).toBe(true);

    // ── C1: sourceResolvedAs = 'group' ────────────────────────────────────
    const g = result.groupSourceGeometry;
    expect(g, 'groupSourceGeometry must be present').not.toBeNull();
    expect(g.sourceResolvedAs, 'sourceResolvedAs must be "group"').toBe('group');
    expect(g.sourceGroupId, 'sourceGroupId must match the created group').toBe(groupId);

    // ── C2: group has exactly 2 members (fan_A and fan_B) ─────────────────
    expect(g.groupMemberIds.length, 'groupMemberIds must have 2 members (fan_A + fan_B)').toBe(2);
    expect(g.groupMemberIds, 'groupMemberIds must include fan_A').toContain(fanAId);
    expect(g.groupMemberIds, 'groupMemberIds must include fan_B').toContain(fanBId);

    // ── C3: group-aware anchor mode (aggregate planar cluster preferred) ───
    // After the Task B fix, groupStartPointMode should be 'group_aggregate_planar_cluster'
    // (or 'group_bbox' if mesh geometry yields no aligned faces — but boxes fixture has them)
    expect(
      ['group_aggregate_planar_cluster', 'group_bbox'].includes(g.groupStartPointMode),
      `groupStartPointMode must be group-aware, got: ${g.groupStartPointMode}`
    ).toBe(true);
    // Specifically assert the upgraded mode is active now that Task B is done
    expect(g.groupStartPointMode, 'groupStartPointMode must be group_aggregate_planar_cluster after Task B fix').toBe('group_aggregate_planar_cluster');
    expect(g.alignedFaceCount, 'alignedFaceCount must be > 0 (faces found in group meshes)').toBeGreaterThan(0);

    // ── C4: rigid-body propagation complete ───────────────────────────────
    const rb = result.groupRigidBody;
    expect(rb, 'groupRigidBody must be present').not.toBeNull();
    expect(rb.groupRigidBodyApplied, 'rigid body delta must have been applied').toBe(true);
    expect(rb.propagationComplete, 'propagationComplete must be true — all members must be updated').toBe(true);
    expect(rb.skippedMemberIds, 'no members should be skipped').toHaveLength(0);
    expect(rb.updatedMemberIds, 'fan_B must be in updatedMemberIds').toContain(fanBId);

    // ── C5: fan_B received a world transform update ────────────────────────
    expect(result.fanBFinalPos, 'fan_B must have a final world position').not.toBeNull();

    // ── C6: relative offset fan_A → fan_B is preserved (rigid body semantics) ──
    // Before mate: fan_A at (0,0.5,0), fan_B at (0.4,0.5,0) → relative offset = (0.4,0,0)
    // After mate: fan_A moved to near THERMAL top, fan_B should follow with same offset.
    if (result.fanAFinalPos && result.fanBFinalPos) {
      const relXAfter = result.fanBFinalPos[0] - result.fanAFinalPos[0];
      const relYAfter = result.fanBFinalPos[1] - result.fanAFinalPos[1];
      const relZAfter = result.fanBFinalPos[2] - result.fanAFinalPos[2];
      // Relative X offset should be preserved: fan_B was 0.4 units to the right of fan_A
      expect(Math.abs(relXAfter - 0.4), `relative X offset fan_B-fan_A should be ~0.4, got ${relXAfter.toFixed(3)}`).toBeLessThan(0.01);
      expect(Math.abs(relYAfter), `relative Y offset fan_B-fan_A should be ~0, got ${relYAfter.toFixed(3)}`).toBeLessThan(0.01);
      expect(Math.abs(relZAfter), `relative Z offset fan_B-fan_A should be ~0, got ${relZAfter.toFixed(3)}`).toBeLessThan(0.01);
    }

    // ── C7: timing fields present ─────────────────────────────────────────
    const me = result.mateExecTiming;
    expect(me, 'mateExecTiming must be present').not.toBeNull();
    expect(typeof me.planGenMs).toBe('number');
    expect(typeof me.commitMs).toBe('number');
    expect(typeof me.groupPropagationMs).toBe('number');
    // commitBreakdown should show the internal stages of commit_preview
    expect(me.commitBreakdown, 'commitBreakdown from commit_preview must be present').not.toBeNull();
    expect(typeof me.commitBreakdown.sceneStateMs).toBe('number');
    expect(typeof me.commitBreakdown.historyRecordMs).toBe('number');
    expect(typeof me.commitBreakdown.previewCleanupMs).toBe('number');
    expect(typeof me.commitBreakdown.commitTotalMs).toBe('number');
    // All internal commit stages should be sub-5ms (commit_preview is pure sync JS, not the bottleneck)
    expect(me.commitBreakdown.commitTotalMs, 'commit_preview internal total must be < 50ms (bottleneck is React re-render, not this)')
      .toBeLessThan(50);
  });
});
