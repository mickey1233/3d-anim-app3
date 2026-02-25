# DEVLOG — 3D CAD Animation & Assembly Studio

> 時間基準：本次執行時間為 2026-02-11（local）。本檔用來記錄可中斷/可續跑的進度、決策與測試證據。

## Progress (Quality-First MCP-only migration)
- CURRENT_SUBTASK: S11 — VLM-guided mate inference (multi-angle capture → mode/intent/face/source/target)
- DONE_SUBTASKS: [S1, S2, S3, S4, S5a, S5b, S5c, S5d, S5e, S5f, S5g, S5h, S5i, S6, S7a, S7b, S7c, S7d, S7e, S8a, S9a, S10]
- NEXT_SUBTASK: S12 — port consolidation + full VLM mate flow integration
- HOW_TO_RESUME:
  1) Frontend: `npm run dev -- --host 127.0.0.1 --port 5173`
  2) MCP v2 WS gateway: `npx tsx mcp-server/v2/index.ts` (default `ws://127.0.0.1:3011`)
  3) Open: `http://127.0.0.1:5173/?v=2&fixture=boxes`
  4) Chat + mate regression: `npx playwright test tests/v2_chat_router.spec.ts tests/v2_mate_translate_parity.spec.ts tests/v2_mate_smart_ui_mismatch.spec.ts --reporter=line`
  5) Mate panel via MCP + offsets: `npx playwright test tests/v2_mate_panel_apply_mcp.spec.ts tests/v2_mate_offsets_mcp.spec.ts --reporter=line`
  6) Suggestions + fixtures (side/lid/slot): `npx playwright test tests/v2_query_mate_suggestions.spec.ts tests/v2_mate_suggestions_fixtures.spec.ts --reporter=line`
  7) View capture: `npx playwright test tests/v2_view_capture.spec.ts --reporter=line`
  8) Full S7d validation: `npx playwright test tests/v2_chat_router.spec.ts tests/v2_mate_translate_parity.spec.ts tests/v2_mate_panel_apply_mcp.spec.ts tests/v2_mate_offsets_mcp.spec.ts tests/v2_query_mate_suggestions.spec.ts tests/v2_mate_suggestions_fixtures.spec.ts tests/v2_mate_smart_ui_mismatch.spec.ts tests/v2_view_capture.spec.ts --reporter=line`
  9) S7e validation (mate latency + marker visibility): `npx playwright test tests/v2_mate_ui_latency.spec.ts tests/v2_markers_visibility.spec.ts tests/v2_chat_router.spec.ts tests/v2_mate_translate_parity.spec.ts --reporter=line`
  10) Validation E2E (mate regression): `npx playwright test tests/v2_mate_preview.spec.ts tests/v2_mate_methods.spec.ts tests/v2_mate_rotation.spec.ts --reporter=line`
  11) Smoke: `npx playwright test tests/v2_smoke.spec.ts --reporter=line`
  12) Real CAD import check: `npx playwright test tests/v2_real_model_mate_perf.spec.ts --reporter=line`
  13) Rotate gizmo regression (current gap): add/run `tests/v2_gizmo_hit_priority.spec.ts`

## S10 — Fix Mate Mode & Face Inference Bugs (2026-02-25)

### Scope
- Bug A: "幫我把part2和part1組裝起來" → `mode=both` → unexpected rotation instead of translate
- Bug B: When part2 is moved right, face inference changes from bottom/top to left/right — purely positional, wrong

### Root causes
1. `inferIntentFromGeometry` detects vertical stacking → `intent='cover'` → `defaultModeForIntent('cover')='both'`
2. `inferMateWithLlm` (hybrid path) infers `mode='both'` for generic "組裝" commands
3. `getExpectedFacePairFromCenters` is purely positional and contaminates face scoring + fallback chain

### What changed
- `src/v2/network/mcpToolExecutor.ts`
  - `inferBestFacePair` scoring: `expectedFaceScore` weight `0.10 → 0.02` (positional bias greatly reduced)
  - `action.mate_execute` face fallback: replaced `getExpectedFacePairFromCenters(...)` with static `'bottom'/'top'`
- `mcp-server/v2/router/mockProvider.ts`
  - Face resolution chain: removed `expectedFromCenters` from fallback
  - `suggestedMode` guard: when suggestion context yields `mode='both'` and no explicit user mode → use `'translate'`
  - LLM mode guard: when LLM infers `mode='both'` without explicit command → drop it, fall through to `'translate'`
- `src/v2/three/fixtures/NestedFixture.tsx` — new nested fixture for regression testing
- `tests/v2_mate_both_nested_parent.spec.ts` — new tests:
  - "generic assembly command uses translate not both" — verifies 組裝 → `mode=translate`
  - "cover/both moves the source" — verifies explicit "cover" keyword still triggers `mode=both`

### Test results
- `v2_mate_both_nested_parent.spec.ts`: ✅ 2 passed
- Broader regression (9 tests): ✅ 9 passed

### VLM accuracy note
Bugs shown were NOT VLM — they were mockProvider NLP + geometry inference bugs.
To improve actual VLM accuracy (image analysis tab):
1. Inject scene part names + positions into VLM system prompt
2. Ask VLM to reason step-by-step (CoT) about which part moves where
3. Gate VLM face pairs behind confidence threshold ≥ 0.85
4. Cross-validate VLM face inference against geometry-based `mate_suggestions`
5. Fall back to interactive selection when VLM confidence < threshold

## S9a — Rotate gizmo raycast priority core fix (2026-02-24)

### Scope
- Fix rotate/move mode interaction where a mesh behind the gizmo can win raycast hits and prevent dragging the transform gizmo.
- Keep mate face picking behavior unchanged (only apply priority in `move` / `rotate` mode).

### Root cause
- R3F dispatches pointer events by nearest raycast intersection.
- When a model mesh overlaps the gizmo handle in screen space, the mesh can be hit first, so gizmo drag never starts.
- `TransformGizmo` already calls `stopPropagation()`, but that only works after the gizmo receives the event; it does not help when the gizmo loses the initial hit test.

### What changed
- `src/v2/three/interaction/TransformGizmo.tsx`
  - Marked TransformControls helper/handle objects with a raycast-priority flag (`__v2TransformGizmoHandle`) while mounted.
- `src/v2/three/CanvasRoot.tsx`
  - Added a Canvas `events.filter` wrapper to reorder intersections so flagged gizmo hits are prioritized.
  - Priority is active only when a part is selected and interaction mode is `move` or `rotate`.
  - Leaves other modes (including mate face picking) unchanged.

### Browser verification evidence
- Regression/smoke batch:
  - `npx playwright test tests/v2_chat_router.spec.ts tests/v2_mate_translate_parity.spec.ts tests/v2_mate_smart_ui_mismatch.spec.ts tests/controls_drag.spec.ts --reporter=line`
  - Result: ✅ `5 passed`

### Known limitations / next step
- （pending）專用 E2E 尚未直接拖曳 gizmo handle 驗證「背後物件重疊時仍可拖動」；這是 `S9b` 的目標。
- 已先完成核心 raycast-priority 修正，並用現有互動回歸確認未破壞其他流程。

## S8a — Bare `mate part1 and part2` source/target stability (2026-02-24)

### Scope
- Reduce surprising source/target swaps for under-specified mate commands like `mate part1 and part2`.
- Preserve LLM help for face/method/mode inference, but make bare command direction deterministic.

### Root cause
- Router allowed LLM inference to override source/target order whenever confidence was high enough, even when the user did not provide directional or placement semantics.
- In real models, this can flip which part is moved (source) vs fixed (target), producing a visibly different result from manual Mate UI usage.

### What changed
- `mcp-server/v2/router/mockProvider.ts`
  - Added `shouldAllowLlmSourceTargetOverride(text)` gate.
  - LLM can still infer face/method/mode for bare mate commands.
  - Source/target override is now limited to commands with stronger placement/assembly semantics (e.g. install/insert/cover/lid/cap/socket/plug and Chinese equivalents).
  - Bare `mate part1 and part2` now keeps mention order unless the user gives explicit direction.

### Browser verification evidence
- `npx playwright test tests/v2_chat_router.spec.ts tests/v2_mate_translate_parity.spec.ts tests/v2_mate_smart_ui_mismatch.spec.ts --reporter=line`
- Result: ✅ `4 passed`

### Assumptions / decisions
- For ambiguous bare mate commands, deterministic mention order is preferred over aggressive LLM source/target swapping.
- Richer semantic source/target inference remains a planned follow-up in `S10` once scene-context + intent classification is further upgraded.

## S7e — Mate panel latency + marker compaction (2026-02-11)

### Scope
- Fix Mate panel option switching lag (`source/target/face/method/mode`) caused by unnecessary UI rerenders.
- Ensure source/target markers are less obstructive in 3D view.
- Keep chat/mate behavior stable after optimization.

### Root cause
- `MatePanel` subscribed to the whole `parts` object, including `overridesById`.
- Any transform override update (preview/commit path) rebuilt `parts`, forcing `MatePanel` rerender while user was switching options.
- Marker visuals remained large in anchored view and visible outside mate context in some flows.

### What changed
- `src/v2/ui/MatePanel/MatePanel.tsx`
  - Replaced `useV2Store((s) => s.parts)` with scoped selectors: `parts.order` + `parts.byId`.
  - Memoized `partList` with `React.useMemo` to avoid recomputation churn.
  - Kept apply payload unchanged (MCP path remains `action.mate_execute`).
- `src/v2/three/mating/MatePreviewMarkers.tsx`
  - Optimized part-object lookup by building a single map via scene traversal instead of repeated `getObjectByProperty` per part.
  - Added both-anchor gating: preview markers render only when both source and target anchors are resolved.
  - Reduced marker radius/segments for less visual occlusion.
- `src/v2/three/anchors/AnchorMarkers.tsx`
  - Show markers only in mate context (`interaction.mode === 'mate'` or workspace section `mate`).
  - Reduced marker sphere size (`0.03 -> 0.012`).

### Browser verification evidence
- `npx playwright test tests/v2_mate_ui_latency.spec.ts tests/v2_markers_visibility.spec.ts tests/v2_chat_router.spec.ts tests/v2_mate_translate_parity.spec.ts --reporter=line`
- Result: ✅ `5 passed`

### Assumptions / decisions
- For correctness, marker visibility is now tied to mate context; this reduces clutter by default and matches user expectation.
- Performance-first fix focuses on rerender pressure and scene lookup complexity; no solver math was changed in S7e.

## S7d — Multi-round router planning + suggestion-driven mate (2026-02-11)

### Scope
- Convert `router_execute` from one-shot dispatch to bounded multi-round planning.
- Make natural mate command route as: `query.mate_suggestions` -> `action.mate_execute` (instead of direct fixed defaults).
- Prevent repeated action execution in loop while still allowing planning rounds.
- Add a slot-style regression fixture proving why pure object AABB can fail insertion.

### What changed
- `mcp-server/v2/wsGateway.ts`
  - Added iterative router loop with bounded rounds (`ROUTER_MAX_ITERATIONS`, default 3).
  - Added tool-result summarization + context feedback (`ctx.toolResults`) between rounds.
  - Added planning-stop rule: only continue loop for pure `query.*` / `view.capture_image` rounds; stop after mutating action rounds.
- `mcp-server/v2/router/types.ts`
  - Extended `RouterContext` with `toolResults` and `iteration` to support planning feedback.
- `mcp-server/v2/router/mockProvider.ts`
  - Mate flow changed to two-phase for under-specified prompts:
    1) first round call `query.mate_suggestions`
    2) next round use returned ranking/intent to call `action.mate_execute`
  - Reply text now reports final chosen face/method/mode (not fixed bottom/top defaults).
  - Explicit commands still honored (`mate part1 bottom and part2 top use object aabb method`).
- `src/v2/network/mcpToolExecutor.ts`
  - Method-priority tuning: default/cover intent now prefer `auto`; insert intent still favors geometry-aware methods.
- `src/v2/three/fixtures/SlotFixture.tsx`
  - Added deterministic insert-slot geometry with side protrusions/inner floor.
- `src/v2/three/CanvasRoot.tsx`
  - Added `?fixture=slot`.
- `tests/v2_mate_suggestions_fixtures.spec.ts`
  - Added slot regression asserting insert intent avoids pure `object_aabb` top anchor and that `planar_cluster` top anchor sits deeper than object AABB top.

### Browser verification evidence
- Baseline before S7d:
  - `npx playwright test tests/v2_chat_router.spec.ts tests/v2_mate_translate_parity.spec.ts --reporter=line`
  - Result: ✅ `3 passed`
- Iterative loop regression after S7d-1:
  - `npx playwright test tests/v2_chat_router.spec.ts tests/v2_mate_translate_parity.spec.ts --reporter=line`
  - Result: ✅ `3 passed`
- Suggestion-driven mate + default alignment:
  - `npx playwright test tests/v2_chat_router.spec.ts tests/v2_mate_translate_parity.spec.ts tests/v2_mate_suggestions_fixtures.spec.ts tests/v2_query_mate_suggestions.spec.ts --reporter=line`
  - Result: ✅ `6 passed`
- Slot fixture regression:
  - `npx playwright test tests/v2_mate_suggestions_fixtures.spec.ts --reporter=line`
  - Result: ✅ `3 passed`
- Full S7d validation batch:
  - `npx playwright test tests/v2_chat_router.spec.ts tests/v2_mate_translate_parity.spec.ts tests/v2_mate_panel_apply_mcp.spec.ts tests/v2_mate_offsets_mcp.spec.ts tests/v2_query_mate_suggestions.spec.ts tests/v2_mate_suggestions_fixtures.spec.ts tests/v2_mate_smart_ui_mismatch.spec.ts tests/v2_view_capture.spec.ts --reporter=line`
  - Result: ✅ `11 passed`

### Assumptions / decisions
- Natural-language mate that omits face/method/mode is treated as planning-required, not immediately executable.
- Router multi-round is bounded and deterministic; no unbounded agent loop is allowed.
- For default/cover intent, method defaults prioritize manual parity (`auto`) while insert intent keeps geometry-aware selection.

## S7a — Repro harness + mate parity hardening (2026-02-11)

### Scope
- Reproduce the reported issue: chat mate execution differs from the Mate panel (even with the same faces/method/mode).
- Add a deterministic fixture that stresses planar-face selection (interior shelf vs AABB extremes).
- Add a Playwright parity check for the new fixture as a safety net before we migrate Mate UI to MCP tools.

### What changed
- `src/v2/three/fixtures/ShelfFixture.tsx`
  - Adds a 2-part fixture where `part1` has a large interior planar shelf above its feet.
  - Used to validate that solver paths stay consistent on non-trivial geometry.
- `src/v2/three/CanvasRoot.tsx`
  - Adds `?fixture=shelf`.
- `tests/v2_mate_smart_ui_mismatch.spec.ts`
  - Adds a parity test on `fixture=shelf` ensuring the chat-triggered mate and the Mate panel solver produce the same final transform.

### Browser verification evidence
- `npx playwright test tests/v2_mate_smart_ui_mismatch.spec.ts --reporter=line`
- Result: ✅ `1 passed`
- Notes:
  - This fixture did not reproduce the mismatch by itself (chat == manual in this scenario).
  - Hypothesis: the reported mismatch is model-specific (real CAD mesh topology / transforms / selection context).
  - Next: add a real-model parity repro (Spark demo) and then fix the root cause in MCP `generate_transform_plan` / `mate_execute`.

## S7b — Offset args survive MCP schemas (2026-02-11)

### Scope
- Fix a critical MCP contract issue: `sourceOffset/targetOffset` existed in the executor, but were not in the Zod tool schemas, so they were silently stripped by validation.
- Ensure offsets are forwarded end-to-end:
  - caller -> `action.smart_mate_execute` / `action.mate_execute` -> `action.generate_transform_plan` -> solver.

### What changed
- `shared/schema/mcpToolsV3.ts`
  - Added optional `sourceOffset` / `targetOffset` to:
    - `action.generate_transform_plan`
    - `action.mate_execute`
    - `action.smart_mate_execute`
- `src/v2/network/mcpToolExecutor.ts`
  - `action.mate_execute` now forwards offsets into `action.generate_transform_plan`.
  - `action.smart_mate_execute` forwards offsets into `action.mate_execute`.
- `tests/v2_mate_offsets_mcp.spec.ts`
  - New Playwright test that verifies `sourceOffset` changes the final committed transform via MCP tool calls.

### Browser verification evidence
- `npx playwright test tests/v2_mate_offsets_mcp.spec.ts tests/v2_mate_translate_parity.spec.ts --reporter=line`
- Result: ✅ `2 passed`

## S7c — MatePanel MCP-only apply (2026-02-11)

### Scope
- Ensure Mate panel no longer calls local solver directly for "Apply Mate".
- Make the UI path consistent with the MCP-only architecture: UI triggers `action.mate_execute`, which internally does plan -> preview -> commit.

### What changed
- `src/v2/ui/MatePanel/MatePanel.tsx`
  - Replaced `store.requestMate(...)` with `callMcpTool('action.mate_execute', ...)`.
  - Forwards face/method/mode + `sourceOffset/targetOffset` + twist settings.
  - Adds apply loading state and inline error message (`data-testid="mate-apply-error"`).
- `tests/v2_mate_panel_apply_mcp.spec.ts`
  - New Playwright test: clicking `mate-apply` moves the part, but does NOT set `mateTrace` (which would indicate the local `MateExecutor` path was used).

### Browser verification evidence
- `npx playwright test tests/v2_mate_panel_apply_mcp.spec.ts tests/v2_mate_offsets_mcp.spec.ts tests/v2_mate_translate_parity.spec.ts --reporter=line`
- Result: ✅ `3 passed`

## S6 — SceneToolApi geometry access + view capture (2026-02-11)

### Scope
- Provide MCP query tools real geometry context (not store-only approximations).
- Add a debuggable mate-suggestion API for smart routing and UI/LLM guidance.
- Add view capture tool to support future screenshot-based reasoning.

### What changed
- Three context registry
  - `src/v2/three/SceneRegistry.ts`: store `scene/camera/renderer/viewport` for tool executor usage.
  - `src/v2/three/SceneRegistryBridge.tsx`: registers three context from R3F (`scene`, `camera`, `gl`, `size`).
- Geometry-based query tools
  - `src/v2/network/mcpToolExecutor.ts`:
    - `query.bounding_box` now uses live `THREE.Box3().setFromObject(object)` (world box).
    - `query.face_info` now uses `resolveAnchor(...)` to compute an actual frame (origin/normal/tangent/bitangent) in world space.
- Mate suggestion tool
  - `shared/schema/mcpToolsV3.ts`: added `query.mate_suggestions` schema.
  - `src/v2/network/mcpToolExecutor.ts`: implemented `query.mate_suggestions` using:
    - face-pair ranking (facing/approach/distance/expected-face score)
    - geometry intent heuristic (`cover/insert/default`)
    - intent-aware suggested mode (`cover -> both`).
- View capture tool
  - `shared/schema/mcpToolsV3.ts`: added `view.capture_image` schema.
  - `src/v2/network/mcpToolExecutor.ts`: implemented `view.capture_image` by rendering to `WebGLRenderTarget` then encoding a flipped RGBA buffer to `data:image/*;base64,...`.
- Fixtures for deterministic geometry tests
  - `src/v2/three/fixtures/SideFixture.tsx`: two boxes side-by-side.
  - `src/v2/three/fixtures/LidFixture.tsx`: lid above base (cover intent).
  - `src/v2/three/CanvasRoot.tsx`: supports `?fixture=boxes|side|lid`.
- Tests
  - `tests/v2_query_mate_suggestions.spec.ts`: validates tool returns ranked pairs.
  - `tests/v2_mate_suggestions_fixtures.spec.ts`: validates side fixture prefers `right->left`, lid fixture infers `cover` + `both`.
  - `tests/v2_view_capture.spec.ts`: validates `view.capture_image` returns a PNG dataUrl.

### Browser verification evidence
- Regression suite:
  - `npx playwright test tests/v2_smoke.spec.ts tests/v2_chat_router.spec.ts tests/v2_mate_translate_parity.spec.ts tests/v2_mate_preview.spec.ts tests/v2_mate_methods.spec.ts tests/v2_view_capture.spec.ts tests/v2_query_mate_suggestions.spec.ts tests/v2_mate_suggestions_fixtures.spec.ts tests/v2_mate_ui_latency.spec.ts --reporter=line`
  - Result: ✅ `11 passed`

### Notes / limitations
- `view.capture_image` returns base64 over WS; keep `maxWidthPx/maxHeightPx` small for chat usage to avoid payload bloat.
- Router planner loop is implemented in S7d (bounded multi-round + tool-result feedback).

## S5i — Smart mate routing + geometry intent inference (2026-02-11)

### Scope
- Fix `mate part1 and part2` parse/execution instability:
  - Avoid random source/target reversal by volume heuristic.
  - Stop defaulting to `bottom/top + auto + translate` for every command.
  - Route implicit mate commands to geometry-aware MCP smart tool.
- Keep explicit command compatibility:
  - `mate part1 bottom and part2 top use object aabb method` should keep explicit faces/method.

### Root cause
- Router still called `action.mate_execute` directly and injected hard defaults (`sourceFace=bottom`, `targetFace=top`, `mode=translate`) before solver.
- `inferSourceTarget` applied size/name heuristics even for plain `A and B`, causing unexpected source/target swap.
- Smart execution path existed but chat router did not use it for implicit mate.

### What changed
- `mcp-server/v2/router/mockProvider.ts`
  - Mate routing changed from `action.mate_execute` to `action.smart_mate_execute`.
  - Source/target inference updated: sentence order first; explicit direction tokens override; heavy target heuristics only used for explicit placement verbs.
  - Face/method/mode now optional when user did not specify them; router no longer hard-injects `bottom/top`.
  - LLM source/target override now gated by confidence (`>= 0.82`) and explicit-direction protection.
  - Reply text now reflects explicit/auto status transparently.
- `mcp-server/v2/router/llmAssist.ts`
  - Mate inference prompt now includes per-part position + bbox context for better assembly relation reasoning.
  - Added instruction to avoid forced swaps when uncertain.
- `src/v2/network/mcpToolExecutor.ts`
  - Added geometry-intent inference (`insert` / `cover`) from world AABB overlap and relative placement.
  - Smart mate mode fallback now uses intent-aware defaults (`cover -> both`, otherwise translate).
  - Added debug note `geometry_intent` for traceability.
- `tests/v2_chat_router.spec.ts`
  - Added regression assertions for:
    - `mate part1 and part2` keeps parse order (`part1 -> part2`).
    - cover/lid sentence resolves to `mode=both`.

### Browser verification evidence
- Smart chat routing regression:
  - `npx playwright test tests/v2_chat_router.spec.ts --reporter=line`
  - Result: ✅ `2 passed`
- Mate parity regression:
  - `npx playwright test tests/v2_mate_translate_parity.spec.ts --reporter=line`
  - Result: ✅ `1 passed`

### Assumptions recorded
- If user writes plain `mate A and B`, deterministic behavior should prefer textual order (`A -> B`) unless explicit direction/intent strongly indicates otherwise.
- For generic no-mode commands, solver should infer geometry-aware faces/method first, and only fallback to simple defaults when geometry signals are insufficient.

## S5h — Chat mate parse parity + MCP translate parity (2026-02-11)

### Scope
- Fix mismatch where chat command `mate part1 and part2` / `mate part1 bottom to part2 top` produced a different translate result than Mate panel `Apply Mate`.
- Keep MCP `action.mate_execute` path numerically aligned with the Mate panel solver for translate mode.

### Root cause
- Two issues combined:
  1) Chat parse bug in `mockProvider`: `detectFaceNear` could pick the wrong face token from the same sentence (`part1 bottom ... part2 top` parsed as `part1(top)`).
  2) MCP transform-plan translate path previously diverged from mate solver implementation.

### What changed
- `src/v2/network/mcpToolExecutor.ts`
  - `action.generate_transform_plan` with `operation='mate'` now uses shared solver `solveMateTopBottom(..., 'translate')`.
  - Added explicit debug fields for parity debugging: `sourceFaceId`, `targetFaceId`, methods, offsets, `sourceFaceCenterWorld`, `targetFaceCenterWorld`, `translationWorld`.
- `mcp-server/v2/router/mockProvider.ts`
  - Reworked face detection in text segments to prefer nearest alias (first/last occurrence strategy), eliminating source/target face cross-contamination.
  - LLM inference now only fills missing slots; it does not override explicit user direction (`to/到/->`) or explicitly stated faces/mode/method.
- `tests/v2_chat_router.spec.ts`
  - Added assertion that explicit instruction keeps exact parse orientation: `part1(bottom) -> part2(top)`.

### Browser verification evidence
- Manual browser script (`?v=2&fixture=boxes`):
  - Input: `mate part1 bottom to part2 top`
  - Parsed reply: `part1(bottom) -> part2(top)`
  - Result transform: `part1` moved to `y=0.40000000298023225` (flush), matching Mate panel behavior.
- Automated tests:
  - `npx playwright test tests/v2_mate_translate_parity.spec.ts --reporter=line` → ✅ 1 passed
  - `npx playwright test tests/v2_chat_router.spec.ts --reporter=line` → ✅ 2 passed
  - `npm run build` → ✅ success

### Risk / follow-ups
- Natural language still allows implicit defaults for short commands (`mate part1 and part2`); this is intentional.
- If real LLM provider is enabled, slot-filling remains bounded by explicit-token protection rules added in this hotfix.

## S5g — Mate Perf + Chat Semantics + Rotate Hit-Path (2026-02-11)

### Scope
- Remove mate panel interaction stalls on source/target/face/method/mode changes.
- Make source/target preview markers smaller and less obstructive.
- Strengthen chat semantic parsing (Q&A + natural mate phrasing variants).
- Fix rotate-mode pointer conflict where background object steals interaction.

### Decisions / assumptions (non-interactive)
- Keep deterministic `mock` routing as baseline; add optional real LLM assist layer with env switch and hard fallback.
- Prefer partial zustand updates (no root-state spread) on high-frequency mate paths.
- In rotate mode, mesh click should not consume pointer unless `Shift+Click` is intentional reselect.
- Keep mate-preview recompute on idle/debounced schedule to protect main-thread interaction smoothness.

### What changed
- `src/v2/store/store.ts`
  - `setMateDraft` now supports one-call draft update + optional side pick clear.
  - Added state short-circuiting on frequent setters (`setSelection`, `setInteractionMode`, `setPickFaceMode`, `setTransformDragging`, `setMatePick`, `clearMatePick`, `clearMatePickFor`, `setMatePreview`).
  - Added preview equality checks to avoid redundant rerenders.
- `src/v2/ui/MatePanel/MatePanel.tsx`
  - Consolidated draft updates with pick-clear in single store call.
  - Removed source/target dropdown auto-selection side effect to avoid expensive highlight churn.
  - Added test ids for source/target method controls.
- `src/v2/three/mating/MatePreviewMarkers.tsx`
  - Switched preview recompute scheduling to debounce + `requestIdleCallback` fallback.
  - Removed repeated scene fallback lookups; use cached part-object map.
  - Reduced marker sphere radius from `0.009` to `0.005` and lowered opacity.
- `src/v2/three/ModelLoader.tsx`
  - Pointer handling updated: no unconditional stopPropagation, allowing gizmo to win in rotate mode.
- `mcp-server/v2/router/llmAssist.ts` (new)
  - Added optional Ollama/Gemini JSON helpers for mate inference and general Q&A (`ROUTER_LLM_ENABLE`, `ROUTER_LLM_PROVIDER`, `OLLAMA_*`, `GEMINI_*`).
  - Includes timeout, health-check cache, and strict fallback behavior.
- `mcp-server/v2/router/mockProvider.ts`
  - Improved part mention matching with token normalization.
  - Added optional LLM-assisted mate inference when user input omits faces/method/mode.
  - Relaxed model-info detection (no hard question-token requirement).
  - Added optional general-question LLM answer fallback.
- `README.md`
  - Documented mock+real provider switch and env setup.
- Tests:
  - Updated `tests/v2_chat_router.spec.ts` with broader model-QA phrasing and extra natural mate sentence.
  - Added `tests/v2_mate_ui_latency.spec.ts` for mate option responsiveness.

### Browser verification evidence
- Build:
  - `npm run build`
  - Result: ✅ success
  - Evidence: `/tmp/3d-app-logs/postfix-build.log`
- Playwright regression batch:
  - `npx playwright test tests/v2_chat_router.spec.ts tests/v2_markers_visibility.spec.ts tests/v2_mate_preview.spec.ts tests/v2_mate_methods.spec.ts tests/v2_mate_rotation.spec.ts tests/v2_mate_ui_latency.spec.ts --reporter=line`
  - Result: ✅ `7 passed (3.1s)`
  - Evidence: `/tmp/3d-app-logs/postfix-e2e.log`
- Smoke:
  - `npx playwright test tests/v2_smoke.spec.ts --reporter=line`
  - Result: ✅ `1 passed (1.0s)`
  - Evidence: `/tmp/3d-app-logs/postfix-smoke.log`
- Latency probe (fixture boxes):
  - Max latency: `187ms`, Avg latency: `98.71ms`
  - Evidence: `/tmp/3d-app-logs/mate-latency.json`

### Review packet (S5g)
- ✅ What changed: mate update path batching + preview idle scheduling + smaller markers + rotate pointer pass-through + chat semantic robustness + optional real LLM assist.
- ✅ Files touched:
  - `src/v2/store/store.ts`
  - `src/v2/ui/MatePanel/MatePanel.tsx`
  - `src/v2/three/mating/MatePreviewMarkers.tsx`
  - `src/v2/three/ModelLoader.tsx`
  - `mcp-server/v2/router/mockProvider.ts`
  - `mcp-server/v2/router/llmAssist.ts`
  - `README.md`
  - `tests/v2_chat_router.spec.ts`
  - `tests/v2_mate_ui_latency.spec.ts`
- ✅ How to test in browser:
  1) Open `http://127.0.0.1:5173/?v=2&fixture=boxes`
  2) Enter Mate tab and quickly toggle source/target/face/method/mode; ensure no long freeze/unresponsive.
  3) In Chat tab test `這個 usd 的 3d model`, `mate part1 and part2`, `請幫我把 part1 跟 part2 對齊`.
  4) Switch to rotate and drag gizmo around overlapping view; verify background click no longer steals interaction.
- ✅ Automated tests run:
  - `npm run build` ✅
  - `npx playwright test tests/v2_chat_router.spec.ts tests/v2_markers_visibility.spec.ts tests/v2_mate_preview.spec.ts tests/v2_mate_methods.spec.ts tests/v2_mate_rotation.spec.ts tests/v2_mate_ui_latency.spec.ts --reporter=line` ✅
  - `npx playwright test tests/v2_smoke.spec.ts --reporter=line` ✅
- ✅ Risk / follow-ups:
  - LLM assist is optional and network/model-dependent; mock fallback remains authoritative.
  - Real CAD large-mesh latency should be profiled again after S6 geometry API integration.

### Addendum — Real CAD import verification (2026-02-11)
- Model: `CAD/Spark.glb` imported via left panel (MCP `parts.set_cad_url`).
- Part count: `2`
- Mate panel latency probe (max/avg): `136ms` / `116.4ms`
- Evidence:
  - Playwright: `/tmp/3d-app-logs/real-cad-e2e.log`
  - Latency JSON: `/tmp/3d-app-logs/real-cad-mate-latency.json`

## S5 Hotfix Batch — User-blocking UX Issues (2026-02-11)

### Scope
- Fix mate panel option lag when switching source/target/face/method.
- Fix chat behavior: natural replies + natural-language control (not strict template-only).
- Hide Source/Target markers by default and reduce marker visual size.
- Prevent rotate workflow from accidentally reselecting background object on canvas click.

### Decisions / assumptions (non-interactive)
- In `rotate` mode, canvas click does not change selection by default; `Shift+Click` remains selection override.
- Source/Target preview markers only render in mate context (`workspaceSection === 'mate'` or `interaction.mode === 'mate'`).
- Chat router runs with `mock` provider by default, but tool execution now goes through real MCP tool proxy path.
- Natural mate sentence fallback uses defaults when faces are not specified: `source=bottom`, `target=top`.

### What changed
- `src/v2/three/mating/faceClustering.ts`
  - Added geometry-version keyed cache for planar clustering; removed heavy retained point arrays after tangent solve.
- `src/v2/three/mating/anchorMethods.ts`
  - Added geometry anchor cache for deterministic methods (`planar_cluster`, `geometry_aabb`, `extreme_vertices`, `obb_pca`, `auto` without picked).
- `src/v2/three/mating/MatePreviewMarkers.tsx`
  - Removed duplicate `resolveAnchor()` calls in same effect.
  - Added mate-context gating; markers no longer render outside mate context.
  - Reduced marker sphere and label size to improve viewport visibility.
- `src/v2/three/ModelLoader.tsx`
  - Added rotate selection lock (`Shift+Click` override).
- `mcp-server/v2/router/types.ts`
  - Added `RouterRoute` response type (`toolCalls`, `replyText`).
- `mcp-server/v2/router/router.ts`
  - Router now returns routed tool calls + reply text only; execution moved to gateway.
- `mcp-server/v2/router/mockProvider.ts`
  - Replaced strict parser with broader natural-language intent mapping (greeting, grid on/off, environment, mode, undo/redo, reset, select).
  - Tool names migrated to MCP tool names (e.g., `view.set_grid_visible`, `selection.set`).
- `mcp-server/v2/wsGateway.ts`
  - `router_execute` now executes routed MCP tool calls through `tool_proxy_invoke` pipeline.
  - Response now includes `replyText` in addition to `trace` and `results`.
- `src/v2/ui/Chat/ChatPanel.tsx`
  - Improved fallback reply when router reply is missing.
- `src/v2/ui/CommandBar/useCommandRunner.ts`
  - Added mate-like natural sentence fallback (`對齊/align/貼到/組裝`) with default face inference.

### Browser verification evidence
- Build:
  - `npm run build`
  - Result: ✅ success
  - Evidence: `/tmp/mcp_fix_build.log`
- Playwright batch:
  - `npx playwright test tests/v2_chat_router.spec.ts tests/v2_markers_visibility.spec.ts tests/v2_command_bar.spec.ts --reporter=line`
  - Result: ✅ `3 passed (2.1s)`
  - Evidence: `/tmp/mcp_fix_playwright.log`
- Smoke regression:
  - `npx playwright test tests/v2_smoke.spec.ts --reporter=line`
  - Result: ✅ `1 passed (1.1s)`
  - Evidence: `/tmp/mcp_fix_playwright_smoke.log`

### Known follow-ups
- Rotate selection lock is covered by behavior change and manual verification path; add deterministic E2E for real CAD scene selection/raycast in S6.
- Chat mate intent in router still defaults to lightweight guidance path; full multi-step mate orchestration stays under S7 (stronger planner + plan/preview/commit chaining).

## S5e/S5f — Mate UX responsiveness + Chat Natural-Language Execution (2026-02-11)

### Scope
- Reduce mate overlay obstruction (`Source/Target` marker too large).
- Reduce mate panel perceived freeze when changing source/target/face/method/mode.
- Upgrade AI chat from template-only behavior to mixed Q&A + direct execution.
- Support natural mate input:
  - `mate part1 and part2`
  - `mate part1 bottom and part2 top use object aabb method`

### Decisions / assumptions (non-interactive)
- Default router remains `mock` provider (deterministic, no external key dependency).
- `auto` anchor method prioritizes responsiveness: `picked -> geometry_aabb -> planar_cluster`.
- Chat panel always routes natural text to `router_execute`; local command parser is bypassed in chat mode (except `/help`).
- Added high-level MCP tool `action.mate_execute` to keep router call single-step and robust.

### What changed
- `src/v2/three/mating/MatePreviewMarkers.tsx`
  - Removed `Source/Target` HTML labels (no viewport-blocking text overlays).
  - Reduced marker sphere radius (`0.009`) and kept non-interactive raycast.
  - Added object lookup cache and preview recompute debounce (`48ms`) to reduce UI stalls.
- `src/v2/three/mating/anchorMethods.ts`
  - Changed `auto` resolution path to geometry-first for lower latency.
  - Updated option label to reflect new behavior.
- `shared/schema/mcpToolsV3.ts`
  - Added `query.model_info`.
  - Added `action.mate_execute` (plan + preview + optional commit abstraction).
- `src/v2/network/mcpToolExecutor.ts`
  - Implemented `query.model_info` with model summary and scene bbox aggregation.
  - Implemented `action.mate_execute` orchestration (`generate_transform_plan -> preview.transform_plan -> commit_preview`).
  - Updated auto face-info metadata to `geometry_aabb`.
- `mcp-server/v2/router/types.ts`
  - Extended router context (cad file name, step/selection/mode, part position/size).
- `mcp-server/v2/router/mockProvider.ts`
  - Added operational Q&A replies (`how to add step`, capability help, model info).
  - Added natural mate parsing with source/target inference + face/method extraction.
  - Routes mate intent to `action.mate_execute`.
- `src/v2/ui/Chat/ChatPanel.tsx`
  - Enriched router context payload with model/step/selection/part geometry metadata.
  - Chat no longer short-circuits through local command parser (natural phrasing handled by router).
- Tests:
  - Updated `tests/v2_chat_router.spec.ts` with Q&A + natural mate coverage.
  - Updated `tests/v2_markers_visibility.spec.ts` to assert no `Source/Target` labels even in mate workspace.
  - Updated mate preview tests (`tests/v2_mate_preview.spec.ts`, `tests/v2_mate_methods.spec.ts`) to enter mate workspace before expecting preview.

### Browser verification evidence
- Build:
  - `npm run build`
  - Result: ✅ success
  - Evidence: `/tmp/v2_patch_build.log`
- Chat + marker suite:
  - `npx playwright test tests/v2_chat_router.spec.ts tests/v2_markers_visibility.spec.ts --reporter=line`
  - Result: ✅ `3 passed (2.1s)`
  - Evidence: `/tmp/v2_patch_chat_markers.log`
- Mate regression suite:
  - `npx playwright test tests/v2_mate_preview.spec.ts tests/v2_mate_methods.spec.ts tests/v2_mate_rotation.spec.ts --reporter=line`
  - Result: ✅ `3 passed (1.3s)`
  - Evidence: `/tmp/v2_patch_mate_regression.log`

### Review packet (S5e/S5f)
- ✅ What changed: markers downsized/no label, mate preview debounce + faster auto anchor, new MCP tools (`query.model_info`, `action.mate_execute`), router/chat NL upgrade.
- ✅ Files touched:
  - `src/v2/three/mating/MatePreviewMarkers.tsx`
  - `src/v2/three/mating/anchorMethods.ts`
  - `shared/schema/mcpToolsV3.ts`
  - `src/v2/network/mcpToolExecutor.ts`
  - `mcp-server/v2/router/types.ts`
  - `mcp-server/v2/router/mockProvider.ts`
  - `src/v2/ui/Chat/ChatPanel.tsx`
  - `tests/v2_chat_router.spec.ts`
  - `tests/v2_markers_visibility.spec.ts`
  - `tests/v2_mate_preview.spec.ts`
  - `tests/v2_mate_methods.spec.ts`
- ✅ How to test in browser:
  1) Open `http://127.0.0.1:5173/?v=2&fixture=boxes`
  2) In chat tab: ask `我要如何新增step`, then `這個 usd model 是什麼`
  3) Send `mate part1 and part2` and `mate part1 bottom and part2 top use object aabb method`
  4) Enter mate workspace and verify no large `Source/Target` text overlays block view
- ✅ Automated tests run:
  - `npm run build` ✅
  - `npx playwright test tests/v2_chat_router.spec.ts tests/v2_markers_visibility.spec.ts --reporter=line` ✅
  - `npx playwright test tests/v2_mate_preview.spec.ts tests/v2_mate_methods.spec.ts tests/v2_mate_rotation.spec.ts --reporter=line` ✅
- ✅ Risk / follow-ups:
  - Router is deterministic (mock) by design; for richer free-form dialog quality, add optional real LLM provider (env-switched) in S6/S7.
  - `action.mate_execute` currently targets face-based mate flow; extend to edge/axis/point variants in S7.

## MCP-only Migration Plan — Kickoff (2026-02-11)

### Non-interactive decision policy
- User will be away ~8 hours: do not ask questions. Use reasonable defaults and log decisions here.
- Browser verification is done via Playwright (headless Chromium) unless otherwise stated.

### Scope
- Target: v2 app (`src/v2/*`) + v2 MCP gateway (`mcp-server/v2/*`) + shared schemas (`shared/schema/*`).
- Definition: "All functionality is MCP-controlled" means UI must not directly mutate core scene/state; it must call MCP tools, and tool execution becomes the single control surface.

### Plan (Quality-First, Subtasked, Browser-Verified)

#### S1 — Baseline boot + evidence log
- DoD: Frontend + MCP gateway start successfully; baseline Playwright passes; evidence paths recorded.
- Files: `docs/DEVLOG.md`
- Approach: start two long-running servers; run 2 baseline tests to establish green state.
- Risks: port conflicts; server exits; Playwright flakes.
- Rollback: restart processes; revert the single commit for S1.
- Browser verification: Playwright baseline + log files.
- Review checkpoint: `docs/DEVLOG.md` has reproducible commands + evidence.

#### S2 — Inventory gaps and map tools
- DoD: gap matrix mapping every direct state/scene mutation to MCP tools + verification steps (per feature).
- Files: `docs/DEVLOG.md`
- Approach: `rg`/audit `useV2Store().set*`, direct Three mutations, StepRunner, MateExecutor, panels; map to tool categories.
- Risks: missing edge paths; partial MCP-ification.
- Rollback: doc-only changes.
- Browser verification: rerun baseline tests to ensure no regressions.
- Review checkpoint: gap matrix is complete, actionable, and test-linked.

#### S3 — Expand MCP tool schemas (minimal but complete)
- DoD: all required tools exist in `shared/schema/mcpToolsV3.ts` with zod schemas + stable envelopes/errors/debug.
- Files: `shared/schema/mcpToolsV3.ts`, `docs/MCP_LLM_OPERATOR_GUIDE.md` (sync)
- Approach: version toolset; enforce consistent `ok/error/warnings/debug`; add missing namespaces (`view.*`, `parts.*`, `steps.*`, `vlm.*`, `interaction.*`).
- Risks: client/server mismatch; schema churn.
- Rollback: revert schema additions; keep old tools working.
- Browser verification: start servers; run an MCP smoke (tool call path) + baseline tests.
- Review checkpoint: schemas are concrete enough for TS interfaces and LLM tool calling.

#### S4 — MCP-ify non-3D UI actions
- DoD: view/env/grid/anchors, parts load/select, steps CRUD/playback, VLM image ops are MCP-driven (no direct store writes from panels).
- Files: `src/v2/ui/**`, `src/v2/network/mcpToolExecutor.ts`, `src/v2/network/mcpToolsClient.ts`
- Approach: replace UI mutators with `callMcpTool()`; executor becomes the only mutator; add tool result-driven UI sync.
- Risks: async UI latency; missed corner flows.
- Rollback: revert per-panel conversions; keep tools behind feature flags if needed.
- Browser verification: Playwright panel interaction tests + manual sanity.
- Review checkpoint: `rg` shows removed direct store writes in target panels.

#### S5 — MCP-ify 3D interactions (selection/face pick/gizmo drag)
- DoD: mesh click selection, face picking, move/rotate drags go through MCP tools (`interaction.*`, `selection.*`, `preview.*`, `action.commit_preview`).
- Files: `src/v2/three/ModelLoader.tsx`, `src/v2/three/interaction/TransformGizmo.tsx`, `src/v2/network/mcpToolExecutor.ts`
- Approach: pointer events -> tool calls; executor produces preview transforms; commit/cancel handled via tools.
- Risks: performance under drag; event ordering; orbit conflicts.
- Rollback: keep legacy interaction fallback behind `?legacy` or a dev flag (temporary).
- Browser verification: Playwright (selection + drag) + screenshots.
- Review checkpoint: no direct scene mutation from interaction components.

#### S6 — SceneToolApi (real geometry access)
- DoD: tools can query real geometry (raycast hit, face normal/frame, bbox) in a controlled way.
- Files: `src/v2/three/SceneToolApi.ts` (new), `src/v2/network/mcpToolExecutor.ts`
- Approach: register read-only API from R3F `useThree()`; provide mesh lookup + geometry computations.
- Risks: scene not ready; ref lifetimes; perf.
- Rollback: fallback to approximate calculations (explicitly marked in debug).
- Browser verification: tool-call driven face query tests.
- Review checkpoint: `query.face_info` returns consistent frame data + debug.

#### S7 — Strengthen `action.generate_transform_plan` (mate/twist/both)
- DoD: solver uses real face frames; twist supports arbitrary angles & axis modes; both generates continuous arc path; plan is previewable/committable and debuggable.
- Files: `src/v2/three/mating/**`, `src/v2/network/mcpToolExecutor.ts`, `shared/schema/mcpToolsV3.ts`
- Approach: frame construction + quaternion solve; twist axis constraints; path generation (arc + slerp); rich debug.
- Risks: numeric stability; wrong normal orientation; solver edge cases.
- Rollback: keep old plan generator behind tool option `solverVersion='legacy'` (temporary).
- Browser verification: Playwright flows `preview -> commit -> undo` + screenshots/logs.
- Review checkpoint: plan includes axes/angles/frames/path samples; stable in edge cases.

#### S8 — Rewrite E2E tests to be MCP-only
- DoD: tests no longer use `window.__V2_STORE__` direct mutation; they interact via UI or MCP tool calls; at least 8 edge-case cases added.
- Files: `tests/*.spec.ts`, `tests/helpers/mcp.ts` (new)
- Approach: use `mcp_tool_call` WS path or UI actions; gather screenshots/console logs for evidence.
- Risks: slower tests; flakiness under drag/3D.
- Rollback: keep store-driven tests temporarily but mark as deprecated; MCP-only suite becomes gating.
- Browser verification: run MCP-only suite and keep report.
- Review checkpoint: tests match acceptance criteria and are debuggable.

#### S9 — Docs + resume instructions + mock/real provider notes
- DoD: README + LLM operator guide match reality; mock provider default; resume steps accurate.
- Files: `README.md`, `docs/MCP_LLM_OPERATOR_GUIDE.md`, `docs/MCP_CONTROL_ARCHITECTURE.md`, `docs/DEVLOG.md`
- Approach: treat tests as source-of-truth; update docs after each subtask.
- Risks: docs drift.
- Rollback: doc-only.
- Browser verification: final smoke + e2e.
- Review checkpoint: newcomer can run project + MCP-only flows.

### S1 — Test evidence (2026-02-11)
- Servers:
  - Frontend: `npm run dev -- --host 127.0.0.1 --port 5173`
  - MCP v2 gateway: `npx tsx mcp-server/v2/index.ts` (listening on `3011`)
- Playwright baseline:
  - `npx playwright test tests/v2_smoke.spec.ts tests/v2_command_bar.spec.ts --reporter=line`
  - Result: ✅ `2 passed` (38.7s)
- Evidence logs:
  - `/tmp/mcp_migration_vite_s1.log`
  - `/tmp/mcp_migration_server_s1.log`
  - `/tmp/mcp_migration_playwright_s1.log`

### Known limitations (tracked for S8)
- Current baseline tests still use `window.__V2_STORE__` direct state injection for speed/stability. This is explicitly against the MCP-only goal and will be removed in S8.

### S2 — MCP coverage gap matrix (2026-02-11)

Legend:
- Status: `DONE` (already MCP-controlled), `PARTIAL` (some direct store/scene writes remain), `MISSING` (no tool exists yet)
- "Current path" is where UI/3D code directly mutates state/scene today (violates MCP-only rule).

| Area | Feature | Current path (direct) | Target MCP tool(s) | Status | Verification |
| --- | --- | --- | --- | --- | --- |
| Top bar | Undo/Redo buttons | `src/v2/app/AppShell.tsx` calls `useV2Store().undo/redo` | `history.undo`, `history.redo` | PARTIAL | Update/replace `tests/v2_smoke.spec.ts` & add MCP-only test (S8) |
| View | Environment dropdown | `src/v2/ui/View/ViewPanel.tsx` calls `setEnvironment` | `view.set_environment` | MISSING | `tests/v2_command_bar.spec.ts` (later MCP-only) |
| View | Grid toggle | `src/v2/ui/View/ViewPanel.tsx` calls `setGridVisible` | `view.set_grid_visible` | MISSING | `tests/v2_command_bar.spec.ts` (later MCP-only) |
| View | Anchor markers toggle | `src/v2/ui/View/ViewPanel.tsx` calls `setAnchorsVisible` | `view.set_anchors_visible` | MISSING | Add small Playwright check for markers visibility (S8) |
| Model | Import CAD file | `src/v2/ui/PartsPanel/ModelPanel.tsx` calls `setCadUrl` | `parts.set_cad_url` (or `parts.load_model`) | MISSING | Add Playwright: upload -> parts appear (S8) |
| Parts | Select from list | `src/v2/ui/PartsPanel/PartsList.tsx` calls `setSelection` | `selection.set` | PARTIAL | Add MCP-only test: click part -> selection tool sets (S8) |
| Canvas | Click select mesh | `src/v2/three/ModelLoader.tsx` calls `setSelection` | `interaction.pick` (preferred) or `selection.set` (by partId) | PARTIAL | Add Playwright: click canvas selects (S8) |
| Canvas | Face pick (mate) | `src/v2/three/ModelLoader.tsx` calls `setMatePick` + `setPickMode` | `interaction.pick_face` / `mate.pick_face_commit` | MISSING | Add Playwright: enable pick -> click face -> tool returns frame (S6/S8) |
| Selection | Position/rotation scrub | `src/v2/ui/Selection/SelectionPanel.tsx` calls `setPartOverride` | `action.set_part_transform` (absolute) or `action.translate`/`action.rotate` | MISSING | Add Playwright: scrub X changes transform (S8) |
| Selection | Reset part/all | `src/v2/ui/Selection/SelectionPanel.tsx` calls `clearPartOverride/clearAllPartOverrides` | `action.reset_part`, `action.reset_all` | MISSING | Add Playwright: reset restores initial (S8) |
| Gizmo | Translate/rotate drag | `src/v2/three/interaction/TransformGizmo.tsx` writes overrides | `interaction.gizmo_drag_begin/update/end` + `action.commit_preview` | MISSING | Add Playwright: drag -> preview -> commit (S5/S8) |
| CommandBar | `env` / `grid` | `src/v2/ui/CommandBar/useCommandRunner.ts` calls `setEnvironment/setGridVisible` | `view.set_environment`, `view.set_grid_visible` | PARTIAL | Extend command tests (S8) |
| CommandBar | `reset` | `src/v2/ui/CommandBar/useCommandRunner.ts` calls `clearAllPartOverrides/clearPartOverride` | `action.reset_all`, `action.reset_part` | PARTIAL | Add MCP-only command test (S8) |
| Mate | Draft state | `src/v2/ui/MatePanel/MatePanel.tsx` calls `setMateDraft` in store | Move to local component state OR add `ui.set_mate_draft` | PARTIAL | Keep stable UI while switching execution (S4/S5) |
| Mate | Apply mate | `src/v2/ui/MatePanel/MatePanel.tsx` calls `requestMate` | `action.generate_transform_plan` -> `preview.transform_plan` -> `action.commit_preview` | PARTIAL | Add E2E: mate preview/commit/undo (S7/S8) |
| Mate | Solver executor | `src/v2/three/mating/MateExecutor.tsx` applies transform + sets markers | Replace with tool-driven preview renderer; markers via `preview.*` | PARTIAL | Verify mate no longer requires store request (S7) |
| Steps | Add/select/delete/update | `src/v2/ui/Steps/StepsPanel.tsx` calls store actions | `steps.add`, `steps.select`, `steps.delete`, `steps.update_snapshot` | MISSING | Add Playwright CRUD test (S8) |
| Timeline | Reorder steps | `src/v2/ui/Steps/TimelineBar.tsx` calls `moveStep` | `steps.move` | MISSING | `tests/v2_timeline_reorder.spec.ts` (rewrite MCP-only in S8) |
| Timeline | Run/Stop playback | `src/v2/ui/Steps/TimelineBar.tsx` calls `startPlayback/stopPlayback` | `steps.playback_start`, `steps.playback_stop` | MISSING | `tests/v2_timeline_run.spec.ts` (rewrite MCP-only in S8) |
| Playback | StepRunner overrides | `src/v2/three/animation/StepRunner.tsx` writes silent overrides | OK (internal), but entry points must be MCP tools | PARTIAL | Ensure UI start/stop is tool-driven (S4) |
| VLM | Upload/reorder/delete images | `src/v2/ui/VLM/VlmPanel.tsx` uses store actions | `vlm.add_images`, `vlm.move_image`, `vlm.remove_image` | MISSING | `tests/v2_smoke.spec.ts` (rewrite MCP-only in S8) |
| VLM | Analyze | `src/v2/ui/VLM/VlmPanel.tsx` calls `v2Client.request('vlm_analyze')` | `vlm.analyze` (tool wraps `vlm_analyze`) | MISSING | Add MCP-only VLM test (S8) |
| Chat | Send to router | `src/v2/ui/Chat/ChatPanel.tsx` calls `router_execute` directly | OK (already server-controlled); optional `chat.send` tool later | DONE | `tests/v2_chat.spec.ts` (rewrite MCP-only later if needed) |

Top-priority tool gaps to implement in S3 (unblocks S4/S5 quickly):
- `view.set_environment`, `view.set_grid_visible`, `view.set_anchors_visible`
- `parts.set_cad_url`
- `action.set_part_transform`, `action.reset_part`, `action.reset_all`
- `steps.*` CRUD + playback tools
- `vlm.*` image ops + `vlm.analyze`
- `interaction.pick`, `interaction.pick_face`, `interaction.gizmo_drag_*`

S2 test evidence (2026-02-11):
- Playwright baseline: `npx playwright test tests/v2_smoke.spec.ts tests/v2_command_bar.spec.ts --reporter=line`
  - Result: ✅ `2 passed` (38.5s)
  - Evidence log: `/tmp/mcp_migration_playwright_s2.log`

S3 test evidence (2026-02-11):
- Build: `npm run build`
  - Result: ✅ success
  - Evidence log: `/tmp/mcp_migration_build_s3.log`
- Playwright baseline: `npx playwright test tests/v2_smoke.spec.ts tests/v2_command_bar.spec.ts --reporter=line`
  - Result: ✅ `2 passed` (40.8s)
  - Evidence log: `/tmp/mcp_migration_playwright_s3.log`

S4 test evidence (2026-02-11):
- Build: `npm run build`
  - Result: ✅ success
  - Evidence log: `/tmp/mcp_migration_build_s4.log`
- Playwright: `npx playwright test tests/v2_command_bar.spec.ts tests/v2_scrub_numbers.spec.ts tests/v2_smoke.spec.ts --reporter=line`
  - Result: ✅ `3 passed` (1.3s)
  - Evidence log: `/tmp/mcp_migration_playwright_s4e.log`
- Note: fixed Node runtime bug (`crypto` global missing) by using `randomUUID` from `node:crypto` in `mcp-server/v2/*`.
- Note: removed default dependency on local `public/test_model.glb` (826MB, untracked) by falling back to `fixture=boxes` when `cadUrl` is empty.

## Archived Context (pre MCP-only migration)

## Feedback — 2026-01-31 (review notes)
### Reported issues (v2)
- Mate UI 只有 `top/bottom`，缺少其他方向（left/right/front/back）。
- Mate 結果仍不夠準（gap/偏移），希望加入 B 方案（pick face）或其他優化。
- Mate/操作後物件無法回到原來位置（缺少可靠 reset / 初始 transform 記錄）。
- 希望 mate 後可微調（gizmo + nudge）。
- 背景希望更好看：Environment 下拉選單 + Grid（且預設有 grid）。
- 需要打字控制功能（微調/對齊/重置/視覺設定）；完整 AI chat 可等功能穩定後再加。

### Repro steps (current)
1) 開 `http://localhost:5173`（v2 default）
2) 於右側 Mate panel 嘗試選 face：只看到 top/bottom
3) Apply mate 後：物件移動但缺少「回到原位」按鈕/流程
4) 嘗試拖曳/微調：缺少 nudge UI；gizmo 操作後狀態無法可靠回放
5) View：無 environment 下拉、無 grid toggle（或 grid 不顯著）

### Desired DoD (for follow-up)
- Mate 支援 6 向 + pick face（更準）
- Reset part/all 可回到初始；mate 前狀態可一鍵回復（或 undo）
- Mate 後可以 gizmo + nudge 微調（可 undo/redo）
- View：環境下拉 + grid（預設開）
- Command console：可打字執行 mate/nudge/reset/env/grid

## Update — 2026-01-31 (panel scroll + real backdrops)
### What changed
- 右側 panel height chain 修正：`100dvh` + `overflow-hidden` + `min-h-0`，確保小螢幕可滾到底。
- Mate Apply 改為 sticky action（底部固定），小螢幕不用一直捲到底。
- City/Warehouse 環境加入真實 3D backdrop（instanced buildings / warehouse shell + beams），避免只是顏色。
- Grid 參數強化（提升可見度），環境 blur 降低讓背景更清楚。
- 新增 responsive 回歸測試：小 viewport 下右側 panel 可達底部與 Apply 可見。

### Test evidence
- Playwright: `npx playwright test tests/v2_smoke.spec.ts tests/v2_responsive_panel.spec.ts --reporter=line` ✅ (2 passed)

### Known limitations
- Backdrop 為輕量幾何 + HDRI；若之後要更真實，建議替換成低面數 glTF 場景或 HDRI library 管理。

## Update — 2026-01-31 (mate footer + orbit drag + chat + photo backgrounds + rotation)
### What changed
- 右側 panel 改為 Footer 行動列（Apply 永遠可見），不再被內容擠到看不到。
- TransformControls 在 mouseDown 即停用 Orbit，並新增 pointerup/blur 兜底，避免相機拖動與卡死。
- CommandBar 支援 Enter 送出 + `/help` 範例提示；新增 AI Chat 面板（mock 回覆+可驅動本地指令）。
- 城市/倉庫背景改為真實照片全景（image-based background），不會遮擋模型互動。
- Mate rotation 加入 tangent 對齊，減少歪斜與隨機扭轉。
- Playwright 新增 command/chat 測試；controls_drag 改為 v2 store 驗證。

### Test evidence
- Playwright: `npx playwright test tests/v2_smoke.spec.ts tests/v2_responsive_panel.spec.ts tests/v2_command_bar.spec.ts tests/v2_chat.spec.ts tests/controls_drag.spec.ts --reporter=line` ✅ (5 passed)

### Asset sources / license
- Poly Haven (CC0) HDRI tonemapped JPGs:
  - `zawiszy_czarnego` (city)
  - `workshop` (warehouse)
  - 下載後縮放至 2048px 寬，存於 `public/v2/backgrounds/`.

## Update — 2026-01-31 (responsive accordion + rotation info + mate tangent + new warehouse bg)
### What changed
- 右側 Workspace 在小高度自動切換成 accordion（全部區塊標題可見、內容只展開一個），避免選取時擠到看不到。
- Selection 面板新增 rotation 顯示（Euler deg + quaternion），可直接看旋轉資訊。
- Mate rotation 引入 face PCA tangent 與 pick-face tangent，減少歪斜與扭轉。
- Warehouse 背景更換為更像倉儲的 `workshop` 圖像背景（不擋物件）。

### Test evidence
- Playwright: `npx playwright test tests/v2_smoke.spec.ts tests/v2_responsive_panel.spec.ts tests/v2_command_bar.spec.ts tests/v2_chat.spec.ts tests/controls_drag.spec.ts tests/v2_selection_rotation.spec.ts --reporter=line` ✅ (6 passed)

## Update — 2026-02-02 (mate modes + tabs + AI backgrounds + scrub numbers)
### What changed
- Mate 新增三種模式（Translate / Twist / Both），指令支援 `--mode`，預設只平移避免亂旋轉。
- Workspace 改為 Tabs，避免小螢幕只看得到 Target / Apply 被擠掉。
- 背景改為「預先生成的 AI 圖像」並預載，切換 env 不再卡頓/閃 city。
- Selection 的 Position / Rotation 數字支援滑鼠左右拖拉（每步 ±0.01）。
- 新增 `fixture=boxes` 測試場景與 mate/scrub 回歸測試。

### Test evidence
- Playwright: `npx playwright test tests/v2_mate_rotation.spec.ts tests/v2_scrub_numbers.spec.ts tests/v2_responsive_panel.spec.ts tests/v2_chat.spec.ts tests/controls_drag.spec.ts --reporter=line` ✅ (5 passed)

### Notes
- 背景素材由 `bin/generate_ai_backgrounds.py` 生成，輸出到 `public/v2/backgrounds_ai/`（非 runtime 生成）。

## Update — 2026-02-02 (face preview + mate trace + twistSpec)
### What changed
- Mate 下拉選 face 時即時顯示 source/target 面中心點（兩個點）作為預覽。
- 新增 Mate Trace：顯示 pivot / rotation / translation / before-after，解釋為何 twist 後物件原點位置變動。
- Solver 支援 `twistSpec`（axis/angle/space），讓 VLM 旋轉軸/角度可直接輸入。

### Test evidence
- Playwright: `npx playwright test tests/v2_mate_preview.spec.ts tests/v2_mate_trace.spec.ts --reporter=line` ✅ (2 passed)

## Update — 2026-02-02 (mate UI fixes + steps delete + selection priority + chat persist)
### What changed
- Mate Trace 不再佔用面板空間，避免擠掉 Apply；Apply 永遠可用。
- Face preview：下拉變更立即更新，Apply 後清空舊點避免殘留。
- Steps 支援刪除，並在刪除 current 時自動選到前一個（或空）。
- Dropdown 選擇為主：canvas/list 選取不再覆寫 dropdown；command 仍可覆寫。
- AI Chat 訊息改為 store 保存，切換 tabs 後仍保留對話。

### Test evidence
- Playwright: `npx playwright test tests/v2_smoke.spec.ts tests/v2_responsive_panel.spec.ts tests/v2_command_bar.spec.ts tests/v2_chat.spec.ts tests/v2_chat_persist.spec.ts tests/controls_drag.spec.ts tests/v2_selection_rotation.spec.ts tests/v2_mate_rotation.spec.ts tests/v2_scrub_numbers.spec.ts tests/v2_mate_preview.spec.ts tests/v2_mate_trace.spec.ts tests/v2_steps_delete.spec.ts tests/v2_selection_priority.spec.ts --reporter=line` ✅ (13 passed)

## Update — 2026-02-02 (mate methods + timeline reorder/run)
### What changed
- Mate source/target 各自可選算法（auto/planar/AABB/extreme/PCA/picked），Apply 會依各自方法計算 anchor。
- Face preview 依選定算法即時更新；Pick face 仍可用於 `auto/picked`。
- Timeline step 改為可拖曳排序的 buttons，新增 Run/Stop，依序平滑播放到每一步狀態（非瞬移）。
- Step 新增 snapshot（記錄當下 overrides），Run 會從初始狀態逐步播放。
- Mate 方法顯示「Resolved」提示，當 fallback 發生時會顯示 fallback。

### Test evidence
- Build: `npm run build` ✅
- Playwright: `npx playwright test tests/v2_mate_methods.spec.ts --reporter=line` ✅ (1 passed)

## Update — 2026-01-30 (post-v2 fixes)
### What changed
- v2 store 的 `setSelection` 改成不走 history（避免選取時複製大量 parts 造成卡頓）。
- v2 mating solver 加入 AABB fallback（當 face clustering 失敗仍可對齊並產生 anchor）。
- `shared/schema` 依賴補上 `zod`，`tsconfig` 排除 legacy 無用檔案避免 build 被阻斷。
- v2 smoke test 以 store 注入來避免 Playwright 在大型 UI 元件上卡住。

### Test evidence
- Build: `npm run build` ✅
- Playwright: `npx playwright test tests/v2_smoke.spec.ts --reporter=line` ✅ (1 passed)

### Known limitations
- 大型模型的 parts list 仍會讓 UI action 偏慢，故 smoke test 目前用 store 注入；如要強化 UI 點選穩定度，建議導入列表虛擬化或分頁。

---

## Update — 2026-01-31 (precision mate + reset + view + console)
### What changed
- v2 parts transforms 成為 store 真相（initial + overrides），新增同步器確保 reset/undo 回得去。
- Mate 支援 6 向（top/bottom/left/right/front/back），且加入 pick-face 精準模式。
- Mate/拖曳後可微調（gizmo + nudge），並提供 Reset Part / Reset All。
- View 面板新增 Environment 下拉 + Grid 開關（預設開啟）。
- Command console 支援 `mate / nudge / reset / env / grid / select`（非 LLM）。

### Test evidence
- Playwright: `npx playwright test tests/v2_smoke.spec.ts --reporter=line` ✅ (1 passed)

### Known limitations
- v2 smoke 以 store 注入避免大型 UI DOM/幾何計算造成 flake；Command console 與 pick-face 建議手動驗證。

## HOW_TO_RESUME
1) 啟動前後端（兩個 terminal）：
   - `npm run dev -- --port 5173`
   - `npx tsx mcp-server/v2/index.ts`
2) 開瀏覽器到 `http://localhost:5173`（v2 default；`?legacy=1` 進 v1）
3) v2 E2E：
   - `npx playwright test tests/v2_smoke.spec.ts`
   - `npx playwright test tests/v2_responsive_panel.spec.ts`
   - `npx playwright test tests/v2_command_bar.spec.ts`
   - `npx playwright test tests/v2_chat.spec.ts`
   - `npx playwright test tests/v2_chat_persist.spec.ts`
   - `npx playwright test tests/controls_drag.spec.ts`
   - `npx playwright test tests/v2_selection_rotation.spec.ts`
   - `npx playwright test tests/v2_mate_rotation.spec.ts`
   - `npx playwright test tests/v2_scrub_numbers.spec.ts`
   - `npx playwright test tests/v2_mate_preview.spec.ts`
   - `npx playwright test tests/v2_mate_trace.spec.ts`
   - `npx playwright test tests/v2_steps_delete.spec.ts`
   - `npx playwright test tests/v2_selection_priority.spec.ts`
   - `npx playwright test tests/v2_mate_methods.spec.ts`
   - `npx playwright test tests/v2_timeline_reorder.spec.ts`
   - `npx playwright test tests/v2_timeline_run.spec.ts`

## Decisions / Assumptions
- 以 1366×768 作為最小可用視窗，右側 panel 必須可完整操作或可滾動到最底部。
- 目前環境的 shell sandbox 無法寫入專案目錄（Vite 需要寫入 `.timestamp-*.mjs`），因此在「實際啟動 server / 跑 Playwright」時會需要提升權限或改用允許寫入的執行方式。
- TransformControls 與 OrbitControls 的衝突根因：`Scene.tsx` 的 `Controls` 每一幀把 `OrbitControls.enabled` 設回 `!isAnimationPlaying`，覆寫了 marker 拖曳時暫停 Orbit 的邏輯；因此需要「單一狀態來源」統一決定 enabled。
- Mate 預設模式為 `translate`（只平移），避免命令型 mate 造成意外旋轉；需要時再切 `twist/both`。
- 背景為預先生成的靜態圖像（非 runtime 生成、非真實照片），切換只在本地快取中切換材質。

---

## S1 — Fix TransformControls drag vs OrbitControls
### Goal
- 拖曳 Start/End marker 的 gizmo 時，相機不會跟著 Orbit 旋轉；放開後 Orbit 恢復；拖到畫布外放開不會卡死。

### Implementation notes
- 新增全域狀態 `isTransformDragging` 與 `transformDraggingById`（Zustand）作為唯一真實來源。
- `OrbitControls.enabled` 改由 `!isAnimationPlaying && !isTransformDragging` 決定，避免互相覆寫。
- TransformControls `dragging-changed` 事件只更新 store；並用 `window.pointerup/pointercancel/blur` 做兜底清除，避免卡死。

### Test evidence
- Browser (Playwright / Chromium, headless)：以 store 直接切換 `setTransformDragging('start', true/false)` 驗證 `OrbitControls.enabled` 會同步切換（避免被其他邏輯覆寫）。
  - JSON 輸出：`{"orbitEnabled":{"before":true,"during":false,"after":true},"pageErrors":[]}`
  - Screenshot：`test-results/S1-orbit-enabled-2.png`
  - 服務 log：`/tmp/vite_s1b.log`, `/tmp/mcp_s1b.log`

### Known limitations
- 此證據驗證的是「拖曳狀態 → Orbit enabled」的連動與覆寫問題已排除；尚未在自動測試中用滑鼠實際拖拽 gizmo（S2 會補一個更貼近行為的回歸測試策略）。

---

## S2 — Regression Playwright test (drag behavior)
### Goal
- 提供穩定回歸測試：確保「拖曳狀態」期間 `OrbitControls.enabled=false`，避免未來 UI/controls 改動導致相機又跟著跑。

### Test evidence
- `npx playwright test tests/controls_drag.spec.ts --reporter=line`
  - Result: 1 passed
  - Screenshot: `test-results/S2-controls-drag.png`
  - 服務 log：`/tmp/vite_s2.log`, `/tmp/mcp_s2.log`

---

## S3 — UI layout refactor (panels)
### Goal
- 重新整理 sidebar 資訊架構（不改核心功能），讓後續 Parts/VLM/Status 能放進明確區塊。

### What changed
- Left sidebar 改為 `Model & Parts`，以可折疊 `PanelSection` 分區。
- Right sidebar 改為 `Workspace`，分為 `Selection`、`Markers & Animation`、`AI Assistant` 三區塊。
- Sidebar 寬度與 border class 修正（Tailwind 可靜態分析），讓 UI 更一致。

### Test evidence
- Browser screenshot: `test-results/S3-ui-layout.png`
- 服務 log：`/tmp/vite_s3.log`, `/tmp/mcp_s3.log`

---

## S4 — Parts list (search/sort/select)
### Goal
- 提供可搜尋、可排序、可點選的 parts list，並清楚顯示 selected 狀態。

### Test evidence
- Browser screenshot: `test-results/S4-parts-list.png`
- Playwright: `npx playwright test tests/parts_list.spec.ts --reporter=line`
  - Result: 1 passed
  - 服務 log：`/tmp/vite_s4c.log`, `/tmp/mcp_s4c.log`

---

## Hotfix — 右側 panel 可用性 + TransformControls 拖曳
### What changed
- 右側 Workspace panel 的 AI Assistant 由固定高度改為 `min/viewport` 範圍，避免被擠出視窗底部。
- TransformControls 增加 `onPointerDown` 確保點擊 gizmo 也會保持選取；`pointerMissed` 在拖曳期間不再清除選取，避免拖不動。
- Vite server watch 忽略 `.venv`/`node_modules`/`dist`，避免 `ENOSPC` 造成 dev server 停止。

### Follow-up hotfix
- Sidebar 內部容器加上 `min-h-0`，確保右側可正常滾動到最下方。
- TransformControls 放大（`size`/`lineWidth`/marker sphere）讓 X/Y/Z 軸更容易被選取與拖曳。
- Sidebar 寬度改為 `clamp` + panel padding 調整，並根據視窗高度自動收合長內容區塊，避免小螢幕被切掉。

---

## M1 — v2 Scaffold (AppShell + entrypoint)
### Goal
- 建立 v2 入口與最小可跑 AppShell（Canvas + 左右 panel + top bar），不影響 legacy。

### What changed
- 新增 `src/v2`（AppShell / layout / CommandBar / LegacySceneBridge）。
- `src/main.tsx` 支援 `?v=2` 或 `?app=v2` 進入 v2。

### Notes
- 目前 v2 still uses legacy Scene via bridge；v2 3D layer 將在 M4/M5 重建。

---

## M2 — Shared protocol v2 (schemas)
### Goal
- 建立 v2 WS protocol + tool + trace schema（zod），為 router/VLM/trace 做基礎。

### What changed
- 新增 `shared/schema/*`：`protocol.ts`, `tools.ts`, `trace.ts`。
- 新增 `src/v2/network/wsClient.ts` + `protocol.ts`。
- 新增 `mcp-server/v2/wsGateway.ts` 骨架（router 尚未接入）。

---

## M3 — State v2 + undo/redo
### Goal
- 建立 v2 store + history（command-based）並讓 UI 能觸發 undo/redo。

### What changed
- 新增 `src/v2/store/store.ts`（snapshot + undo/redo + command dispatch）。
- Top bar 加入 Undo/Redo 按鈕（v2 AppShell）。

---

## M4 — 3D loading v2 + parts registry
### Goal
- v2 Canvas 能載入 CAD，並在左側 parts list 顯示。

### What changed
- 新增 v2 Canvas（`CanvasRoot` + `ModelLoader`）。
- 新增 `SceneGraph.extractParts` 與 `v2` parts list UI。
- v2 store 支援 `cadUrl/cadFileName/parts`。

---

## M5 — Interaction coordinator v2
### Goal
- 讓選取 + gizmo 拖曳 + orbit 協調正常，拖曳時 orbit 停止。

### What changed
- 新增 `OrbitCoordinator`（依 `isTransformDragging` 控制 OrbitControls）。
- 新增 `TransformGizmo`（可拖移、放大、阻止事件穿透）。
- v2 selection 用 pointerDown 直接選 mesh，並顯示 `SelectionOutline`。

---

## M6 — Anchor model v2
### Goal
- 定義 object-anchored marker（local/face anchor）並可解析成 world space。

### What changed
- 新增 `anchors/types.ts` 與 `anchors/resolve.ts`。
- v2 store 支援 `markers`（start/end anchor）。
- 新增 `AnchorMarkers` 讓 anchor 能在 Canvas 顯示（green/blue）。

---

## M7 — Precision mating v1
### Goal
- 實作 face-based mating（Top/Bottom），避免只靠 AABB。

### What changed
- 新增 `mating/faceClustering.ts` + `mating/solver.ts`（planar face cluster + plane align）。
- 新增 `MatePanel`（source/target + top/bottom）與 `MateExecutor`。
- Apply mate 後會建立 face anchor markers（start/end）。

---

## M8 — SOP editor v2 (initial)
### Goal
- 提供基礎 SOP steps list + timeline bar（可新增/選取），為後續編輯流暢化做基礎。

### What changed
- 新增 `StepsPanel`（add/select list）與 `TimelineBar`。
- 右側 Workspace 內加入 SOP steps panel。

---

## M9 — LLM router v2 (mock + schema)
### Goal
- 文字指令走 router → tool calls（structured JSON）→ trace。

### What changed
- 新增 `mcp-server/v2/router/*` + `tools/registry.ts` + `v2/index.ts`。
- v2 CommandBar 透過 WS 呼叫 `router_execute`（mock provider）。

---

## M10 — VLM pipeline v2 (mock)
### Goal
- 多圖上傳 → Analyze → structured JSON 結果（mock）。

### What changed
- 新增 `VlmPanel` UI（上傳/排序/刪除/Analyze）。
- 新增 `shared/schema/vlm.ts` + `mcp-server/v2/vlm/*`。
- WS 新增 `vlm_analyze` 命令（mock provider）。

---

## M11 — E2E smoke + UI tests
### Goal
- 提供最小 v2 end-to-end smoke test。

### What changed
- 新增 `tests/v2_smoke.spec.ts`（v2: load → select → mate → add step → VLM analyze）。

---

## M12 — Cutover + docs
### Goal
- v2 成為預設入口；文件更新讓他人可接手。

### What changed
- `src/main.tsx` 預設進 v2，`?legacy=1` 可回到 v1。
- README / ARCHITECTURE 更新 v2 結構與啟動方式。

### Test evidence
- Screenshot: `test-results/fix-right-sidebar.png`

---

## M13 — Mate UX fixes + WS status
### Goal
- Mate 預覽點更清楚、可微調；修正選取卡住與 WS 斷線提示。

### What changed
- Mate 預覽只保留 Source/Target 兩點並加標籤；Anchor markers 預設隱藏（可在 View 開啟）。
- Mate 支援 Source/Target 偏移微調與 Reset；新增 Step Update 保存當前姿態。
- 修正 selection lock；WS 連線狀態顯示與 Chat 斷線提示/重連。
- Selection bounding box 改用 Box3Helper + 更新 world matrix。

### Test evidence
- `npm run build`
