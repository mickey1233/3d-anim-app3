# MCP Tool Reference

All available tools in `namespace.action` format.

## selection

| Tool | Required Args | Purpose |
|------|--------------|---------|
| `selection.set` | `selection: {kind, part?}`, `replace?`, `autoResolve?` | Set the active selection to a part or clear it |
| `selection.clear` | — | Clear the current selection |

## query

| Tool | Required Args | Purpose |
|------|--------------|---------|
| `query.scene_state` | — | Get the current scene state (parts, positions, steps) |
| `query.part_info` | `part: PartRef` | Get detailed info about a specific part |
| `query.mate_suggestions` | `sourcePart: PartRef`, `targetPart: PartRef`, `instruction?`, `preferredSourceFace?`, `preferredTargetFace?`, `sourceMethod?`, `targetMethod?`, `maxPairs?` | Get ranked mate face/method suggestions for two parts |

## view

| Tool | Required Args | Purpose |
|------|--------------|---------|
| `view.set_grid_visible` | `visible: boolean` | Show or hide the floor grid |
| `view.set_environment` | `environment: string` | Change the HDRI/lighting environment. Values: `warehouse`, `studio`, `city`, `sunset`, `dawn`, `night`, `forest`, `apartment`, `lobby`, `park` |
| `view.reset_camera` | — | Reset camera to default position |
| `view.set_camera` | `position?`, `target?` | Set camera position and look-at target |

## action

| Tool | Required Args | Purpose |
|------|--------------|---------|
| `action.mate_execute` | `sourcePart: PartRef`, `targetPart: PartRef`, `sourceFace`, `targetFace`, `sourceMethod?`, `targetMethod?`, `mode`, `mateMode`, `commit?`, `pushHistory?`, `stepLabel?` | Execute a mate operation between two parts |
| `mate.save_recipe` | `sourceName: string`, `targetName: string`, `sourceFace`, `targetFace`, `sourceMethod?`, `targetMethod?`, `note?` | Save a mate recipe so AI uses it automatically next time (learning from user correction) |
| `action.reset_part` | `part: PartRef` | Reset a part to its original transform |
| `action.reset_all` | — | Reset all parts to their original transforms |
| `action.transform_part` | `part: PartRef`, `position?`, `rotation?` | Move or rotate a part |

## steps

| Tool | Required Args | Purpose |
|------|--------------|---------|
| `steps.add` | `label: string`, `select?` | Create a new assembly step |
| `steps.delete` | `stepId: string` | Delete a step |
| `steps.reorder` | `stepIds: string[]` | Reorder steps |
| `steps.update` | `stepId: string`, `label?` | Update a step label |

## vlm

| Tool | Required Args | Purpose |
|------|--------------|---------|
| `vlm.analyze` | `prompt: string` | Ask the vision model to analyze the current scene |
| `vlm.capture_for_mate` | `sourcePart: PartRef`, `targetPart: PartRef` | Capture multi-angle views for mate inference |

## history

| Tool | Required Args | Purpose |
|------|--------------|---------|
| `history.undo` | — | Undo the last action |
| `history.redo` | — | Redo the last undone action |

## mode

| Tool | Required Args | Purpose |
|------|--------------|---------|
| `mode.set_interaction_mode` | `mode: 'select'|'move'|'rotate'|'mate'`, `reason?` | Switch the 3D interaction mode |

## ui

| Tool | Required Args | Purpose |
|------|--------------|---------|
| `ui.get_sync_state` | — | Get current UI sync state |

## preview

| Tool | Required Args | Purpose |
|------|--------------|---------|
| `preview.transform_plan` | `moves: Array<{part: PartRef, position?, rotation?}>` | Preview multiple transforms before committing |

---

## Types

**PartRef**: `{ partId?: string } | { partName?: string }` — at least one field required.

**Faces**: `"top" | "bottom" | "left" | "right" | "front" | "back"`

**Anchor Methods**: `"auto" | "planar_cluster" | "geometry_aabb" | "object_aabb" | "extreme_vertices" | "obb_pca" | "picked"`

**Mate Modes (mateMode)**: `"face_flush" | "face_insert_arc" | "edge_to_edge" | "axis_to_axis" | "point_to_point" | "planar_slide" | "hinge_revolute"`

**Animation Mode (mode)**: `"translate" | "twist" | "both"`
