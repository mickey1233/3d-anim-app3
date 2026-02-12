# MCP-Controlled 3D Assembly System Design

## 1. Architecture (modules, data flow, state flow)

### 1.1 Module boundaries (single source of truth)

```text
[Chat UI] [Canvas UI] [Timeline UI]
    |          |           |
    | user intent/events   |
    +----------+-----------+
               |
               v
      [Frontend MCP Client]
               |
         WebSocket/JSON-RPC
               |
               v
        [MCP Server Gateway]
               |
               v
      [Intent Router + Policy]
               |
               v
      [Command Engine (Authoritative)]
               |
     +---------+----------------------+------------------+
     |                                |                  |
     v                                v                  v
[Scene Graph Adapter]           [Constraint Solver]  [History/Preview]
     |                                |                  |
     +------------------+-------------+------------------+
                        |
                        v
                 [Scene State Store]
                        |
                        v
               [ui.get_sync_state/event]
                        |
                        v
                 [Frontend render only]
```

### 1.2 Responsibilities

- `Frontend Chat UI`:
  - 收使用者文字。
  - 不直接改 scene。
  - 只呼叫 MCP tools，顯示 tool 回傳結果。
- `Frontend Canvas UI`:
  - 顯示模型、預覽路徑、gizmo。
  - mouse drag 只送事件到 MCP (`interaction.rotate_drag_*`)。
  - 不直接對 mesh 寫 transform。
- `MCP Gateway`:
  - schema validation、auth、request/trace id。
- `Intent Router`:
  - 判斷 `CHAT | TOOL_CALL | MIXED | CLARIFY`。
  - 決定 tool call sequence。
- `Command Engine`:
  - 所有核心狀態改動唯一入口。
  - 統一處理 preview/commit/history。
- `Constraint Solver`:
  - mate/twist/both 演算法。
  - 產生可 debug 的 `TransformPlan`。
- `Scene State Store`:
  - selection、transform、constraints、history、preview、ui sync。

### 1.3 Request flow

1. User text -> Chat UI。
2. Chat UI 呼叫 `router_execute`（或本地 router policy）。
3. Router 回傳 tool calls。
4. Frontend/Orchestrator 依序呼叫 MCP tools。
5. MCP server 修改 Scene State，回傳 `sceneRevision + debug`。
6. 前端只根據 `ui.get_sync_state` 或 server event 重繪。

### 1.4 State flow

```text
idle
 -> (action.generate_transform_plan)
planned
 -> (preview.transform_plan)
previewing
 -> (action.commit_preview)
committed
 -> (history.undo / history.redo)
committed' / previous
 -> (preview.cancel)
idle
```

- Preview state 與 committed state 必須分離。
- 每次成功 commit 必須推入 history（除非 `pushHistory=false`）。
- 每次 tool response 都帶 `sceneRevision`，避免前端 stale write。

### 1.5 Scene state model (authoritative)

- `selection`: active feature + stack（part/face/edge/axis/point）。
- `parts`: transform (position/quaternion/scale), initial transform, metadata。
- `frames`: 對 face/edge/axis 建立 local frame（origin/normal/tangent/bitangent）。
- `constraints`: mate mode + tunables（offset/clearance/flip/twist）。
- `preview`: `previewId`, `planId`, scrubT, active。
- `history`: past/future stacks + labels。
- `interaction`: current mode (`select/move/rotate/mate`) + rotate drag session。

Implementation schema: `shared/schema/mcpToolsV3.ts`。

---

## 2. MCP tool list + JSON schema (each tool)

Source of truth:
- `shared/schema/mcpToolsV3.ts`

### 2.1 Error codes (shared)

- `INVALID_ARGUMENT`
- `NOT_FOUND`
- `AMBIGUOUS_SELECTION`
- `MODE_CONFLICT`
- `UNSUPPORTED_OPERATION`
- `SOLVER_FAILED`
- `CONSTRAINT_VIOLATION`
- `PREVIEW_NOT_FOUND`
- `HISTORY_EMPTY`
- `SCENE_OUT_OF_SYNC`
- `INTERNAL_ERROR`

Response envelope (all tools):

```json
{
  "ok": true,
  "sceneRevision": 42,
  "data": {},
  "warnings": [{ "code": "AUTO_FIX", "message": "..." }],
  "debug": {}
}
```

```json
{
  "ok": false,
  "sceneRevision": 42,
  "error": {
    "code": "AMBIGUOUS_SELECTION",
    "message": "Part name 'cover' matches 3 objects",
    "recoverable": true,
    "suggestedToolCalls": [{ "tool": "query.scene_state", "args": {} }]
  }
}
```

### 2.2 Selection tools

#### `selection.get`

```json
{ "args": {} }
```

```json
{
  "data": {
    "selection": {
      "active": { "kind": "face", "part": { "partId": "...", "partName": "Lid" }, "face": "top" },
      "stack": []
    }
  }
}
```

#### `selection.set`

```json
{
  "args": {
    "selection": {
      "kind": "face",
      "part": { "partName": "lid" },
      "face": "bottom",
      "method": "auto"
    },
    "replace": true,
    "autoResolve": true
  }
}
```

```json
{
  "data": {
    "selection": { "active": { "kind": "face" }, "stack": [] },
    "resolved": {
      "kind": "face",
      "part": {
        "partId": "uuid-lid",
        "partName": "Lid_Main",
        "confidence": 0.93,
        "autoCorrected": true,
        "reason": "fuzzy name match"
      },
      "face": "bottom",
      "methodRequested": "auto",
      "methodUsed": "obb_pca",
      "fallbackUsed": false
    },
    "autoFixes": []
  }
}
```

#### `selection.clear`

```json
{ "args": { "scope": "all" } }
```

### 2.3 Query tools

#### `query.scene_state`

```json
{ "args": { "verbosity": "summary" } }
```

Returns part list + transform + bbox + selection + interaction mode.

#### `query.part_transform`

```json
{ "args": { "part": { "partName": "Lid" }, "space": "world" } }
```

Returns resolved part + transform.

#### `query.face_info`

```json
{
  "args": {
    "part": { "partName": "Lid" },
    "face": "bottom",
    "method": "auto"
  }
}
```

Returns `frameWorld`, `normalOutward`, method requested/used.

#### `query.local_frame`

```json
{
  "args": {
    "feature": {
      "kind": "edge",
      "part": { "partName": "Bracket" },
      "edgeId": "e12"
    },
    "space": "world"
  }
}
```

#### `query.bounding_box`

```json
{ "args": { "part": { "partName": "Lid" }, "space": "world" } }
```

#### `query.list_mate_modes`

```json
{ "args": { "sourceKind": "face", "targetKind": "face" } }
```

Returns mode list + required feature kinds + tunables.

### 2.4 Action/plan tools

#### `action.translate`

```json
{
  "args": {
    "part": { "partName": "Lid" },
    "delta": [0, 0.01, 0],
    "space": "world",
    "previewOnly": true
  }
}
```

#### `action.rotate`

```json
{
  "args": {
    "part": { "partName": "Lid" },
    "axis": { "axis": "z", "axisSpace": "world" },
    "angleDeg": 37,
    "previewOnly": true
  }
}
```

#### `action.generate_transform_plan`

```json
{
  "args": {
    "operation": "both",
    "source": { "kind": "face", "part": { "partName": "Lid" }, "face": "bottom", "method": "auto" },
    "target": { "kind": "face", "part": { "partName": "Box" }, "face": "top", "method": "auto" },
    "mateMode": "face_insert_arc",
    "pathPreference": "arc",
    "durationMs": 1200,
    "sampleCount": 72,
    "offset": 0.0,
    "clearance": 0.004,
    "flip": false,
    "twist": {
      "angleDeg": 15,
      "axis": "normal",
      "axisSpace": "target_face",
      "constraint": "normal_only"
    },
    "arc": { "height": 0.12, "lateralBias": 0.0 },
    "autoCorrectSelection": true,
    "autoSwapSourceTarget": true,
    "enforceNormalPolicy": "source_out_target_in"
  }
}
```

Returns `plan` with `steps[]`, `autoFixes[]`, `debug` axes/angles/frames.

### 2.5 Preview/commit tools

#### `preview.transform_plan`

```json
{ "args": { "planId": "plan-123", "replaceCurrent": true, "scrubT": 0.35 } }
```

#### `preview.status`

```json
{ "args": {} }
```

#### `preview.cancel`

```json
{ "args": { "previewId": "preview-555" } }
```

#### `action.commit_preview`

```json
{ "args": { "previewId": "preview-555", "stepLabel": "盖上盖子", "pushHistory": true } }
```

### 2.6 History tools

#### `history.undo`

```json
{ "args": {} }
```

#### `history.redo`

```json
{ "args": {} }
```

### 2.7 Interaction mode + UI sync tools

#### `mode.set_interaction_mode`

```json
{ "args": { "mode": "rotate", "reason": "user_toggle" } }
```

#### `ui.get_sync_state`

```json
{ "args": {} }
```

Returns `interactionMode`, `selection`, `preview`, `playback`, `history`.

### 2.8 Rotate drag tools (Canvas -> MCP)

#### `interaction.rotate_drag_begin`

```json
{
  "args": {
    "part": { "partId": "uuid-lid" },
    "pointerNdc": [0.12, -0.25],
    "strategy": "arcball",
    "camera": {
      "positionWorld": [3, 3, 4],
      "targetWorld": [0, 0, 0],
      "upWorld": [0, 1, 0],
      "fovDeg": 50,
      "viewportPx": [1280, 720]
    }
  }
}
```

#### `interaction.rotate_drag_update`

```json
{
  "args": {
    "sessionId": "drag-77",
    "pointerNdc": [0.17, -0.30],
    "snapDeg": 1
  }
}
```

#### `interaction.rotate_drag_end`

```json
{ "args": { "sessionId": "drag-77", "commit": true } }
```

---

## 3. LLM MCP usage docs (routing policy, ordering, constraints, examples)

### 3.1 Intent policy

Classify each user message into one of:

- `CHAT`: 純問答、產品說明、無 scene mutation。
- `TOOL_CALL`: 明確 3D 操作。
- `MIXED`: 同時對話 + 操作（先操作後回覆摘要）。
- `CLARIFY`: 缺關鍵參數或存在高歧義。

### 3.2 Router decision rules

1. 若句子含可執行動詞（move/rotate/mate/align/insert/undo/redo/reset） -> `TOOL_CALL`。
2. 若同時有社交/詢問 + 動詞 -> `MIXED`。
3. 若缺 source/target 或 part 不唯一 -> `CLARIFY`，或先用 `selection.set(autoResolve=true)` 嘗試。
4. 若 solver 失敗 -> 先改 mode/path fallback，再回報原因與下一步。

### 3.3 Mandatory call ordering

#### Pattern A: simple transform

1. `selection.set`
2. `action.translate` or `action.rotate` (`previewOnly=true`)
3. `action.commit_preview` or direct commit

#### Pattern B: mate/twist/both

1. `selection.set` (source)
2. `selection.set` (target)
3. `query.face_info` (source/target)
4. `action.generate_transform_plan`
5. `preview.transform_plan`
6. ask confirmation (unless user asked immediate execution)
7. `action.commit_preview`

#### Pattern C: drag rotate

1. `mode.set_interaction_mode("rotate")`
2. `interaction.rotate_drag_begin`
3. zero to N times `interaction.rotate_drag_update`
4. `interaction.rotate_drag_end(commit=true|false)`

### 3.4 Hard constraints for LLM

- 不可直接假設 partId；先 resolve。
- 不可跳過 preview 直接 commit（除非使用者明確要求）。
- 每次 commit 後若使用者要求步驟化，附帶 `stepLabel`。
- 遇到 `AMBIGUOUS_SELECTION` 必須澄清或採用 `suggestedToolCalls`。
- 遇到 `SCENE_OUT_OF_SYNC` 必須先 `ui.get_sync_state` 再重試。

### 3.5 Example dialogue 1 (Both arc path + auto-fix)

User:

```text
把上蓋蓋到盒子上，走弧線，旋轉 20 度
```

Tool calls:

```json
{ "tool": "selection.set", "args": { "selection": { "kind": "face", "part": { "partName": "上蓋" }, "face": "bottom", "method": "auto" }, "autoResolve": true } }
```

```json
{
  "ok": true,
  "data": {
    "resolved": {
      "kind": "face",
      "part": { "partId": "uuid-cover-main", "partName": "Cover_Main", "confidence": 0.88, "autoCorrected": true, "reason": "closest fuzzy match" },
      "face": "bottom",
      "methodRequested": "auto",
      "methodUsed": "obb_pca",
      "fallbackUsed": false
    }
  }
}
```

```json
{ "tool": "selection.set", "args": { "selection": { "kind": "face", "part": { "partName": "盒子" }, "face": "top", "method": "auto" }, "autoResolve": true } }
```

```json
{ "tool": "action.generate_transform_plan", "args": {
  "operation": "both",
  "source": { "kind": "face", "part": { "partName": "Cover_Main" }, "face": "bottom", "method": "auto" },
  "target": { "kind": "face", "part": { "partName": "Box_Base" }, "face": "top", "method": "auto" },
  "mateMode": "face_insert_arc",
  "pathPreference": "arc",
  "twist": { "angleDeg": 20, "axis": "normal", "axisSpace": "target_face", "constraint": "normal_only" },
  "arc": { "height": 0.1, "lateralBias": 0 },
  "enforceNormalPolicy": "source_out_target_in"
} }
```

```json
{ "tool": "preview.transform_plan", "args": { "planId": "plan-42", "scrubT": 1.0 } }
```

Assistant to user:

```text
已生成弧線預覽，包含 20 度扭轉。是否提交這次裝配？
```

User:

```text
提交
```

```json
{ "tool": "action.commit_preview", "args": { "previewId": "preview-42", "stepLabel": "Cover to Box (arc+twist)", "pushHistory": true } }
```

### 3.6 Example dialogue 2 (error handling + auto correction)

User:

```text
把 cap 轉到對齊孔位
```

```json
{ "tool": "selection.set", "args": { "selection": { "kind": "part", "part": { "partName": "cap" } }, "autoResolve": true } }
```

Response:

```json
{
  "ok": false,
  "error": {
    "code": "AMBIGUOUS_SELECTION",
    "message": "partName 'cap' matches [Cap_A, Cap_B]",
    "recoverable": true,
    "suggestedToolCalls": [
      { "tool": "query.scene_state", "args": { "verbosity": "summary" }, "reason": "list candidates" }
    ]
  }
}
```

LLM must do:

```json
{ "tool": "query.scene_state", "args": { "verbosity": "summary" } }
```

Then ask user clarification:

```text
目前有 Cap_A 與 Cap_B，要對齊哪一個？
```

After user picks `Cap_B`:

```json
{ "tool": "selection.set", "args": { "selection": { "kind": "part", "part": { "partName": "Cap_B" } } } }
```

Continue with rotate plan + preview + commit.

### 3.7 Example dialogue 3 (MIXED)

User:

```text
你先把 bracket 旋轉 37 度，再跟我說這個模式差別
```

LLM behavior:

1. call `action.rotate` (preview)
2. call `action.commit_preview`
3. 回答 rotate vs both mode 差異

---

## 4. Twist/Both/Mate modes: algorithm design + pseudocode

### 4.1 Mate mode set (7 modes)

| Mode | Required picks | Solve target | Path | Tunables |
|---|---|---|---|---|
| `face_flush` | source face + target face | face normals opposite, origins coincident (+offset) | line | offset, flip, twistAngle |
| `face_insert_arc` | source face + target face | flush end pose + insertion clearance policy | arc | clearance, arcHeight, flip, twistAngle |
| `edge_to_edge` | source edge + target edge | edge directions aligned, closest points matched | line | offsetAlongEdge, flip |
| `axis_to_axis` | source axis + target axis | axis colinear + optional axial offset | screw/line | axialOffset, radialClearance, twistAngle |
| `point_to_point` | source point + target point | point coincidence | line | offsetVec |
| `planar_slide` | source face + target face | keep coplanar, allow tangential DOF | line | slideAxis, min/max range |
| `hinge_revolute` | hinge axis + target stop face/angle | axis fixed, rotation constrained | arc | angleLimitMin/Max, damping |

### 4.2 Building local frame from face

Given a mesh face set `F`:

1. `origin`: area-weighted centroid in world coordinates.
2. `normal`:
   - average of triangle normals (area weighted), normalize.
   - enforce outward policy using bbox center test:
     - if `(origin - bboxCenter) · normal < 0` then `normal = -normal`.
3. `tangent`:
   - PCA first principal direction projected onto plane orthogonal to normal.
   - fallback to stable axis projection.
4. `bitangent = normalize(normal × tangent)`.

Frame matrix:

```text
R = [tangent bitangent normal]  (3x3)
T = [R origin; 0 0 0 1]
```

### 4.3 Rotation solve (source frame -> target frame)

Base alignment:

```text
R_align = R_target * transpose(R_source)
q_align = quat(R_align)
```

Apply to source transform:

```text
q1 = q_align * q_source
```

Translation solve:

```text
p1 = p_source + (origin_target - origin_source_after_rotation) + normal_target * offset
```

### 4.4 Twist definition and solve

Twist axis policy:

- `normal_only`: axis = target.normal
- `world_axis_only`: axis = world x/y/z
- `free`: axis from `twist.axis` + `twist.axisSpace`

Automatic twist angle from tangents:

```text
t_s = projected source tangent on plane perpendicular to axis
t_t = projected target tangent on plane perpendicular to axis
theta_auto = atan2(dot(cross(t_s, t_t), axis), dot(t_s, t_t))
theta_final = theta_auto + theta_user
```

Arbitrary-angle twist is always allowed (`angleDeg: number`), no 90-degree restriction.

### 4.5 Both arc path (reliable method)

Recommended default: `slerp + quadratic bezier position`.

- End pose from mate solve (`p_end`, `q_end`)。
- Control point:

```text
mid = 0.5 * (p_start + p_end)
liftAxis = normalize(target.bitangent or worldUp fallback)
control = mid + liftAxis * arcHeight + target.normal * clearance
```

- Position sample:

```text
p(t) = (1-t)^2 * p_start + 2(1-t)t * control + t^2 * p_end
```

- Orientation sample:

```text
q(t) = slerp(q_start, q_end, easeInOut(t))
```

If hinge axis is known, fallback to circular arc around hinge axis.

### 4.6 Preview generation

- Input: `durationMs`, `sampleCount`, pose endpoints, path strategy.
- Output: `TransformPlan.steps[]` with `timeMs`, `positionWorld`, `quaternionWorld`.
- Preview tool applies plan to ghost layer only (no state mutation except preview state).

### 4.7 Conflict handling

- wrong normals -> auto flip if `enforceNormalPolicy=source_out_target_in`.
- source/target swapped -> auto swap when solver residual drops.
- invalid picks -> `INVALID_ARGUMENT` + suggested required picks.
- ambiguous part -> `AMBIGUOUS_SELECTION` + candidates.
- solver non-convergence -> `SOLVER_FAILED` + fallback mode suggestions.

### 4.8 Pseudocode

```ts
function generateTransformPlan(input: GeneratePlanArgs): TransformPlan {
  const source = resolveFeature(input.source, input.autoCorrectSelection);
  const target = input.target ? resolveFeature(input.target, input.autoCorrectSelection) : undefined;

  const normalized = normalizeRequest(input, source, target); // flip/swap/constraints
  const { startPose, endPose, debug } = solveEndPose(normalized);

  const samples = samplePath({
    operation: input.operation,
    pathPreference: input.pathPreference,
    startPose,
    endPose,
    durationMs: input.durationMs,
    sampleCount: input.sampleCount,
    arc: input.arc,
  });

  return {
    planId: newPlanId(),
    operation: input.operation,
    mode: normalized.mode,
    source,
    target,
    pathType: samples.pathType,
    durationMs: input.durationMs,
    steps: samples.steps,
    constraints: normalized.constraints,
    autoFixes: normalized.autoFixes,
    debug,
  };
}
```

---

## 5. UI (Move/Rotate toggle + mouse drag rotate) event flow and interfaces

### 5.1 Mode toggle

UI button (`Move` / `Rotate` / `Mate`) flow:

1. button click
2. call `mode.set_interaction_mode`
3. refresh with `ui.get_sync_state`
4. render active mode badge

No direct scene mutation in button handler.

### 5.2 Mouse drag rotate flow

```text
pointerdown on selected mesh
 -> interaction.rotate_drag_begin
 -> receive sessionId + previewId
pointermove (throttled)
 -> interaction.rotate_drag_update(sessionId, pointerNdc)
 -> receive preview transform
pointerup
 -> interaction.rotate_drag_end(sessionId, commit=true)
 -> history push + final sync
pointercancel/escape
 -> interaction.rotate_drag_end(sessionId, commit=false)
```

### 5.3 Frontend interface contract (example)

```ts
export type RotateDragSession = {
  sessionId: string;
  previewId: string;
  partId: string;
};

export type PointerPayload = {
  pointerNdc: [number, number];
  camera: {
    positionWorld: [number, number, number];
    targetWorld: [number, number, number];
    upWorld: [number, number, number];
    fovDeg: number;
    viewportPx: [number, number];
  };
};
```

### 5.4 Drag mapping recommendation

- default strategy: `arcball`
- optional: `gizmo` for constrained axis rotation
- update rate: 30-60Hz throttle
- always send latest pointer, server computes rotation and returns preview transform

---

## 6. Test cases (>=8 with edge cases)

1. `Twist arbitrary angle`
   - input: `action.generate_transform_plan(operation=twist, angleDeg=37)`
   - expect: success, `debug.twistAngleDeg ~= 37 +/- 0.2`.

2. `Twist axis constraint normal_only`
   - input: axis requested `x`, constraint `normal_only`
   - expect: warning + axis auto-correct to face normal.

3. `Both arc continuity`
   - input: `operation=both`, `pathPreference=arc`
   - expect: no quaternion jumps (`dot(q_i, q_{i+1}) > 0` after sign correction), path not linear.

4. `Face normal policy`
   - input: source/target normals same direction and `enforceNormalPolicy=source_out_target_in`
   - expect: auto flip or auto swap in `autoFixes`.

5. `Ambiguous selection`
   - input: `selection.set(partName='cap')` with 2+ matches
   - expect: `AMBIGUOUS_SELECTION` and candidate suggestions.

6. `Scene revision conflict`
   - input: stale `sceneRevision` in tool meta
   - expect: `SCENE_OUT_OF_SYNC`, client re-fetch state and retry works.

7. `Undo/redo integrity`
   - flow: commit 3 operations -> undo x3 -> redo x3
   - expect: final pose equals original forward result within epsilon.

8. `Preview cancel`
   - flow: generate plan -> preview -> cancel
   - expect: committed transforms unchanged, preview cleared.

9. `Rotate drag cancel`
   - flow: begin -> updates -> end(commit=false)
   - expect: no history entry, pose restored.

10. `Planar slide constraint`
    - input: slide beyond max range
    - expect: `CONSTRAINT_VIOLATION` or clamped result with warning.

11. `Axis-to-axis with clearance`
    - expect: axis colinearity residual below threshold, distance equals clearance.

12. `Error fallback`
    - input: invalid mode-feature combo (`point_to_point` with faces)
    - expect: `INVALID_ARGUMENT` + suggested mode list from `query.list_mate_modes`.

### 6.1 Acceptance thresholds

- pose position error: <= `1e-3` scene units.
- orientation error: <= `0.5 deg`.
- twist angle error: <= `0.5 deg`.
- preview update latency P95: <= `50 ms`.
- no frame-to-frame discontinuity in `both` preview.

