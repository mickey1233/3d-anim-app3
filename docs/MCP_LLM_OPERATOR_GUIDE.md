# MCP LLM Operator Guide

This document is the execution manual for LLM agents controlling the 3D assembly system through MCP only.

## 1. Core rules

- Never mutate scene state directly from UI text parsing.
- Every state change must go through MCP tools.
- Prefer `preview` before `commit` unless user explicitly asks to apply immediately.
- If selection is ambiguous, use clarification flow or suggested tool calls.
- Always include `sceneRevision` in meta when available.

## 2. Intent classes

- `CHAT`: answer only, no tool calls.
- `TOOL_CALL`: one or more MCP tools.
- `MIXED`: tool calls + textual explanation.
- `CLARIFY`: ask concise question before tool call.

## 3. Standard recipes

### 3.1 Mate/twist/both recipe

1. `selection.set` for source.
2. `selection.set` for target.
3. `query.face_info` for source/target.
4. `action.generate_transform_plan`.
5. `preview.transform_plan`.
6. Ask confirmation.
7. `action.commit_preview`.

### 3.2 View recipe (environment/grid/anchors)

1. `view.set_environment` (optional).
2. `view.set_grid_visible` (optional).
3. `view.set_anchors_visible` (optional).

### 3.2 Rotation drag recipe

1. `mode.set_interaction_mode("rotate")`.
2. `interaction.rotate_drag_begin`.
3. `interaction.rotate_drag_update` (loop).
4. `interaction.rotate_drag_end`.

### 3.3 Direct transform recipe (absolute + reset)

1. `action.set_part_transform` for precise edit (position/quaternion/scale).
2. Use `previewOnly=true` if user wants confirmation.
3. `action.reset_part` / `action.reset_all` for explicit reset intent.

### 3.3 Error recovery recipe

- `AMBIGUOUS_SELECTION` -> call `query.scene_state`, ask user to choose.
- `SCENE_OUT_OF_SYNC` -> `ui.get_sync_state` then retry.
- `SOLVER_FAILED` -> fallback order:
  1. switch mode (`face_insert_arc` -> `face_flush`)
  2. reduce constraints
  3. ask for additional picks.

### 3.4 Steps (SOP) recipe

1. `steps.add` to create a step.
2. `steps.select` to focus a step.
3. `steps.update_snapshot` to store current overrides into the step.
4. `steps.move` to reorder.
5. `steps.playback_start` / `steps.playback_stop` for timeline playback.

### 3.5 VLM recipe

1. `vlm.add_images` to add images (base64).
2. `vlm.analyze` to run analysis and store `result`.

## 4. Tool-call examples

### Example A: both + arc + commit

```json
{ "tool": "action.generate_transform_plan", "args": {
  "operation": "both",
  "source": { "kind": "face", "part": { "partName": "Lid" }, "face": "bottom", "method": "auto" },
  "target": { "kind": "face", "part": { "partName": "Box" }, "face": "top", "method": "auto" },
  "mateMode": "face_insert_arc",
  "pathPreference": "arc",
  "twist": { "angleDeg": 12, "axis": "normal", "axisSpace": "target_face", "constraint": "normal_only" },
  "arc": { "height": 0.08, "lateralBias": 0 }
} }
```

```json
{ "tool": "preview.transform_plan", "args": { "planId": "plan-100" } }
```

```json
{ "tool": "action.commit_preview", "args": { "previewId": "preview-100", "stepLabel": "Lid close" } }
```

### Example B: ambiguous selection handling

```json
{ "tool": "selection.set", "args": { "selection": { "kind": "part", "part": { "partName": "cap" } }, "autoResolve": true } }
```

If error code is `AMBIGUOUS_SELECTION`:

```json
{ "tool": "query.scene_state", "args": { "verbosity": "summary" } }
```

Then ask:

```text
I found Cap_A and Cap_B. Which one should I use?
```

### Example C: twist with arbitrary angle

```json
{ "tool": "action.generate_transform_plan", "args": {
  "operation": "twist",
  "source": { "kind": "face", "part": { "partName": "Rotor" }, "face": "top", "method": "auto" },
  "target": { "kind": "face", "part": { "partName": "Housing" }, "face": "top", "method": "auto" },
  "mateMode": "face_flush",
  "twist": { "angleDeg": 37, "axis": "normal", "axisSpace": "target_face", "constraint": "normal_only" }
} }
```

## 5. Safety boundaries

- Do not execute destructive reset commands unless user intent is explicit.
- For operations that move many parts, run preview first and ask confirmation.
- Keep chat responses concise and report exact mode/angle/part names used.

## 6. Reference

- Schema: `shared/schema/mcpToolsV3.ts`
- Full architecture: `docs/MCP_CONTROL_ARCHITECTURE.md`
