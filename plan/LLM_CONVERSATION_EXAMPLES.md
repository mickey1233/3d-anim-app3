# LLM + MCP Tool Call — Complete Conversation Examples

> These examples show the full message flow between User → LLM → MCP Tools → Response,
> including error handling, auto-correction, normal flip, fuzzy matching, and multi-step mate operations.

---

## Example 1: Simple Move (Happy Path)

```
USER: "Move Part2 up by 3 units"

LLM REASONING:
  - Intent: TOOL_CALL (translate)
  - Part: "Part2" (exact match)
  - Direction: "up" = +Y
  - Amount: 3 units

TOOL CALL 1: get_scene_state()
RESULT: {
  "parts": [
    { "uuid": "abc-123", "name": "Base_Plate", "position": [0, 0, 0], ... },
    { "uuid": "def-456", "name": "Part2", "position": [1, 0.5, 0], ... },
    { "uuid": "ghi-789", "name": "Cover_Lid", "position": [2, 3, 0], ... }
  ]
}

TOOL CALL 2: translate_part({ part: "Part2", mode: "relative", x: 0, y: 3, z: 0 })
RESULT: {
  "success": true,
  "part_uuid": "def-456",
  "new_position": [1, 3.5, 0],
  "was_preview": false
}

LLM RESPONSE TO USER:
  "Done! Moved Part2 up by 3 units. New position: (1, 3.5, 0)."
```

---

## Example 2: Fuzzy Name Matching + Auto-Correction

```
USER: "move the conector to the base plate"

LLM REASONING:
  - Intent: TOOL_CALL (move/align)
  - Need to resolve part names via fuzzy match

TOOL CALL 1: get_scene_state()
RESULT: {
  "parts": [
    { "uuid": "a1", "name": "Connector_A", "position": [5, 0, 0], ... },
    { "uuid": "b2", "name": "Base_Plate", "position": [0, 0, 0], ... },
    { "uuid": "c3", "name": "Cover", "position": [0, 5, 0], ... }
  ]
}

LLM REASONING:
  - "conector" → fuzzy match → "Connector_A" (Levenshtein distance = 2)
  - "base plate" → fuzzy match → "Base_Plate" (exact semantic match)
  - No face specified → default: source_face=bottom, target_face=top
  - Use flush mate mode

TOOL CALL 2: compute_mate({
  source_part: "Connector_A",
  source_face: "bottom",
  target_part: "Base_Plate",
  target_face: "top",
  mode: "flush"
})
RESULT: {
  "success": true,
  "result_transform": {
    "position": [0, 1.2, 0],
    "quaternion": [0, 0, 0, 1]
  },
  "debug": {
    "source_frame": { "origin": [5, 0, 0], "normal": [0, -1, 0], ... },
    "target_frame": { "origin": [0, 1.2, 0], "normal": [0, 1, 0], ... },
    "normal_dot": -1.0,
    "auto_flipped": false
  }
}

TOOL CALL 3: preview_transform({
  part: "Connector_A",
  position: [0, 1.2, 0],
  quaternion: [0, 0, 0, 1]
})
RESULT: { "success": true, "preview_id": "prev-001" }

TOOL CALL 4: commit_transform({ part: "Connector_A" })
RESULT: {
  "success": true,
  "final_position": [0, 1.2, 0],
  "history_id": "hist-001"
}

LLM RESPONSE TO USER:
  "Moved Connector_A (bottom) to Base_Plate (top) using flush mate.
   Note: I matched 'conector' → 'Connector_A' and 'base plate' → 'Base_Plate'."
```

---

## Example 3: Normal Flip Auto-Recovery

```
USER: "align Part1 top to Part2 top"

LLM REASONING:
  - Both faces are "top" → normals likely point the same direction
  - For flush mate, normals must oppose
  - Try first, handle error

TOOL CALL 1: compute_mate({
  source_part: "Part1",
  source_face: "top",
  target_part: "Part2",
  target_face: "top",
  mode: "flush"
})
RESULT: {
  "success": false,
  "error": "Source and target normals point in the same direction. Flush mate requires opposing normals.",
  "error_code": "NORMALS_SAME_DIRECTION",
  "debug": {
    "source_frame": { "normal": [0, 1, 0], ... },
    "target_frame": { "normal": [0, 1, 0], ... },
    "normal_dot": 1.0,
    "auto_flipped": false
  }
}

LLM REASONING:
  - Error: NORMALS_SAME_DIRECTION
  - Auto-recovery: retry with flip=true to flip the source normal

TOOL CALL 2: compute_mate({
  source_part: "Part1",
  source_face: "top",
  target_part: "Part2",
  target_face: "top",
  mode: "flush",
  flip: true
})
RESULT: {
  "success": true,
  "result_transform": {
    "position": [0, 3.5, 0],
    "quaternion": [1, 0, 0, 0]   // 180° flip around X
  },
  "debug": {
    "normal_dot": -1.0,
    "auto_flipped": true,
    "rotation_angle_deg": 180
  }
}

TOOL CALL 3: preview_transform({
  part: "Part1",
  position: [0, 3.5, 0],
  quaternion: [1, 0, 0, 0]
})

TOOL CALL 4: commit_transform({ part: "Part1" })

LLM RESPONSE TO USER:
  "Aligned Part1 top to Part2 top. Since both normals pointed upward,
   I flipped Part1 (180° rotation) so the surfaces face each other properly.
   If this isn't what you wanted, say 'undo' and try specifying 'Part1 bottom to Part2 top' instead."
```

---

## Example 4: Insert Mode with Arc Path ("Both" Mode)

```
USER: "insert the screen into the tray, like putting a cover on"

LLM REASONING:
  - Intent: TOOL_CALL (mate, insert mode)
  - "insert" / "cover" → mode = "insert" (arc path)
  - Source: "screen" → fuzzy match to scene parts
  - Target: "tray"
  - Default faces: source=bottom, target=top

TOOL CALL 1: get_scene_state()
RESULT: {
  "parts": [
    { "uuid": "s1", "name": "Screen_Panel", "position": [5, 8, 0], ... },
    { "uuid": "t1", "name": "Tray_Base", "position": [0, 0, 0], ... }
  ]
}

TOOL CALL 2: compute_mate({
  source_part: "Screen_Panel",
  source_face: "bottom",
  target_part: "Tray_Base",
  target_face: "top",
  mode: "insert"
})
RESULT: {
  "success": true,
  "result_transform": {
    "position": [0, 0.8, 0],
    "quaternion": [0, 0, 0, 1]
  },
  "path": [
    { "t": 0.0,  "position": [5, 8, 0],      "quaternion": [0, 0, 0, 1] },
    { "t": 0.1,  "position": [4.5, 9.2, 0],   "quaternion": [0, 0, 0, 1] },
    { "t": 0.2,  "position": [3.8, 10.1, 0],  "quaternion": [0, 0, 0, 1] },
    { "t": 0.3,  "position": [3.0, 10.5, 0],  "quaternion": [0, 0, 0, 1] },
    { "t": 0.4,  "position": [2.2, 10.3, 0],  "quaternion": [0, 0, 0, 1] },
    { "t": 0.5,  "position": [1.5, 9.6, 0],   "quaternion": [0, 0, 0, 1] },
    { "t": 0.6,  "position": [0.9, 8.2, 0],   "quaternion": [0, 0, 0, 1] },
    { "t": 0.7,  "position": [0.4, 6.0, 0],   "quaternion": [0, 0, 0, 1] },
    { "t": 0.8,  "position": [0.15, 3.5, 0],  "quaternion": [0, 0, 0, 1] },
    { "t": 0.9,  "position": [0.05, 1.8, 0],  "quaternion": [0, 0, 0, 1] },
    { "t": 1.0,  "position": [0, 0.8, 0],     "quaternion": [0, 0, 0, 1] }
  ],
  "debug": {
    "source_frame": { "origin": [5, 8, 0], "normal": [0, -1, 0], ... },
    "target_frame": { "origin": [0, 0.8, 0], "normal": [0, 1, 0], ... },
    "arc_height": 4.8,
    "arc_type": "quadratic_bezier"
  }
}

TOOL CALL 3: preview_transform({
  part: "Screen_Panel",
  path: [...above path...],
  duration: 2.5
})
RESULT: { "success": true, "preview_id": "prev-arc-001" }
// UI shows animated arc path preview — screen lifts up, arcs over, descends into tray

TOOL CALL 4: commit_transform({
  part: "Screen_Panel",
  add_to_sequence: true,
  step_description: "Insert screen into tray"
})
RESULT: {
  "success": true,
  "final_position": [0, 0.8, 0],
  "history_id": "hist-002",
  "step_id": "step-001"
}

LLM RESPONSE TO USER:
  "Inserted Screen_Panel into Tray_Base using an arc path (like placing a cover).
   The motion arc peaks at Y=10.5 for a natural insertion feel.
   Added as animation step 'Insert screen into tray'.
   Say 'play' to preview the full sequence."
```

---

## Example 5: Twist with Axis Auto-Detection

```
USER: "twist the connector 45 degrees"

LLM REASONING:
  - Intent: TOOL_CALL (twist/rotate)
  - Part: "connector"
  - Angle: 45°
  - No axis specified → need to infer

TOOL CALL 1: get_scene_state()
RESULT: {
  "parts": [
    { "uuid": "cn1", "name": "Connector_A", "position": [0, 1.2, 0], "rotation": [0, 0, 0], ... }
  ]
}

LLM REASONING:
  - No axis specified → let compute_twist auto-determine
  - Default to Y axis (most common twist axis for "twist" command)

TOOL CALL 2: compute_twist({
  part: "Connector_A",
  axis: "y",
  angle: 45
})
RESULT: {
  "success": true,
  "result_quaternion": [0, 0.3827, 0, 0.9239],
  "computed_axis": [0, 1, 0],
  "computed_angle_deg": 45,
  "debug": {
    "original_rotation": [0, 0, 0],
    "pivot_point": [0, 1.2, 0],
    "axis_source": "explicit_y"
  }
}

TOOL CALL 3: preview_transform({
  part: "Connector_A",
  quaternion: [0, 0.3827, 0, 0.9239]
})

TOOL CALL 4: commit_transform({ part: "Connector_A" })

LLM RESPONSE TO USER:
  "Twisted Connector_A by 45° around the Y axis.
   Quaternion: (0, 0.383, 0, 0.924). Say 'undo' to revert."
```

---

## Example 6: Part Not Found → Clarification

```
USER: "move the lid"

TOOL CALL 1: get_scene_state()
RESULT: {
  "parts": [
    { "name": "Top_Cover", ... },
    { "name": "Bottom_Lid", ... },
    { "name": "Side_Panel", ... }
  ]
}

LLM REASONING:
  - "lid" matches both "Top_Cover" and "Bottom_Lid"
  - Cannot determine which one → ask user

LLM RESPONSE TO USER:
  "I found two parts that could match 'lid':
   1. **Top_Cover**
   2. **Bottom_Lid**
   Which one did you mean? Also, where should I move it?"
```

---

## Example 7: Mixed Intent (Chat + Tool)

```
USER: "what's the current position of Part1 and can you move it to the right by 2?"

LLM REASONING:
  - Intent: MIXED (query + action)
  - First: query position
  - Then: translate

TOOL CALL 1: get_part_transform({ part: "Part1" })
RESULT: {
  "success": true,
  "uuid": "p1",
  "name": "Part1",
  "position": [0, 0, 0],
  "rotation": [0, 0, 0],
  "quaternion": [0, 0, 0, 1],
  "bounding_box": { "size": [2, 1, 1.5], "center": [0, 0.5, 0], ... }
}

TOOL CALL 2: translate_part({ part: "Part1", mode: "relative", x: 2, y: 0, z: 0 })
RESULT: {
  "success": true,
  "new_position": [2, 0, 0]
}

LLM RESPONSE TO USER:
  "Part1 was at position (0, 0, 0) with bounding box size 2×1×1.5.
   I've moved it 2 units to the right — new position: (2, 0, 0)."
```

---

## Example 8: Undo Chain

```
USER: "undo"

TOOL CALL 1: undo()
RESULT: {
  "success": true,
  "action": "Reverted translate_part on Connector_A: (0, 1.2, 0) → (5, 0, 0)",
  "part_uuid": "cn1",
  "remaining": 2
}

LLM RESPONSE TO USER:
  "Undone: Connector_A moved back to (5, 0, 0). 2 more undo steps available."

---

USER: "undo again"

TOOL CALL 1: undo()
RESULT: {
  "success": true,
  "action": "Reverted align_faces (flush) on Part1",
  "remaining": 1
}

LLM RESPONSE TO USER:
  "Undone: Part1's flush alignment reverted. 1 more undo step available."

---

USER: "redo"

TOOL CALL 1: redo()
RESULT: {
  "success": true,
  "action": "Re-applied align_faces (flush) on Part1",
  "remaining": 0
}

LLM RESPONSE TO USER:
  "Redone: Part1's flush alignment re-applied."
```

---

## Example 9: Preview → Cancel Flow

```
USER: "show me what it would look like if I flip Part3 upside down"

TOOL CALL 1: compute_twist({
  part: "Part3",
  axis: "x",
  angle: 180
})
RESULT: {
  "success": true,
  "result_quaternion": [1, 0, 0, 0],
  "computed_axis": [1, 0, 0],
  "computed_angle_deg": 180
}

TOOL CALL 2: preview_transform({
  part: "Part3",
  quaternion: [1, 0, 0, 0]
})
RESULT: { "success": true, "preview_id": "prev-003" }

LLM RESPONSE TO USER:
  "Here's a preview of Part3 flipped 180° around the X axis (upside down).
   The ghost shows the new position. Say 'looks good' to apply, or 'cancel' to discard."

---

USER: "cancel"

TOOL CALL 1: cancel_preview({ part: "Part3" })
RESULT: { "success": true, "cancelled_parts": ["Part3"] }

LLM RESPONSE TO USER:
  "Preview cancelled. Part3 is back to its original orientation."
```

---

## Example 10: Complex Multi-Step Assembly

```
USER: "I want to assemble the phone. First put the battery in the case,
       then snap the screen on top, and finally close the back cover."

LLM REASONING:
  - Intent: TOOL_CALL (multi-step assembly)
  - 3 sequential mate operations
  - Each should be added as animation step

TOOL CALL 1: get_scene_state()
RESULT: {
  "parts": [
    { "name": "Battery",     "position": [10, 0, 0], ... },
    { "name": "Phone_Case",  "position": [0, 0, 0], ... },
    { "name": "Screen",      "position": [10, 5, 0], ... },
    { "name": "Back_Cover",  "position": [-5, 0, 0], ... }
  ]
}

--- Step 1: Battery into Case ---

TOOL CALL 2: compute_mate({
  source_part: "Battery",
  source_face: "bottom",
  target_part: "Phone_Case",
  target_face: "center",    // Insert into center cavity
  mode: "insert"
})
RESULT: {
  "success": true,
  "result_transform": { "position": [0, 0.3, 0], "quaternion": [0,0,0,1] },
  "path": [ ... 15 keyframes ... ]
}

TOOL CALL 3: preview_transform({ part: "Battery", path: [...], duration: 2.0 })
TOOL CALL 4: commit_transform({
  part: "Battery",
  add_to_sequence: true,
  step_description: "Insert battery into case"
})
RESULT: { "success": true, "step_id": "step-001" }

--- Step 2: Screen on top ---

TOOL CALL 5: compute_mate({
  source_part: "Screen",
  source_face: "bottom",
  target_part: "Phone_Case",
  target_face: "top",
  mode: "flush"
})
RESULT: {
  "success": true,
  "result_transform": { "position": [0, 1.0, 0], "quaternion": [0,0,0,1] }
}

TOOL CALL 6: commit_transform({
  part: "Screen",
  position: [0, 1.0, 0],
  quaternion: [0, 0, 0, 1],
  add_to_sequence: true,
  step_description: "Snap screen onto case"
})
RESULT: { "success": true, "step_id": "step-002" }

--- Step 3: Back cover ---

TOOL CALL 7: compute_mate({
  source_part: "Back_Cover",
  source_face: "front",
  target_part: "Phone_Case",
  target_face: "back",
  mode: "insert"
})
RESULT: {
  "success": true,
  "result_transform": { "position": [0, 0, -0.5], "quaternion": [0,0,0,1] },
  "path": [ ... 15 keyframes ... ]
}

TOOL CALL 8: commit_transform({
  part: "Back_Cover",
  add_to_sequence: true,
  step_description: "Close back cover"
})
RESULT: { "success": true, "step_id": "step-003" }

LLM RESPONSE TO USER:
  "Phone assembly complete! 3 steps added:
   1. Insert battery into case (arc path)
   2. Snap screen onto case (flush)
   3. Close back cover (arc path)

   Say 'play' to watch the full assembly animation!"
```

---

## Example 11: Mode Switch + Rotate via Chat

```
USER: "switch to rotate mode"

TOOL CALL 1: set_interaction_mode({ mode: "rotate" })
RESULT: { "success": true, "previous_mode": "move", "current_mode": "rotate" }

LLM RESPONSE TO USER:
  "Switched to Rotate mode. Click and drag on a part to rotate it.
   The rotation gizmo will appear on the selected part."
```

---

## Example 12: Error — Mate Part to Itself

```
USER: "align Part1 top to Part1 bottom"

TOOL CALL 1: compute_mate({
  source_part: "Part1",
  source_face: "top",
  target_part: "Part1",
  target_face: "bottom",
  mode: "flush"
})
RESULT: {
  "success": false,
  "error": "Cannot mate a part to itself.",
  "error_code": "SAME_PART"
}

LLM RESPONSE TO USER:
  "I can't mate Part1 to itself. Did you mean to align Part1 to a different part?
   Available parts: Part1, Part2, Cover. Which target did you mean?"
```

---

## Example 13: Edge-to-Edge Mate

```
USER: "align the front-top edge of Part1 to the front-top edge of Part2"

LLM REASONING:
  - "front-top edge" → intersection of front face and top face
  - Use edge_to_edge mode

TOOL CALL 1: get_face_info({ part: "Part1", face: "front" })
RESULT: { "frame": { "normal": [0, 0, 1], ... }, ... }

TOOL CALL 2: get_face_info({ part: "Part1", face: "top" })
RESULT: { "frame": { "normal": [0, 1, 0], ... }, ... }

TOOL CALL 3: get_face_info({ part: "Part2", face: "front" })
TOOL CALL 4: get_face_info({ part: "Part2", face: "top" })

LLM REASONING:
  - Edge direction = cross(front_normal, top_normal) = cross([0,0,1], [0,1,0]) = [-1,0,0] (X axis)
  - Use align_faces with edge_to_edge mode

TOOL CALL 5: align_faces({
  source_part: "Part1",
  source_face: "front",
  target_part: "Part2",
  target_face: "front",
  mode: "edge_to_edge"
})
RESULT: { "success": true, ... }

TOOL CALL 6: commit_transform({ part: "Part1" })

LLM RESPONSE TO USER:
  "Aligned the front-top edge of Part1 to Part2's front-top edge.
   Edge direction: along the X axis."
```

---

## Example 14: Twist with Snap Increment

```
USER: "rotate the lid to the nearest 90 degree position"

TOOL CALL 1: compute_twist({
  part: "Cover_Lid",
  axis: "y",
  snap_increment: 90
})
RESULT: {
  "success": true,
  "result_quaternion": [0, 0.707, 0, 0.707],
  "computed_axis": [0, 1, 0],
  "computed_angle_deg": 73,        // Raw computed angle
  "snapped_angle_deg": 90,         // Snapped to nearest 90°
  "debug": {
    "original_rotation": [0, 1.27, 0],  // ~73° in Y
    "axis_source": "explicit_y"
  }
}

TOOL CALL 2: preview_transform({
  part: "Cover_Lid",
  quaternion: [0, 0.707, 0, 0.707]
})

TOOL CALL 3: commit_transform({ part: "Cover_Lid" })

LLM RESPONSE TO USER:
  "Snapped Cover_Lid to the nearest 90° position around Y.
   Original angle was ~73°, snapped to 90°."
```

---

## Example 15: Planar Slide Constraint

```
USER: "slide Part1 along the surface of Part2's top face to position x=3"

TOOL CALL 1: align_faces({
  source_part: "Part1",
  source_face: "bottom",
  target_part: "Part2",
  target_face: "top",
  mode: "planar_slide"
})
RESULT: {
  "success": true,
  "result_position": [0, 2.0, 0],    // Y adjusted to sit on surface
  "result_quaternion": [0, 0, 0, 1]   // Rotation aligned to plane
}

TOOL CALL 2: translate_part({
  part: "Part1",
  mode: "absolute",
  x: 3, y: 2.0, z: 0    // Keep Y from planar constraint, set X=3
})
RESULT: { "success": true, "new_position": [3, 2.0, 0] }

TOOL CALL 3: commit_transform({ part: "Part1" })

LLM RESPONSE TO USER:
  "Part1 is now sliding on Part2's top surface at position (3, 2.0, 0).
   It's constrained to the plane — Y is fixed at 2.0."
```

---

## Intent Router Decision Tree

```
User Input
  │
  ├─ Quick Heuristic Match?
  │   ├─ YES → "move/rotate/twist/align/mate/put/place/insert/attach" → TOOL_CALL
  │   ├─ YES → "undo/redo/reset/select/load/play/stop/preview" → TOOL_CALL
  │   ├─ YES → "hi/hello/thanks/what is/how does/explain/why" → CHAT
  │   └─ NO → Continue to LLM
  │
  ├─ LLM Classification (if heuristic inconclusive)
  │   ├─ TOOL_CALL (confidence > 0.8) → Execute tools
  │   ├─ CHAT (confidence > 0.8) → Generate conversational reply
  │   ├─ MIXED (both intents) → Execute tools + explain in response
  │   └─ UNCLEAR (confidence < 0.6) → Ask clarification
  │
  └─ Error Recovery Loop
      ├─ PART_NOT_FOUND → Fuzzy match retry → if still fail → ask user
      ├─ NORMALS_SAME_DIRECTION → Auto flip=true → retry
      ├─ SAME_PART → Report error, ask for correct target
      ├─ COMPUTE_FAILED → Report debug info, suggest alternative
      └─ APP_DISCONNECTED → "3D app is not connected, please open it"
```
