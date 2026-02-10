# 3D Animation Studio — LLM + MCP Full Architecture Plan

> **Engine**: Three.js (via React Three Fiber + Drei)
> **State**: Zustand
> **MCP SDK**: `@modelcontextprotocol/sdk`
> **Transport**: MCP Server ↔ React App via WebSocket (existing pattern)
> **LLM**: Ollama / Gemini / OpenAI-compatible (pluggable)

---

## A. System Architecture

### A1. Module Diagram (Text)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (React App)                         │
│                                                                     │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────┐ │
│  │  Chat UI     │   │  3D Canvas   │   │  Side Panels             │ │
│  │  (input box, │   │  (R3F Scene, │   │  (Parts, Properties,     │ │
│  │   messages)  │   │   Gizmos,    │   │   Animation Studio,      │ │
│  │              │   │   Markers)   │   │   Mode Toggle)           │ │
│  └──────┬───────┘   └──────┬───────┘   └──────────┬───────────────┘ │
│         │                  │                      │                 │
│         ▼                  ▼                      ▼                 │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    Zustand Store (SceneState)                 │   │
│  │  parts{}, selection, markers, interactionMode, previewState, │   │
│  │  constraints[], history[], sequence[], uiSync                │   │
│  └──────────────────────────────┬───────────────────────────────┘   │
│                                 │                                   │
│  ┌──────────────────────────────▼───────────────────────────────┐   │
│  │              MCPBridge (WebSocket Client)                     │   │
│  │  - Receives commands from MCP Server                         │   │
│  │  - Executes against Store / Scene                            │   │
│  │  - Returns results (scene state, transform data, etc.)       │   │
│  └──────────────────────────────┬───────────────────────────────┘   │
└─────────────────────────────────┼───────────────────────────────────┘
                                  │ WebSocket (ws://localhost:3001)
┌─────────────────────────────────┼───────────────────────────────────┐
│                        MCP SERVER (Node.js)                         │
│                                                                     │
│  ┌──────────────────────────────▼───────────────────────────────┐   │
│  │              WebSocket Server (Bridge to App)                 │   │
│  │  - sendToApp(command, args) → Promise<result>                │   │
│  └──────────────────────────────┬───────────────────────────────┘   │
│                                 │                                   │
│  ┌──────────────────────────────▼───────────────────────────────┐   │
│  │              Intent Router                                    │   │
│  │  - Receives user text from Chat UI                           │   │
│  │  - Classifies: CHAT | TOOL_CALL | MIXED                     │   │
│  │  - If TOOL_CALL → calls LLM to extract tool + args          │   │
│  │  - If CHAT → calls LLM for conversational reply             │   │
│  │  - If MIXED → does both (executes + explains)               │   │
│  └──────────────────────────────┬───────────────────────────────┘   │
│                                 │                                   │
│  ┌──────────────────────────────▼───────────────────────────────┐   │
│  │              MCP Tool Registry                                │   │
│  │  - 20+ tools organized by category                           │   │
│  │  - Each tool: name, description, inputSchema, handler        │   │
│  │  - Handler calls sendToApp() or does server-side compute     │   │
│  └──────────────────────────────┬───────────────────────────────┘   │
│                                 │                                   │
│  ┌──────────────────────────────▼───────────────────────────────┐   │
│  │              Geometry Engine (Server-Side Math)                │   │
│  │  - compute_face_frame(mesh, faceId)                          │   │
│  │  - compute_mate_transform(srcFrame, tgtFrame, mode)          │   │
│  │  - generate_arc_path(start, end, hingePt, steps)             │   │
│  │  - solve_twist_angle(srcFrame, tgtFrame, axis)               │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              LLM Client (Ollama / Gemini / OpenAI)            │   │
│  │  - System prompt with tool definitions                       │   │
│  │  - Function-calling / structured output                      │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### A2. Data Flow

```
User types "put the lid on the box" in Chat UI
  │
  ▼
ChatInterface.tsx → mcpBridge.sendChatCommand("put the lid on the box")
  │
  ▼ (WebSocket)
MCP Server receives { command: 'chat_input', text: '...' }
  │
  ▼
Intent Router classifies → TOOL_CALL
  │
  ▼
LLM generates tool call plan:
  [
    { tool: "select_part", args: { name: "Lid" } },
    { tool: "get_face_info", args: { part: "Lid", face: "bottom" } },
    { tool: "get_face_info", args: { part: "Box", face: "top" } },
    { tool: "compute_mate", args: { mode: "face_to_face", ... } },
    { tool: "preview_transform", args: { ... } },
    { tool: "commit_transform", args: { ... } }
  ]
  │
  ▼
MCP Server executes tools sequentially via sendToApp()
  │
  ▼ (WebSocket)
MCPBridge receives commands → updates Zustand Store → 3D scene updates
  │
  ▼
MCP Server sends chat_response back → Chat UI shows result
```

---

## B. MCP Tool List + JSON Schema

### B1. Tool Categories & Full Specifications

#### Category 1: SELECTION

---

##### `select_part`
Select a part by name (fuzzy) or UUID.

```typescript
// TypeScript Type
interface SelectPartInput {
  name_or_uuid: string;
}
interface SelectPartOutput {
  success: boolean;
  selected: {
    uuid: string;
    name: string;
    position: [number, number, number];
    rotation: [number, number, number];
  } | null;
  error?: string;
}
```

```typescript
// Zod Schema
import { z } from 'zod';

const SelectPartInputSchema = z.object({
  name_or_uuid: z.string().describe('Part name (fuzzy matched) or UUID'),
});

const SelectPartOutputSchema = z.object({
  success: z.boolean(),
  selected: z.object({
    uuid: z.string(),
    name: z.string(),
    position: z.tuple([z.number(), z.number(), z.number()]),
    rotation: z.tuple([z.number(), z.number(), z.number()]),
  }).nullable(),
  error: z.string().optional(),
});
```

```json
{
  "name": "select_part",
  "description": "Select a part in the 3D scene by name (fuzzy match) or UUID. Returns the selected part's current transform.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name_or_uuid": {
        "type": "string",
        "description": "Part name (fuzzy matched) or exact UUID"
      }
    },
    "required": ["name_or_uuid"]
  }
}
```

---

##### `select_face`
Select a specific face on a part (by semantic direction or face index).

```typescript
interface SelectFaceInput {
  part: string;                    // name or uuid
  face: 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back' | 'center';
}

interface SelectFaceOutput {
  success: boolean;
  face_frame: {
    origin: [number, number, number];    // world-space center of face
    normal: [number, number, number];    // outward-facing normal (world)
    tangent: [number, number, number];   // U direction on face plane
    bitangent: [number, number, number]; // V direction on face plane
  };
  face_bounds: {
    width: number;
    height: number;
  };
  part_uuid: string;
  error?: string;
}
```

```typescript
const FaceDirection = z.enum(['top', 'bottom', 'left', 'right', 'front', 'back', 'center']);

const SelectFaceInputSchema = z.object({
  part: z.string().describe('Part name or UUID'),
  face: FaceDirection.describe('Semantic face direction'),
});

const FaceFrameSchema = z.object({
  origin: z.tuple([z.number(), z.number(), z.number()]),
  normal: z.tuple([z.number(), z.number(), z.number()]),
  tangent: z.tuple([z.number(), z.number(), z.number()]),
  bitangent: z.tuple([z.number(), z.number(), z.number()]),
});

const SelectFaceOutputSchema = z.object({
  success: z.boolean(),
  face_frame: FaceFrameSchema,
  face_bounds: z.object({ width: z.number(), height: z.number() }),
  part_uuid: z.string(),
  error: z.string().optional(),
});
```

```json
{
  "name": "select_face",
  "description": "Select a semantic face on a part. Returns the face's coordinate frame (origin, normal, tangent, bitangent) in world space, used for mate/align operations.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part": { "type": "string", "description": "Part name or UUID" },
      "face": {
        "type": "string",
        "enum": ["top", "bottom", "left", "right", "front", "back", "center"],
        "description": "Semantic face direction"
      }
    },
    "required": ["part", "face"]
  }
}
```

---

##### `get_selection`
Query the current selection state.

```typescript
interface GetSelectionOutput {
  selected_part: { uuid: string; name: string } | null;
  selected_faces: Array<{
    part_uuid: string;
    face: string;
    face_frame: FaceFrame;
  }>;
  interaction_mode: 'move' | 'rotate' | 'mate';
}
```

```json
{
  "name": "get_selection",
  "description": "Returns the currently selected part, any selected faces, and the current interaction mode.",
  "inputSchema": { "type": "object", "properties": {} }
}
```

---

#### Category 2: QUERY

---

##### `get_scene_state`
Returns all parts with transforms, bounding boxes.

```typescript
interface ScenePartInfo {
  uuid: string;
  name: string;
  position: [number, number, number];
  rotation: [number, number, number];   // Euler XYZ radians
  scale: [number, number, number];
  bounding_box: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
    center: [number, number, number];
  };
  color: string;
}

interface GetSceneStateOutput {
  parts: ScenePartInfo[];
  camera: {
    position: [number, number, number];
    target: [number, number, number];
  };
  interaction_mode: string;
}
```

```json
{
  "name": "get_scene_state",
  "description": "Returns complete scene state: all parts with transforms, bounding boxes, camera, and current interaction mode.",
  "inputSchema": { "type": "object", "properties": {} }
}
```

---

##### `get_face_info`
Get detailed face frame for a specific face on a part.

```typescript
interface GetFaceInfoInput {
  part: string;
  face: 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back' | 'center';
}

interface GetFaceInfoOutput {
  success: boolean;
  part_uuid: string;
  part_name: string;
  face: string;
  frame: {
    origin: [number, number, number];
    normal: [number, number, number];
    tangent: [number, number, number];
    bitangent: [number, number, number];
  };
  bounds: { width: number; height: number };
  /** Available mate modes for this face type */
  available_mate_modes: string[];
}
```

```typescript
const GetFaceInfoInputSchema = z.object({
  part: z.string().describe('Part name or UUID'),
  face: FaceDirection,
});

const GetFaceInfoOutputSchema = z.object({
  success: z.boolean(),
  part_uuid: z.string(),
  part_name: z.string(),
  face: z.string(),
  frame: FaceFrameSchema,
  bounds: z.object({ width: z.number(), height: z.number() }),
  available_mate_modes: z.array(z.string()),
});
```

```json
{
  "name": "get_face_info",
  "description": "Get the coordinate frame (origin, normal, tangent, bitangent) for a semantic face on a part. Also returns which mate modes are available for this face.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part": { "type": "string", "description": "Part name or UUID" },
      "face": {
        "type": "string",
        "enum": ["top", "bottom", "left", "right", "front", "back", "center"]
      }
    },
    "required": ["part", "face"]
  }
}
```

---

##### `get_part_transform`
Get a single part's full transform info.

```json
{
  "name": "get_part_transform",
  "description": "Returns the full transform (position, rotation, scale, world matrix) and bounding box for a specific part.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part": { "type": "string", "description": "Part name or UUID" }
    },
    "required": ["part"]
  }
}
```

---

#### Category 3: ACTION (Transform)

---

##### `translate_part`
Move a part by a delta or to an absolute position.

```typescript
interface TranslatePartInput {
  part: string;
  mode: 'absolute' | 'relative';
  x: number;
  y: number;
  z: number;
  /** If true, apply as preview (can be cancelled). Default: false */
  preview?: boolean;
}
```

```typescript
const TranslatePartInputSchema = z.object({
  part: z.string(),
  mode: z.enum(['absolute', 'relative']).default('relative'),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  preview: z.boolean().default(false),
});
```

```json
{
  "name": "translate_part",
  "description": "Move a part. mode='relative' adds delta to current position. mode='absolute' sets exact position. Set preview=true to preview without committing.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part": { "type": "string" },
      "mode": { "type": "string", "enum": ["absolute", "relative"], "default": "relative" },
      "x": { "type": "number" },
      "y": { "type": "number" },
      "z": { "type": "number" },
      "preview": { "type": "boolean", "default": false }
    },
    "required": ["part", "x", "y", "z"]
  }
}
```

---

##### `rotate_part`
Rotate a part around an axis by an angle.

```typescript
interface RotatePartInput {
  part: string;
  /** Rotation axis. 'x'|'y'|'z' for world axes, or [nx,ny,nz] for arbitrary */
  axis: 'x' | 'y' | 'z' | [number, number, number];
  /** Angle in degrees */
  angle: number;
  /** Pivot point in world space. Default: part center */
  pivot?: [number, number, number];
  /** If true, set absolute Euler rotation instead of incremental */
  absolute?: boolean;
  preview?: boolean;
}
```

```typescript
const RotatePartInputSchema = z.object({
  part: z.string(),
  axis: z.union([
    z.enum(['x', 'y', 'z']),
    z.tuple([z.number(), z.number(), z.number()]),
  ]),
  angle: z.number().describe('Angle in degrees'),
  pivot: z.tuple([z.number(), z.number(), z.number()]).optional(),
  absolute: z.boolean().default(false),
  preview: z.boolean().default(false),
});
```

```json
{
  "name": "rotate_part",
  "description": "Rotate a part around an axis by a given angle (degrees). Can specify pivot point and arbitrary axis direction.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part": { "type": "string" },
      "axis": {
        "oneOf": [
          { "type": "string", "enum": ["x", "y", "z"] },
          { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3 }
        ]
      },
      "angle": { "type": "number", "description": "Degrees" },
      "pivot": { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3 },
      "absolute": { "type": "boolean", "default": false },
      "preview": { "type": "boolean", "default": false }
    },
    "required": ["part", "axis", "angle"]
  }
}
```

---

##### `align_faces`
Align source face to target face (the core mate building block).

```typescript
interface AlignFacesInput {
  source_part: string;
  source_face: FaceDirection;
  target_part: string;
  target_face: FaceDirection;
  /** Mate mode determines how faces align */
  mode: 'flush' | 'insert' | 'edge_to_edge' | 'axis_to_axis' | 'point_to_point';
  /** Normal offset distance (gap/clearance). Default: 0 */
  offset?: number;
  /** Flip source normal (rotate 180 around tangent). Default: false */
  flip?: boolean;
  /** Additional twist angle around the aligned normal axis (degrees). Default: 0 */
  twist_angle?: number;
  /** Only preview, don't commit. Default: false */
  preview?: boolean;
}
```

```typescript
const MateMode = z.enum([
  'flush',           // face-to-face, normals opposing, surfaces touching
  'insert',          // face-to-face with arc path (cover/insert motion)
  'edge_to_edge',    // align edges
  'axis_to_axis',    // cylindrical mate
  'point_to_point',  // align centers
  'planar_slide',    // constrain to plane, free to slide
]);

const AlignFacesInputSchema = z.object({
  source_part: z.string(),
  source_face: FaceDirection,
  target_part: z.string(),
  target_face: FaceDirection,
  mode: MateMode,
  offset: z.number().default(0),
  flip: z.boolean().default(false),
  twist_angle: z.number().default(0),
  preview: z.boolean().default(false),
});
```

```json
{
  "name": "align_faces",
  "description": "Core mate operation: align source face to target face with the specified mate mode. Supports offset, flip, and twist angle. Use preview=true to see result before committing.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "source_part": { "type": "string" },
      "source_face": { "type": "string", "enum": ["top", "bottom", "left", "right", "front", "back", "center"] },
      "target_part": { "type": "string" },
      "target_face": { "type": "string", "enum": ["top", "bottom", "left", "right", "front", "back", "center"] },
      "mode": { "type": "string", "enum": ["flush", "insert", "edge_to_edge", "axis_to_axis", "point_to_point", "planar_slide"] },
      "offset": { "type": "number", "default": 0 },
      "flip": { "type": "boolean", "default": false },
      "twist_angle": { "type": "number", "default": 0, "description": "Extra twist in degrees around aligned normal" },
      "preview": { "type": "boolean", "default": false }
    },
    "required": ["source_part", "source_face", "target_part", "target_face", "mode"]
  }
}
```

---

#### Category 4: PREVIEW & COMMIT

---

##### `preview_transform`
Apply a pending transform as preview (ghosted/wireframe). The transform is NOT committed.

```typescript
interface PreviewTransformInput {
  part: string;
  position?: [number, number, number];
  rotation?: [number, number, number];  // Euler XYZ radians
  quaternion?: [number, number, number, number];  // alternative to rotation
  /** Path keyframes for animated preview */
  path?: Array<{
    t: number;  // 0..1
    position: [number, number, number];
    quaternion: [number, number, number, number];
  }>;
  /** Duration in seconds for path animation preview */
  duration?: number;
}
```

```typescript
const PreviewTransformInputSchema = z.object({
  part: z.string(),
  position: z.tuple([z.number(), z.number(), z.number()]).optional(),
  rotation: z.tuple([z.number(), z.number(), z.number()]).optional(),
  quaternion: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  path: z.array(z.object({
    t: z.number().min(0).max(1),
    position: z.tuple([z.number(), z.number(), z.number()]),
    quaternion: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  })).optional(),
  duration: z.number().default(2.0),
});
```

```json
{
  "name": "preview_transform",
  "description": "Show a preview of a transform on a part (ghosted/wireframe). Supports single pose or animated path. Does NOT commit the change. Call commit_transform to apply or cancel_preview to discard.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part": { "type": "string" },
      "position": { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3 },
      "rotation": { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3 },
      "quaternion": { "type": "array", "items": { "type": "number" }, "minItems": 4, "maxItems": 4 },
      "path": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "t": { "type": "number" },
            "position": { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3 },
            "quaternion": { "type": "array", "items": { "type": "number" }, "minItems": 4, "maxItems": 4 }
          },
          "required": ["t", "position", "quaternion"]
        }
      },
      "duration": { "type": "number", "default": 2.0 }
    },
    "required": ["part"]
  }
}
```

---

##### `commit_transform`
Commit the previewed transform (or commit a direct transform).

```json
{
  "name": "commit_transform",
  "description": "Commit the currently previewed transform for a part. If no preview is active, applies the given position/rotation directly. Pushes to undo history.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part": { "type": "string" },
      "position": { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3 },
      "rotation": { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3 },
      "quaternion": { "type": "array", "items": { "type": "number" }, "minItems": 4, "maxItems": 4 },
      "add_to_sequence": { "type": "boolean", "default": false, "description": "Also record as animation step" },
      "step_description": { "type": "string" }
    },
    "required": ["part"]
  }
}
```

---

##### `cancel_preview`
Cancel the current preview, restoring original transform.

```json
{
  "name": "cancel_preview",
  "description": "Cancel the active preview and restore the part to its pre-preview state.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part": { "type": "string", "description": "Part to cancel preview for. If omitted, cancels all active previews." }
    }
  }
}
```

---

#### Category 5: COMPUTE (Server-Side Math)

---

##### `compute_mate`
Compute the target transform for a mate operation (does NOT apply it).

```typescript
interface ComputeMateInput {
  source_part: string;
  source_face: FaceDirection;
  target_part: string;
  target_face: FaceDirection;
  mode: MateMode;
  offset?: number;
  flip?: boolean;
  twist_angle?: number;
}

interface ComputeMateOutput {
  success: boolean;
  /** The final transform for the source part */
  result_transform: {
    position: [number, number, number];
    quaternion: [number, number, number, number];
  };
  /** Debug info */
  debug: {
    source_frame: FaceFrame;
    target_frame: FaceFrame;
    rotation_quaternion: [number, number, number, number];
    translation_vector: [number, number, number];
    twist_axis: [number, number, number];
    twist_angle_deg: number;
  };
  /** For 'insert' mode: the arc path */
  path?: Array<{
    t: number;
    position: [number, number, number];
    quaternion: [number, number, number, number];
  }>;
  error?: string;
}
```

```json
{
  "name": "compute_mate",
  "description": "Compute the transform needed to mate source_face to target_face. Returns the result transform and debug info (frames, axes, angles). Does NOT apply the transform — use preview_transform or commit_transform after.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "source_part": { "type": "string" },
      "source_face": { "type": "string", "enum": ["top", "bottom", "left", "right", "front", "back", "center"] },
      "target_part": { "type": "string" },
      "target_face": { "type": "string", "enum": ["top", "bottom", "left", "right", "front", "back", "center"] },
      "mode": { "type": "string", "enum": ["flush", "insert", "edge_to_edge", "axis_to_axis", "point_to_point", "planar_slide"] },
      "offset": { "type": "number", "default": 0 },
      "flip": { "type": "boolean", "default": false },
      "twist_angle": { "type": "number", "default": 0 }
    },
    "required": ["source_part", "source_face", "target_part", "target_face", "mode"]
  }
}
```

---

##### `compute_twist`
Compute a rotation-only transform to twist/align the source part around a given axis.

```typescript
interface ComputeTwistInput {
  part: string;
  /** Axis to twist around. Auto-infers from face normal if omitted. */
  axis?: 'x' | 'y' | 'z' | 'face_normal' | [number, number, number];
  /** Target angle in degrees. If omitted, auto-computes best alignment. */
  angle?: number;
  /** Reference face for auto-alignment */
  reference_face?: FaceDirection;
  /** Constrain to increments (e.g. 90 for 90-degree snapping). 0 = free. */
  snap_increment?: number;
}

interface ComputeTwistOutput {
  success: boolean;
  result_quaternion: [number, number, number, number];
  computed_axis: [number, number, number];
  computed_angle_deg: number;
  /** If snap was applied */
  snapped_angle_deg?: number;
  debug: {
    original_rotation: [number, number, number];
    pivot_point: [number, number, number];
  };
}
```

```json
{
  "name": "compute_twist",
  "description": "Compute a rotation (twist) for a part around a specified or auto-inferred axis. Supports arbitrary angles, snap increments, and auto-alignment to a reference face.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part": { "type": "string" },
      "axis": {
        "oneOf": [
          { "type": "string", "enum": ["x", "y", "z", "face_normal"] },
          { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3 }
        ]
      },
      "angle": { "type": "number", "description": "Target twist angle in degrees" },
      "reference_face": { "type": "string", "enum": ["top", "bottom", "left", "right", "front", "back", "center"] },
      "snap_increment": { "type": "number", "default": 0 }
    },
    "required": ["part"]
  }
}
```

---

#### Category 6: HISTORY

---

##### `undo`
```json
{
  "name": "undo",
  "description": "Undo the last committed transform. Returns the action that was undone.",
  "inputSchema": { "type": "object", "properties": {} }
}
```

##### `redo`
```json
{
  "name": "redo",
  "description": "Redo the last undone transform.",
  "inputSchema": { "type": "object", "properties": {} }
}
```

---

#### Category 7: MODE

---

##### `set_interaction_mode`
```typescript
const SetInteractionModeInputSchema = z.object({
  mode: z.enum(['move', 'rotate', 'mate']),
});
```

```json
{
  "name": "set_interaction_mode",
  "description": "Set the current 3D interaction mode. 'move' enables translate gizmo on click-drag, 'rotate' enables rotate gizmo, 'mate' enables face-picking for mate operations.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "mode": { "type": "string", "enum": ["move", "rotate", "mate"] }
    },
    "required": ["mode"]
  }
}
```

---

#### Category 8: SEQUENCE / ANIMATION

---

##### `add_animation_step`
```json
{
  "name": "add_animation_step",
  "description": "Add an animation step to the sequence. Captures current part position as start, and specified target as end.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part": { "type": "string" },
      "target_position": { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3 },
      "target_quaternion": { "type": "array", "items": { "type": "number" }, "minItems": 4, "maxItems": 4 },
      "duration": { "type": "number", "default": 2.0 },
      "easing": { "type": "string", "enum": ["linear", "easeIn", "easeOut", "easeInOut"], "default": "easeInOut" },
      "path": { "type": "array", "items": { "type": "object" } },
      "description": { "type": "string" }
    },
    "required": ["part", "description"]
  }
}
```

##### `play_animation`
```json
{
  "name": "play_animation",
  "description": "Play the full animation sequence or a single step preview.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "mode": { "type": "string", "enum": ["sequence", "single_step"], "default": "sequence" },
      "step_index": { "type": "number", "description": "For single_step mode, which step to play" }
    }
  }
}
```

##### `stop_animation`
```json
{
  "name": "stop_animation",
  "description": "Stop any currently playing animation.",
  "inputSchema": { "type": "object", "properties": {} }
}
```

---

#### Category 9: SCENE MANAGEMENT

---

##### `reset_scene`
```json
{
  "name": "reset_scene",
  "description": "Reset all parts to their initial positions. Clears selection and stops animation.",
  "inputSchema": { "type": "object", "properties": {} }
}
```

##### `reset_part`
```json
{
  "name": "reset_part",
  "description": "Reset a specific part to its initial position.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part": { "type": "string" }
    },
    "required": ["part"]
  }
}
```

##### `load_model`
```json
{
  "name": "load_model",
  "description": "Load a 3D model file into the scene.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "url": { "type": "string", "description": "URL or path to the model file" },
      "filename": { "type": "string" }
    },
    "required": ["url"]
  }
}
```

---

#### Category 10: UI STATE SYNC

---

##### `get_ui_state`
```json
{
  "name": "get_ui_state",
  "description": "Get current UI state: active previews, interaction mode, animation status, connection status.",
  "inputSchema": { "type": "object", "properties": {} }
}
```

##### `set_environment`
```json
{
  "name": "set_environment",
  "description": "Change the 3D environment preset and floor style.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "preset": { "type": "string", "enum": ["warehouse", "city", "sunset", "studio", "night", "apartment", "forest", "dawn", "lobby", "park"] },
      "floor": { "type": "string", "enum": ["grid", "reflective", "none"] }
    }
  }
}
```

---

### B2. Error Codes

| Code | Meaning |
|------|---------|
| `PART_NOT_FOUND` | Part name/UUID doesn't match any scene object |
| `FACE_NOT_FOUND` | Could not compute face frame for given direction |
| `NO_SELECTION` | Operation requires a selection but none exists |
| `PREVIEW_ACTIVE` | A preview is already active; commit or cancel first |
| `NO_PREVIEW` | Tried to commit/cancel but no preview is active |
| `INVALID_AXIS` | Axis vector is zero-length or invalid |
| `HISTORY_EMPTY` | Nothing to undo/redo |
| `ANIMATION_PLAYING` | Cannot modify scene while animation is playing |
| `APP_DISCONNECTED` | WebSocket to React app is not connected |
| `COMPUTE_FAILED` | Math computation failed (degenerate geometry, etc.) |

---

## C. LLM MCP Usage Docs (System Prompt for Model)

```markdown
# 3D Animation Studio — MCP Tool Usage Guide

You are an AI assistant controlling a 3D CAD assembly studio. You help users
manipulate 3D parts, create assembly animations, and answer questions about the scene.

## How You Work
1. User sends natural language text
2. You analyze intent: conversation, tool operation, or both
3. For tool operations, call MCP tools in the correct sequence
4. Report results back to the user in natural language

## Available Tools (Summary)

### Selection
- `select_part(name_or_uuid)` — Select a part
- `select_face(part, face)` — Select a face for mate operations
- `get_selection()` — Query current selection

### Query
- `get_scene_state()` — List all parts and transforms
- `get_face_info(part, face)` — Get face coordinate frame
- `get_part_transform(part)` — Get single part transform

### Transform
- `translate_part(part, mode, x, y, z, preview?)` — Move a part
- `rotate_part(part, axis, angle, pivot?, preview?)` — Rotate a part
- `align_faces(source_part, source_face, target_part, target_face, mode, ...)` — Mate faces

### Compute (Math Only, No Side Effects)
- `compute_mate(source_part, source_face, target_part, target_face, mode, ...)` — Calculate mate transform
- `compute_twist(part, axis?, angle?, ...)` — Calculate twist rotation

### Preview & Commit
- `preview_transform(part, position?, rotation?, path?)` — Show preview
- `commit_transform(part, ...)` — Apply previewed transform
- `cancel_preview(part?)` — Discard preview

### History
- `undo()` / `redo()`

### Mode
- `set_interaction_mode(mode)` — Switch between 'move', 'rotate', 'mate'

### Animation
- `add_animation_step(part, target_position?, target_quaternion?, duration?, description)`
- `play_animation(mode?)` / `stop_animation()`

### Scene
- `reset_scene()` / `reset_part(part)` / `load_model(url)`

### UI
- `get_ui_state()` / `set_environment(preset?, floor?)`

## Tool Call Sequences

### Sequence 1: Simple Move
```
User: "Move the lid up by 2 units"
→ get_scene_state()                          # Find "Lid" part
→ translate_part(part="Lid", mode="relative", x=0, y=2, z=0)
```

### Sequence 2: Face-to-Face Mate (Flush)
```
User: "Put the lid on top of the box"
→ get_scene_state()                          # Find parts
→ get_face_info(part="Lid", face="bottom")   # Source face
→ get_face_info(part="Box", face="top")      # Target face
→ compute_mate(
    source_part="Lid", source_face="bottom",
    target_part="Box", target_face="top",
    mode="flush"
  )
→ preview_transform(part="Lid", position=..., quaternion=...)
→ commit_transform(part="Lid")               # User confirmed
```

### Sequence 3: Insert/Cover (Both Mode — Arc Path)
```
User: "Insert the screen into the tray"
→ get_face_info(part="Screen", face="bottom")
→ get_face_info(part="Tray", face="top")
→ compute_mate(
    source_part="Screen", source_face="bottom",
    target_part="Tray", target_face="top",
    mode="insert"
  )
# Returns path[] with arc trajectory
→ preview_transform(part="Screen", path=[...], duration=2.0)
→ commit_transform(part="Screen", add_to_sequence=true, step_description="Insert screen")
```

### Sequence 4: Twist / Rotate Alignment
```
User: "Twist the connector 45 degrees"
→ compute_twist(part="Connector", axis="y", angle=45)
→ preview_transform(part="Connector", quaternion=[...])
→ commit_transform(part="Connector")
```

### Sequence 5: Error Recovery — Wrong Normal Direction
```
User: "Mate Part1 bottom to Part2 top"
→ compute_mate(..., mode="flush")
# Returns error: NORMALS_SAME_DIRECTION (both pointing up)
→ compute_mate(..., mode="flush", flip=true)  # Auto-retry with flip
→ preview_transform(...)
→ commit_transform(...)
# Tell user: "The normals were pointing the same way, I flipped the source to fix it."
```

### Sequence 6: Auto-Correct Part Name
```
User: "move the conector to the base"
→ get_scene_state()
# Parts: ["Connector_A", "Base_Plate", "Cover"]
# Fuzzy match: "conector" → "Connector_A", "base" → "Base_Plate"
→ translate_part(part="Connector_A", ...)
```

## Constraints & Rules

1. **Always call `get_scene_state()` first** if you don't know what parts exist.
2. **Fuzzy match part names** — users may misspell. Match against known parts.
3. **Preview before commit** for destructive operations (mate, large moves).
4. **Auto-flip normals** if compute_mate returns NORMALS_SAME_DIRECTION.
5. **Auto-infer faces** when user doesn't specify:
   - "put X on Y" → source_face=bottom, target_face=top
   - "attach X to side of Y" → source_face=right, target_face=left
   - "insert X into Y" → mode=insert, source_face=bottom, target_face=top
6. **Never modify two parts simultaneously** without explicit instruction.
7. **Report computed values** (axis, angle, frames) for debugging.
8. **Sequence**: For multi-step assembly, add each mate as an animation step.
```

---

## D. Intent Router Design

### D1. Classification Strategy

```typescript
type IntentClass = 'CHAT' | 'TOOL_CALL' | 'MIXED' | 'CLARIFY';

interface IntentResult {
  class: IntentClass;
  confidence: number;    // 0-1
  tool_calls?: ToolCall[];
  chat_response?: string;
  clarification_question?: string;
}
```

### D2. Two-Phase Router

**Phase 1: Fast Heuristic Pre-Filter** (no LLM call)

```typescript
function quickClassify(input: string): IntentClass | null {
  const lower = input.toLowerCase().trim();

  // Definite TOOL patterns
  const toolPatterns = [
    /^(move|rotate|twist|align|mate|put|place|insert|attach|flip|undo|redo|reset|select|load|play|stop|preview)\b/,
    /\bto\b.*\b(top|bottom|left|right|front|back)\b/,
    /\b(part\d|Part_)/i,
  ];
  if (toolPatterns.some(p => p.test(lower))) return 'TOOL_CALL';

  // Definite CHAT patterns
  const chatPatterns = [
    /^(hi|hello|hey|thanks|thank you|what is|how does|explain|why|can you|help)\b/,
    /\?$/,  // Questions are usually chat
  ];
  if (chatPatterns.some(p => p.test(lower))) return 'CHAT';

  return null; // Ambiguous → use LLM
}
```

**Phase 2: LLM Classification** (only if Phase 1 returns null)

```
System: You are a classifier. Given user input and available tools,
output JSON: { "class": "CHAT"|"TOOL_CALL"|"MIXED", "reasoning": "..." }
If TOOL_CALL or MIXED, also output the tool calls as structured data.
```

### D3. Fallback & Safety

| Scenario | Action |
|----------|--------|
| Confidence < 0.6 | Ask clarification: "Did you mean to [X] or were you asking about [Y]?" |
| Part name unresolvable | "I found parts [A, B, C]. Which one did you mean by 'lid'?" |
| Multiple valid interpretations | Present options: "I can either (1) move Part1 to Part2, or (2) align their faces. Which?" |
| Tool returns error | Auto-retry with fix (flip, re-select) up to 2 times, then report to user |
| Animation playing | Queue command or ask "Animation is playing. Stop it first?" |

---

## E. Scene State Model

### E1. Extended Zustand Store Shape

```typescript
interface SceneState {
  // ── Parts ──
  parts: Record<string, PartData>;
  selectedPartId: string | null;

  // ── Face Selection ──
  selectedFaces: Array<{
    partUuid: string;
    face: FaceDirection;
    frame: FaceFrame;
  }>;

  // ── Interaction Mode ──
  interactionMode: 'move' | 'rotate' | 'mate';

  // ── Preview State ──
  previewState: {
    active: boolean;
    partUuid: string | null;
    originalTransform: {
      position: [number, number, number];
      rotation: [number, number, number];
    } | null;
    previewTransform: {
      position: [number, number, number];
      quaternion: [number, number, number, number];
    } | null;
    path: PathKeyframe[] | null;
    isAnimating: boolean;
  };

  // ── Constraints (Mates) ──
  constraints: Array<{
    id: string;
    type: MateMode;
    sourcePart: string;
    sourceface: FaceDirection;
    targetPart: string;
    targetFace: FaceDirection;
    offset: number;
    twistAngle: number;
  }>;

  // ── History (Undo/Redo) ──
  history: {
    undoStack: HistoryEntry[];
    redoStack: HistoryEntry[];
  };

  // ── Animation Sequence ──
  sequence: AnimationStep[];
  isSequencePlaying: boolean;
  currentStepIndex: number;

  // (existing fields: markers, camera, environment, etc.)
}

interface HistoryEntry {
  id: string;
  timestamp: number;
  description: string;
  partUuid: string;
  before: { position: [number, number, number]; rotation: [number, number, number] };
  after: { position: [number, number, number]; rotation: [number, number, number] };
}

interface PathKeyframe {
  t: number;  // 0..1
  position: [number, number, number];
  quaternion: [number, number, number, number];
}
```

---

## F. Twist / Both / Mate Modes — Algorithm Design

### F1. Building a Face Frame (Local Coordinate System)

Given a mesh and a semantic face direction (top/bottom/left/right/front/back):

```typescript
function computeFaceFrame(
  mesh: THREE.Mesh,
  face: FaceDirection
): FaceFrame {
  // 1. Compute OBB (oriented bounding box) of the mesh
  const obb = computeSmartOBB(mesh);  // existing OBBUtils

  // 2. Map face direction to OBB axis
  //    OBB has 3 axes (columns of basis matrix) + center + halfSizes
  //    top/bottom → Y axis, left/right → X axis, front/back → Z axis
  const { center, size, basis } = obb;

  // Extract OBB axes (columns of basis rotation matrix)
  const axisX = new THREE.Vector3().setFromMatrixColumn(basis, 0).normalize();
  const axisY = new THREE.Vector3().setFromMatrixColumn(basis, 1).normalize();
  const axisZ = new THREE.Vector3().setFromMatrixColumn(basis, 2).normalize();

  let normal: THREE.Vector3;
  let tangent: THREE.Vector3;
  let bitangent: THREE.Vector3;
  let faceCenter: THREE.Vector3;
  const halfSize = size.clone().multiplyScalar(0.5);

  switch (face) {
    case 'top':
      normal = axisY.clone();
      tangent = axisX.clone();
      bitangent = axisZ.clone();
      faceCenter = center.clone().add(axisY.clone().multiplyScalar(halfSize.y));
      break;
    case 'bottom':
      normal = axisY.clone().negate();
      tangent = axisX.clone();
      bitangent = axisZ.clone().negate();  // Flip to maintain right-hand rule
      faceCenter = center.clone().add(axisY.clone().multiplyScalar(-halfSize.y));
      break;
    case 'left':
      normal = axisX.clone().negate();
      tangent = axisZ.clone();
      bitangent = axisY.clone();
      faceCenter = center.clone().add(axisX.clone().multiplyScalar(-halfSize.x));
      break;
    case 'right':
      normal = axisX.clone();
      tangent = axisZ.clone().negate();
      bitangent = axisY.clone();
      faceCenter = center.clone().add(axisX.clone().multiplyScalar(halfSize.x));
      break;
    case 'front':
      normal = axisZ.clone();
      tangent = axisX.clone();
      bitangent = axisY.clone();
      faceCenter = center.clone().add(axisZ.clone().multiplyScalar(halfSize.z));
      break;
    case 'back':
      normal = axisZ.clone().negate();
      tangent = axisX.clone().negate();
      bitangent = axisY.clone();
      faceCenter = center.clone().add(axisZ.clone().multiplyScalar(-halfSize.z));
      break;
    case 'center':
      normal = axisY.clone();  // Default up
      tangent = axisX.clone();
      bitangent = axisZ.clone();
      faceCenter = center.clone();
      break;
  }

  // 3. Transform to world space
  const worldMatrix = mesh.matrixWorld;
  const worldOrigin = faceCenter.applyMatrix4(worldMatrix);
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(worldMatrix);
  const worldNormal = normal.applyMatrix3(normalMatrix).normalize();
  const worldTangent = tangent.applyMatrix3(normalMatrix).normalize();
  const worldBitangent = bitangent.applyMatrix3(normalMatrix).normalize();

  return {
    origin: [worldOrigin.x, worldOrigin.y, worldOrigin.z],
    normal: [worldNormal.x, worldNormal.y, worldNormal.z],
    tangent: [worldTangent.x, worldTangent.y, worldTangent.z],
    bitangent: [worldBitangent.x, worldBitangent.y, worldBitangent.z],
  };
}
```

### F2. Mate Modes — Full Specification

#### Mode 1: `flush` (Face-to-Face, Flush Contact)

**User selects**: source part + face, target part + face
**Goal**: Source face normal opposes target face normal, face centers coincide (+ offset along normal).

```
Required Rotation: R such that R * srcNormal = -tgtNormal
Required Translation: T = tgtOrigin + offset * tgtNormal - R * srcOrigin
Path: Straight line (lerp position, slerp rotation)
Adjustable: offset, twist_angle (rotation around aligned normal)
```

**Algorithm**:
```typescript
function computeFlushMate(
  srcFrame: FaceFrame,
  tgtFrame: FaceFrame,
  offset: number,
  twistAngle: number  // degrees
): { position: Vec3, quaternion: Quat } {
  const srcN = new THREE.Vector3(...srcFrame.normal);
  const tgtN = new THREE.Vector3(...tgtFrame.normal);

  // Step 1: Rotation to oppose normals (srcN → -tgtN)
  const qAlign = new THREE.Quaternion().setFromUnitVectors(srcN, tgtN.clone().negate());

  // Step 2: Apply twist around the aligned normal
  if (twistAngle !== 0) {
    const qTwist = new THREE.Quaternion().setFromAxisAngle(
      tgtN.clone().negate(),  // twist axis = aligned normal
      THREE.MathUtils.degToRad(twistAngle)
    );
    qAlign.premultiply(qTwist);
  }

  // Step 3: Compute position
  const srcOrigin = new THREE.Vector3(...srcFrame.origin);
  const tgtOrigin = new THREE.Vector3(...tgtFrame.origin);
  const rotatedSrcOrigin = srcOrigin.clone().applyQuaternion(qAlign);

  // Translation: move so rotated source origin lands on target + offset
  const offsetVec = tgtN.clone().multiplyScalar(offset);
  const translation = tgtOrigin.clone().add(offsetVec).sub(rotatedSrcOrigin);

  return {
    position: [translation.x, translation.y, translation.z],
    quaternion: [qAlign.x, qAlign.y, qAlign.z, qAlign.w],
  };
}
```

---

#### Mode 2: `insert` (Face-to-Face, Arc Path — "Both" Mode)

Same alignment as `flush`, but the motion path is an arc (not straight line).

**Path Generation — Circular Arc via Hinge Point**:

```typescript
function generateArcPath(
  startPos: THREE.Vector3,
  startQuat: THREE.Quaternion,
  endPos: THREE.Vector3,
  endQuat: THREE.Quaternion,
  arcHeight: number,  // How high the arc goes (auto-computed from distance)
  steps: number = 20
): PathKeyframe[] {
  const path: PathKeyframe[] = [];

  // Compute hinge point: midpoint raised along Y (or normal direction)
  const midpoint = startPos.clone().lerp(endPos, 0.5);
  const distance = startPos.distanceTo(endPos);
  const height = arcHeight || distance * 0.6;  // Default: 60% of travel distance

  // Determine arc direction: perpendicular to travel direction and gravity
  const travelDir = endPos.clone().sub(startPos).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  let arcDir = new THREE.Vector3().crossVectors(travelDir, up);
  if (arcDir.length() < 0.01) {
    // Travel is vertical — use world X as fallback
    arcDir = new THREE.Vector3(1, 0, 0);
  }
  arcDir.normalize();

  // Use quadratic Bezier: P0 = start, P1 = control (raised midpoint), P2 = end
  const control = midpoint.clone().add(up.clone().multiplyScalar(height));

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;

    // Quadratic Bezier position
    const oneMinusT = 1 - t;
    const pos = new THREE.Vector3()
      .addScaledVector(startPos, oneMinusT * oneMinusT)
      .addScaledVector(control, 2 * oneMinusT * t)
      .addScaledVector(endPos, t * t);

    // SLERP rotation
    const quat = new THREE.Quaternion().slerpQuaternions(startQuat, endQuat, t);

    path.push({
      t,
      position: [pos.x, pos.y, pos.z],
      quaternion: [quat.x, quat.y, quat.z, quat.w],
    });
  }

  return path;
}
```

**Why Bezier Arc + SLERP**:
- Quadratic Bezier gives a smooth, natural "lift up → come down" motion
- SLERP ensures continuous, non-gimbal-lock rotation interpolation
- The control point height is proportional to travel distance → natural look
- Much simpler than screw motion, and works for arbitrary orientations

---

#### Mode 3: `edge_to_edge`

**User selects**: source part + edge (approximated by 2 faces), target part + edge
**Implementation**: Align the intersection line of two adjacent faces.

```
Approximation: User selects two faces per part (e.g., "top" + "front" = top-front edge).
The edge direction = cross(face1_normal, face2_normal).
The edge point = intersection of face planes at the edge.

Rotation: align source_edge_dir to target_edge_dir
Translation: align edge midpoints
```

---

#### Mode 4: `axis_to_axis` (Cylindrical Mate)

**User selects**: source axis (typically center axis of cylindrical part), target axis
**Goal**: Align axes, free to slide along axis and rotate around it.

```
Rotation: R such that R * srcAxis = tgtAxis
Translation: project source center onto target axis line
Parameters: offset_along_axis, twist_angle
```

---

#### Mode 5: `point_to_point`

**User selects**: source point (face center), target point (face center)
**Goal**: Coincide two points, no rotation change.

```
Translation only: T = tgtPoint - srcPoint
No rotation applied (preserves current orientation)
```

---

#### Mode 6: `planar_slide`

**User selects**: source face, target face (must be parallel)
**Goal**: Source face plane coincides with target face plane, free to slide in-plane.

```
Rotation: align normals (same as flush)
Translation: only along normal to bring planes together
In-plane position preserved (or specified by user)
```

---

### F3. Twist Algorithm — Fixed & Generalized

```typescript
function computeTwist(
  mesh: THREE.Mesh,
  axis: THREE.Vector3 | 'x' | 'y' | 'z' | 'face_normal',
  angle?: number,           // degrees, if not provided → auto-align
  referenceFace?: FaceDirection,
  snapIncrement?: number     // 0 = no snap
): {
  quaternion: THREE.Quaternion;
  computedAxis: THREE.Vector3;
  computedAngle: number;     // degrees
} {
  // 1. Resolve axis
  let twistAxis: THREE.Vector3;
  if (typeof axis === 'string') {
    switch (axis) {
      case 'x': twistAxis = new THREE.Vector3(1, 0, 0); break;
      case 'y': twistAxis = new THREE.Vector3(0, 1, 0); break;
      case 'z': twistAxis = new THREE.Vector3(0, 0, 1); break;
      case 'face_normal':
        if (!referenceFace) throw new Error('face_normal axis requires referenceFace');
        const frame = computeFaceFrame(mesh, referenceFace);
        twistAxis = new THREE.Vector3(...frame.normal);
        break;
    }
  } else {
    twistAxis = axis.clone().normalize();
  }

  if (twistAxis.length() < 0.001) {
    throw new Error('INVALID_AXIS: twist axis is zero-length');
  }

  // 2. Determine angle
  let twistAngle: number;
  if (angle !== undefined) {
    twistAngle = angle;
  } else {
    // Auto-align: find the smallest rotation around twistAxis that aligns
    // the mesh's current tangent to a world-aligned direction
    // This is useful for "auto-snap" behavior
    const currentForward = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.quaternion);
    const projected = currentForward.clone().projectOnPlane(twistAxis).normalize();
    const worldRef = findBestWorldRef(twistAxis);  // e.g., world X if twist is Y
    twistAngle = THREE.MathUtils.radToDeg(
      Math.atan2(
        projected.clone().cross(worldRef).dot(twistAxis),
        projected.dot(worldRef)
      )
    );
    twistAngle = -twistAngle; // Negate to go TO the reference, not away
  }

  // 3. Apply snap
  if (snapIncrement && snapIncrement > 0) {
    twistAngle = Math.round(twistAngle / snapIncrement) * snapIncrement;
  }

  // 4. Build quaternion
  const qTwist = new THREE.Quaternion().setFromAxisAngle(
    twistAxis,
    THREE.MathUtils.degToRad(twistAngle)
  );

  // Final quaternion = twist * current
  const finalQ = qTwist.multiply(mesh.quaternion.clone());

  return {
    quaternion: finalQ,
    computedAxis: twistAxis,
    computedAngle: twistAngle,
  };
}

function findBestWorldRef(axis: THREE.Vector3): THREE.Vector3 {
  // Pick the world axis most perpendicular to the twist axis
  const candidates = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ];
  let best = candidates[0];
  let minDot = Infinity;
  for (const c of candidates) {
    const d = Math.abs(axis.dot(c));
    if (d < minDot) {
      minDot = d;
      best = c;
    }
  }
  return best.clone().projectOnPlane(axis).normalize();
}
```

### F4. Preview Generation

```typescript
// In the React frontend, the preview renderer:
function PreviewRenderer({ previewState }: { previewState: PreviewState }) {
  // If path exists → animate through keyframes
  // If single pose → show ghost at target position

  const meshRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (!previewState.active || !previewState.path || !meshRef.current) return;

    const duration = previewState.duration || 2.0;
    const t = (clock.elapsedTime % duration) / duration; // Loop

    // Find surrounding keyframes
    const path = previewState.path;
    let i = 0;
    while (i < path.length - 1 && path[i + 1].t <= t) i++;

    const kf0 = path[i];
    const kf1 = path[Math.min(i + 1, path.length - 1)];
    const segT = kf1.t > kf0.t ? (t - kf0.t) / (kf1.t - kf0.t) : 0;

    // Interpolate
    const pos = new THREE.Vector3(...kf0.position).lerp(
      new THREE.Vector3(...kf1.position), segT
    );
    const quat = new THREE.Quaternion(...kf0.quaternion).slerp(
      new THREE.Quaternion(...kf1.quaternion), segT
    );

    meshRef.current.position.copy(pos);
    meshRef.current.quaternion.copy(quat);
  });

  // Render as wireframe ghost
  return (
    <mesh ref={meshRef}>
      {/* Clone original geometry */}
      <meshBasicMaterial wireframe color="#00ffff" transparent opacity={0.4} />
    </mesh>
  );
}
```

### F5. Collision / Error Handling

| Scenario | Detection | Resolution |
|----------|-----------|------------|
| Normals same direction | `srcN.dot(tgtN) > 0.9` in flush mode | Auto-flip: negate srcN, inform user |
| Source == Target part | `srcPart === tgtPart` | Error: "Cannot mate a part to itself" |
| Face frames degenerate | tangent or bitangent length ≈ 0 | Fallback to world-aligned frame |
| Path goes through other part | (Future) AABB intersection check on path keyframes | Raise arc height or warn user |
| Twist axis parallel to normal | Dot product ≈ 1 | Valid for face-normal twist; warn if unexpected |

---

## G. UI Design — Move/Rotate Toggle + Mouse Drag Rotate

### G1. Mode Toggle UI

```tsx
// Floating toolbar on 3D canvas
const InteractionModeToggle = () => {
  const { interactionMode } = useAppStore();

  const setMode = (mode: 'move' | 'rotate' | 'mate') => {
    // ALL mode changes go through MCP
    mcpBridge.sendCommand('set_interaction_mode', { mode });
  };

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 flex gap-1 bg-black/60 backdrop-blur rounded-lg p-1 border border-white/10">
      <ModeButton active={interactionMode === 'move'} onClick={() => setMode('move')} icon={Move} label="Move" />
      <ModeButton active={interactionMode === 'rotate'} onClick={() => setMode('rotate')} icon={RotateCcw} label="Rotate" />
      <ModeButton active={interactionMode === 'mate'} onClick={() => setMode('mate')} icon={Link} label="Mate" />
    </div>
  );
};
```

### G2. Mouse Drag Rotation — Arcball

**Event Flow**:

```
1. pointerdown on selected part
   → record: startPoint (NDC), current quaternion, interaction mode
   → if mode === 'rotate': begin rotation tracking

2. pointermove (while dragging)
   → compute delta from startPoint
   → map delta to arcball rotation:
     a. Project startPoint and currentPoint onto virtual sphere
     b. Rotation axis = cross(startVec, currentVec)
     c. Rotation angle = acos(dot(startVec, currentVec))
   → send to MCP: rotate_part(part, axis, angle, preview=true)
   → MCP returns preview transform → update scene

3. pointerup
   → send to MCP: commit_transform(part)
   → push to undo history
```

**Arcball Implementation**:

```typescript
function arcballRotation(
  startNDC: [number, number],
  currentNDC: [number, number],
  sensitivity: number = 1.0
): { axis: THREE.Vector3; angle: number } {
  // Map NDC to sphere surface
  const projectToSphere = (x: number, y: number): THREE.Vector3 => {
    const r = 1.0;
    const d2 = x * x + y * y;
    if (d2 <= r * r * 0.5) {
      // Inside sphere
      return new THREE.Vector3(x, y, Math.sqrt(r * r - d2));
    } else {
      // Outside sphere — project to hyperbola
      const t = r / Math.sqrt(2 * d2);
      return new THREE.Vector3(x, y, t * r).normalize();
    }
  };

  const v0 = projectToSphere(startNDC[0], startNDC[1]);
  const v1 = projectToSphere(currentNDC[0], currentNDC[1]);

  const axis = new THREE.Vector3().crossVectors(v0, v1);
  if (axis.length() < 1e-6) return { axis: new THREE.Vector3(0, 1, 0), angle: 0 };
  axis.normalize();

  const angle = Math.acos(Math.min(1, v0.dot(v1))) * sensitivity;

  return { axis, angle: THREE.MathUtils.radToDeg(angle) };
}
```

**Integration with MCP**:

```typescript
// In the 3D canvas event handler
const handleRotateDrag = useCallback(
  throttle(async (axis: THREE.Vector3, angle: number) => {
    // Send incremental rotation through MCP for preview
    await mcpBridge.sendCommand('rotate_part', {
      part: selectedPartId,
      axis: [axis.x, axis.y, axis.z],
      angle,
      preview: true,
    });
  }, 16), // Throttle to ~60fps
  [selectedPartId]
);
```

**Performance Note**: For real-time drag, the MCP round-trip may be too slow. In that case, the frontend applies the rotation locally and only sends the final result to MCP on pointerup. The MCP server is notified for state sync and undo tracking.

---

## H. Test Cases

### Test 1: Basic Flush Mate
```
Input: align_faces(source_part="Lid", source_face="bottom", target_part="Box", target_face="top", mode="flush")
Expected: Lid's bottom face center moves to Box's top face center. Lid normal points down, Box normal points up. Lid and Box surfaces touching.
Verify: distance(lid_bottom_center, box_top_center) < epsilon (0.001)
Verify: dot(lid_bottom_normal, box_top_normal) ≈ -1.0
```

### Test 2: Flush Mate with Offset
```
Input: align_faces(..., mode="flush", offset=0.5)
Expected: Same as Test 1 but Lid floats 0.5 units above Box.
Verify: distance along normal = 0.5 ± epsilon
```

### Test 3: Insert Mode (Arc Path)
```
Input: compute_mate(..., mode="insert")
Expected: Returns path[] with ≥ 10 keyframes. Path[0] = current position. Path[last] = final flush position. Intermediate keyframes form a smooth arc above the start/end positions.
Verify: max height of path > max(start.y, end.y)
Verify: path is monotonically smooth (no jumps)
Verify: quaternions are normalized at each keyframe
```

### Test 4: Twist — Arbitrary Angle
```
Input: compute_twist(part="Connector", axis="y", angle=37)
Expected: Part rotates exactly 37° around world Y.
Verify: angle between before/after forward vectors = 37° ± 0.1°
Verify: Position unchanged
```

### Test 5: Twist — Auto-Alignment with Snap
```
Input: compute_twist(part="Plate", axis="y", snap_increment=90)
Expected: Part snaps to nearest 90° increment.
Verify: computed_angle_deg ∈ {0, 90, 180, 270}
```

### Test 6: Normal Flip Auto-Recovery
```
Setup: source bottom normal = (0, -1, 0), target top normal = (0, 1, 0)
  → These already oppose → flush works normally
Setup: source TOP normal = (0, 1, 0), target top normal = (0, 1, 0)
  → Same direction! → compute_mate should return error NORMALS_SAME_DIRECTION
  → LLM auto-retries with flip=true
  → Result: source is flipped 180° so its top normal now opposes target
Verify: Final dot(srcN, tgtN) ≈ -1.0
```

### Test 7: Preview → Cancel → Undo Flow
```
1. compute_mate(...) → get result transform
2. preview_transform(part, position, quaternion) → part shows at preview position
3. cancel_preview() → part returns to original position
Verify: part.position === originalPosition after cancel
4. commit_transform() after fresh preview
5. undo() → part returns to pre-commit position
Verify: part.position === originalPosition after undo
6. redo() → part goes back to committed position
```

### Test 8: Edge Case — Select Non-Existent Part
```
Input: select_part(name_or_uuid="NonExistentPart123")
Expected: { success: false, error: "PART_NOT_FOUND", selected: null }
Verify: No scene state change, no crash
```

### Test 9: Edge Case — Mate Part to Itself
```
Input: align_faces(source_part="Lid", source_face="top", target_part="Lid", target_face="bottom", mode="flush")
Expected: Error: "Cannot mate a part to itself"
Verify: No transform applied
```

### Test 10: Mouse Drag Rotate — Full Cycle
```
1. set_interaction_mode("rotate")
2. Select part via click
3. pointerdown on part → record start
4. pointermove (dx=100px, dy=0) → arcball computes ~30° rotation around Y
5. Preview shown in real-time
6. pointerup → commit_transform called
Verify: Part rotation changed by ~30° around Y
Verify: Undo stack has 1 entry
```

---

## I. Implementation Plan (Execution Steps)

### Phase 1: Foundation (Store + MCP Tool Framework)
1. Extend `useAppStore.ts` with new state fields (interactionMode, previewState, constraints, history)
2. Create `shared/types.ts` with all TypeScript interfaces and Zod schemas
3. Refactor `mcp-server/index.ts` to use a tool registry pattern (instead of giant switch)
4. Implement `sendToApp` handler registration for all new commands in MCPBridge

### Phase 2: Core Geometry Engine
5. Create `shared/geometry.ts` with `computeFaceFrame`, `computeFlushMate`, `computeTwist`
6. Create `shared/pathgen.ts` with `generateArcPath` (Bezier + SLERP)
7. Unit test geometry functions with known inputs/outputs

### Phase 3: MCP Tools Implementation
8. Implement selection tools: `select_part`, `select_face`, `get_selection`
9. Implement query tools: `get_scene_state` (enhanced), `get_face_info`, `get_part_transform`
10. Implement action tools: `translate_part`, `rotate_part`, `align_faces`
11. Implement compute tools: `compute_mate`, `compute_twist`
12. Implement preview/commit: `preview_transform`, `commit_transform`, `cancel_preview`
13. Implement history: `undo`, `redo`
14. Implement mode: `set_interaction_mode`

### Phase 4: Intent Router
15. Implement two-phase intent router (heuristic + LLM)
16. System prompt with tool docs
17. Error recovery logic (auto-flip, fuzzy match, clarification)

### Phase 5: Frontend UI
18. Build `InteractionModeToggle` component
19. Implement arcball mouse drag rotation
20. Build `PreviewRenderer` component (wireframe ghost + path animation)
21. Wire up all new MCPBridge handlers

### Phase 6: Testing & Polish
22. Write Playwright tests for all 10 test cases
23. End-to-end test: chat input → tool execution → scene update
24. Performance optimization (throttle drag, batch state updates)
