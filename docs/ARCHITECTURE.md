# Project Architecture & Feature Documentation

> **Note for AI Models:** This document serves as the primary context source for understanding the codebase capabilities, architectural decisions, and implemented features. Use this to ground your future modifications.

## 1. High-Level Overview
This is a **3D CAD Animation & Assembly Studio** application built with modern web technologies and an agentic backend.
- **Frontend**: React, TypeScript, Vite, TailwindCSS.
- **3D Engine**: Three.js, @react-three/fiber (R3F), @react-three/drei.
- **State Management**: Zustand.
- **Backend / Agent Interface**: Model Context Protocol (MCP) Server using Node.js & WebSockets.
- **AI Integration**: Gemini Pro & Ollama (Local) for Natural Language Processing and Visual Analysis (VLM).

---

## 1.1 v2 Architecture (Rebuild in progress)
**v2 default UI** lives under `src/v2/` and uses a typed WS protocol + command routing:
- **AppShell**: `src/v2/app/AppShell.tsx` (responsive panels + top bar + timeline)
- **3D**: `src/v2/three/*` (CanvasRoot, selection, gizmo, mating, anchors)
- **State**: `src/v2/store/store.ts` (command-based history + undo/redo)
- **WS Protocol**: `shared/schema/*` (zod schemas)
- **Backend v2**: `mcp-server/v2/*` (WS gateway + router + VLM mock)

**v2 entry**: default app renders v2 unless `?legacy=1` is present.

---

## 2. Core Systems

### A. 3D Rendering Engine (`src/components/Three/`)
The scene is built around R3F `Canvas`.
- **Scene Composition (`Scene.tsx`)**:
    - **Environment**: Uses `Environment` from drei (presets: city, sunset, warehouse) with background blur.
    - **Lighting**: Ambient + Directional lights with shadow casting.
    - **Controls**: `OrbitControls` for camera manipulation.
    - **SceneConnector**: Exposes the Three.js `scene` ref to `mcpHandlers.ts` via `setSceneRef()`.
    - **PreviewRenderer**: Wireframe ghost mesh for transform previews.
    - **FaceHighlight**: Colored face planes + normal arrows for mate mode.
    - **ArcballDrag**: Shoemake trackball rotation via mouse drag.
    - **Robust Loading**:
        - `Suspense` boundaries wrap disparate elements (Environment vs Model) to prevent total crash.
        - **`LoadingOverlay`**: Custom UI overlay showing load progress (%).
        - **`ModelErrorBoundary`**: Catches GLTF parsing errors and shows a retry UI instead of white-screening.

- **Model Handling (`Model.tsx`)**:
    - **Loaders**: Supports GLTF/GLB (with Draco compression) and USDZ.
    - **Auto-Fit Camera**: Automatically calculates the AABB of the loaded model and zooms the camera to fit it perfectly in view on load.
    - **Part Registration**: Traverses the scene graph, assigns unique IDs to meshes, and registers them in the Zustand store for external control.

### B. Interaction System
- **Selection**:
    - Clicking a part highlights it using a custom `PartHighlighter` (Yellow Wireframe OBB).
    - Logic handles simple clicks vs drags to prevent accidental selection during camera movement.
- **Interaction Mode Toggle (`InteractionModeToggle.tsx`)**:
    - Floating toolbar with Move (W), Rotate (E), Mate (R) modes.
    - Keyboard shortcuts for quick switching.
    - Glassmorphism styling: `bg-black/60 backdrop-blur-md`.
- **Smart Markers (Animation Endpoints)**:
    - **Start/End Markers**: Visual spheres indicating animation trajectory.
    - **Draggable Gizmos**: Markers are wrapped in `TransformControls` for manual fine-tuning.
    - **Smart Snap**: Clicking a face on a mesh calculates the **coplanar face center** and snaps the marker to it.

### C. State Management (`src/store/useAppStore.ts`)
Powered by `zustand`.
- **`parts`**: Dictionary maps UUIDs to `{ uuid, name, position, rotation, scale, color }`.
- **`cadUrl`**: Source URL for the model.
- **`interactions`**:
    - `pickingMode`: 'idle', 'start' (setting start pos), 'end'.
    - `selectedPartId`: Currently active mesh.
- **`interactionMode`**: `'move' | 'rotate' | 'mate'` — current 3D interaction mode.
- **`selectedFaces`**: Array of `{ partUuid, face, frame }` for mate operations.
- **`previewState`**: `{ active, partUuid, position, quaternion, path }` for ghost preview.
- **`constraints`**: Array of `MateConstraint` records.
- **`history`**: Undo/redo stack of `HistoryEntry` records with `before/after` transforms.
- **Actions**: `setInteractionMode`, `addSelectedFace`, `clearSelectedFaces`, `startPreview`, `cancelPreview`, `commitPreview`, `addConstraint`, `removeConstraint`, `pushHistory`, `undo`, `redo`.
- **DEV exports**: Exposes `window.__APP_STORE__`, `__GEOMETRY__`, `__SCENE_REF__`, `__MCP_BRIDGE__` in development mode for test access.

### D. MCP Backend (`mcp-server/`)
Acts as a bridge between the Frontend and AI Agents.
- **Communication**: WebSocket (ws://localhost:3001).
- **Generic Forwarding**: All tool calls are forwarded to the React app via WebSocket using a unified handler (no per-tool switch). Only `save_asset` runs server-side (file I/O).
- **Intent Router** (`intentRouter.ts`): Two-phase NL classification.
- **Error Recovery** (`errorRecovery.ts`): Auto-recovery with retry strategies.
- **Tools Exposed to AI** (32 tools — see Section 5 below).

---

## 3. Key Implemented Features (AI Context)

### Large File Handling
- **Problem**: 800MB+ GLB files were causing silent failures (invisible models) or crashes.
- **Solution**:
    1. **Streaming Load**: Progress validation via `useProgress`.
    2. **Visual Feedback**: Loading Bar -> 100%.
    3. **Crash Protection**: Error Boundaries catch memory/parse errors.
    4. **Visibility Guarantee**: `Auto-Fit Camera` logic ensures the camera isn't inside or far away from massive models by scaling view distance based on AABB size.

### Object Mover Tool (Smart Alignment)
- Allows moving parts by defining semantic relationships.
- **Logic**: "Align [Source Face] of [Active Part] to [Target Face] of [Target Part]".
- The system calculates the vector difference between the two face centers and creates an animation path.

### Animation Playback
- "PLAY" button triggers the interpolation between `StartMarker` and `EndMarker`.
- Backend command `play_assembly` triggers this programmatically.

---

## 4. Phase 1-6 Implementation Details

### Phase 1: Shared Types & Store Extension
**Files**: `shared/types.ts`, `src/store/useAppStore.ts`

Established a typed domain model shared between frontend and MCP server:
- **Zod schemas** for runtime validation of all tool arguments.
- **Core types**: `Part`, `FaceId`, `FaceFrame`, `MateMode`, `MateConstraint`, `HistoryEntry`, `PreviewState`, `AnimationStep`, `SequenceState`.
- **`FaceFrame`**: `{ origin, normal, tangent, bitangent }` — computed via OBB/PCA.
- **`HistoryEntry`**: `{ id, timestamp, description, partUuid, before: {position, rotation}, after: {position, rotation} }`.
- **Store extension**: Added `interactionMode`, `selectedFaces`, `previewState`, `constraints`, `history` with undo/redo to Zustand store.

### Phase 2: Geometry Engine
**Files**: `src/utils/geometry.ts` (~370 lines), `src/utils/pathgen.ts` (~190 lines)

Pure-math utilities for mate computation and path generation:

- **`computeFaceFrame(mesh, faceId)`**: Computes an oriented bounding box (OBB) via PCA, returns `FaceFrame` with origin/normal/tangent/bitangent for a named face ("top", "bottom", "left", "right", "front", "back", "center").
- **`computeFlushMate(srcFrame, tgtFrame, offset, flip)`**: Aligns two face frames flush (normal-to-normal opposition) using `Quaternion.setFromUnitVectors()`.
- **`computeInsertMate(srcFrame, tgtFrame, offset, flip)`**: Concentric insertion along face normals.
- **`computeMate(srcMesh, srcFace, tgtMesh, tgtFace, mode, offset, flip, twistAngle)`**: Unified entry point dispatching to flush/insert/edge/axis/point/planar modes.
- **`computeTwist(mesh, axis, angle, referenceFace, snapIncrement)`**: Rotation around an axis with optional snap.
- **`worldToLocal(mesh, worldPos)`**: World-to-local coordinate conversion.
- **`findMeshByName(scene, name)`**: Scene graph traversal for mesh lookup.

Path generation:
- **`generateArcPath(start, end, height, segments)`**: Quadratic Bezier arc.
- **`generateEasedArcPath(start, end, height, segments)`**: Bezier arc with easing.
- **`generateLinearPath(start, end, segments)`**: Straight line interpolation.
- **`generateHelicalPath(start, end, turns, radius, segments)`**: Helical spiral path.
- All paths return arrays of `[x, y, z]` keyframes with SLERP-compatible quaternion interpolation.

### Phase 3: MCP Tool Handlers
**Files**: `src/services/mcpHandlers.ts` (~510 lines), `mcp-server/index.ts`

Bridged MCP tools to the React app via WebSocket:

- **`setSceneRef(scene)`**: Called by `SceneConnector` inside R3F Canvas to expose the Three.js scene to handlers.
- **`registerMcpHandlers(bridge)`**: Registers 21 new + 7 legacy handlers on MCPBridge.
- **`resolvePart(nameOrId)`**: Fuzzy part name matching (UUID → exact → case-insensitive → substring).
- **`resolveMesh(nameOrId)`**: Three.js mesh lookup via scene graph traversal.
- **Generic forwarding** in `mcp-server/index.ts`: All `CallToolRequest` calls are forwarded to the app via `sendToApp(command, args)` — no per-tool switch statement.

**32 registered MCP tools**:

| Category | Tools |
|----------|-------|
| Selection | `select_part` |
| Query | `get_scene_state`, `get_ui_state` |
| Transform | `move_part`, `rotate_part` |
| Mate | `align_faces` |
| Compute | `compute_mate`, `compute_twist` |
| Preview | `preview_transform`, `commit_transform`, `cancel_preview` |
| History | `undo`, `redo` |
| Mode | `set_interaction_mode` |
| Animation | `add_animation_step`, `play_animation`, `stop_animation` |
| Scene | `reset_scene`, `reset_part`, `load_model` |
| UI | `set_environment` |
| Legacy | `move_part_to`, `set_start_position`, `set_end_position`, `preview_animation`, `add_current_step`, `set_pose_target`, `play_assembly` |

### Phase 4: UI Components
**Files**: `src/components/UI/InteractionModeToggle.tsx`, `src/components/Three/PreviewRenderer.tsx`, `src/components/Three/FaceHighlight.tsx`, `src/components/Three/ArcballDrag.tsx`

Four new interactive components:

1. **InteractionModeToggle** (~56 lines):
   - Floating toolbar overlay with Move/Rotate/Mate buttons.
   - Keyboard shortcuts: W (move), E (rotate), R (mate).
   - Active state glow: `shadow-[0_0_12px_rgba(59,130,246,0.4)]`.

2. **PreviewRenderer** (~131 lines):
   - Renders wireframe ghost mesh at preview `position/quaternion` when `previewState.active`.
   - Supports animated path playback (loops along keyframes with quaternion SLERP).
   - Blue wireframe material at 35% opacity.
   - Clones original mesh geometry from scene.

3. **FaceHighlight** (~103 lines):
   - Renders colored planes + `ArrowHelper` at selected face positions.
   - Green (`0x22c55e`) for source face, Blue (`0x3b82f6`) for target face.
   - Only visible when `interactionMode === 'mate'`.
   - Auto-sizes plane to 30% of mesh bounding box.

4. **ArcballDrag** (~171 lines):
   - Shoemake trackball projection: maps 2D mouse to 3D sphere for intuitive rotation.
   - Raycast-validates that click is on the selected part.
   - Disables `OrbitControls` during drag to prevent camera interference.
   - Commits final rotation to store with undo history on `pointerup`.
   - Only active when `interactionMode === 'rotate'`.

### Phase 5: Intent Router & Error Recovery
**Files**: `mcp-server/intentRouter.ts` (~250 lines), `mcp-server/errorRecovery.ts` (~190 lines)

Two-phase NL understanding pipeline:

**Phase 1 — Heuristic Pre-Filter** (`quickClassify`):
- Regex pattern matching for common commands (undo, redo, reset, play, stop, load, mode switch, select, environment).
- Returns structured `ToolCall[]` with 0.95 confidence when matched.
- Chat detection patterns (greetings, questions) return `CHAT` class.
- Complex tool patterns (move/align/mate with prepositions) fall through to Phase 2.

**Phase 2 — LLM Classification** (`llmClassify`):
- Sends comprehensive system prompt (all 21 tool definitions, face inference rules, error recovery instructions) + current part names + user input.
- Provider chain: Gemini Pro → Ollama (qwen3:8b) → generic help fallback.
- Returns `IntentResult`: `{ class, confidence, tool_calls, chat_response, reasoning }`.
- Intent classes: `CHAT`, `TOOL_CALL`, `MIXED`, `CLARIFY`.

**Error Recovery** (`executeToolCalls`):
- Wraps tool execution with auto-recovery strategies (max 2 retries).
- `NORMALS_SAME_DIRECTION` → auto-retry with `flip=true`.
- `PART_NOT_FOUND` → fuzzy match via Levenshtein distance + substring matching.
- `NO_PREVIEW` → silently skip `cancel_preview`.
- `ANIMATION_PLAYING` → inform user to stop animation first.
- **Pre-execution**: `resolvePartNames()` fuzzy-matches part name args (`part`, `source_part`, `target_part`, `source`, `target`) before sending to app.

### Phase 6: End-to-End Tests
**Files**: `tests/phase6_e2e.spec.ts` (~519 lines)

12 Playwright tests validating the full stack:

| Test | Description |
|------|-------------|
| T1 | Flush mate computes correct position + pushes history |
| T2 | Mate with offset applies along face normal |
| T3 | Preview starts → cancel restores original state |
| T4 | Preview → commit → undo → redo cycle |
| T5 | Interaction mode switching (move → rotate → mate) |
| T6 | Face selection in mate mode (max 2) |
| T7 | Constraint add and remove |
| T8 | Animation sequence: add steps → play → stop |
| T9 | Environment preset updates store |
| T10 | UI components render (sidebar, chat, canvas) |
| T11 | Full history: move → undo → redo |
| T12 | Select part → reset part |

- **Test pattern**: Store-first via `window.__APP_STORE__` (exposed in DEV mode).
- **Base URL**: `http://127.0.0.1:5173/?legacy=1` (loads v1 app for testing).
- All 12 tests pass (~34s total).

---

## 5. Directory Structure
```
/
├── src/
│   ├── components/
│   │   ├── Three/              # 3D Logic
│   │   │   ├── Scene.tsx       # Canvas + SceneConnector + overlays
│   │   │   ├── Model.tsx       # GLTF/USDZ loader + part registration
│   │   │   ├── PreviewRenderer.tsx   # Wireframe ghost preview
│   │   │   ├── FaceHighlight.tsx     # Face plane + normal arrows
│   │   │   ├── ArcballDrag.tsx       # Trackball rotation drag
│   │   │   └── ModelErrorBoundary.tsx
│   │   ├── UI/
│   │   │   ├── InteractionModeToggle.tsx  # Mode toolbar overlay
│   │   │   ├── ChatInterface.tsx
│   │   │   ├── AnimationStudio.tsx
│   │   │   ├── PropertyEditor.tsx
│   │   │   ├── ImageUploader.tsx
│   │   │   ├── PartsList.tsx
│   │   │   ├── PanelSection.tsx
│   │   │   └── LoadingOverlay.tsx
│   ├── services/
│   │   ├── MCPBridge.ts        # WebSocket client bridge
│   │   └── mcpHandlers.ts      # 28 MCP tool handler implementations
│   ├── store/
│   │   └── useAppStore.ts      # Zustand store (parts, history, preview, constraints)
│   ├── utils/
│   │   ├── geometry.ts         # OBB, face frames, mate computation
│   │   └── pathgen.ts          # Arc/linear/helical path generation
│   ├── v2/                     # v2 rebuild (separate architecture)
│   └── main.tsx
├── shared/
│   └── types.ts                # Zod schemas + domain types (shared frontend/server)
├── mcp-server/
│   ├── index.ts                # MCP server entry + generic tool forwarding
│   ├── intentRouter.ts         # Two-phase NL intent classification
│   ├── errorRecovery.ts        # Auto-recovery + fuzzy matching
│   ├── convert_to_usd.py       # USD conversion script
│   └── v2/                     # v2 WS gateway + router
├── tests/
│   ├── phase6_e2e.spec.ts      # 12 Playwright e2e tests
│   └── ...                     # Additional test files
├── plan/
│   ├── ARCHITECTURE_PLAN.md    # Original implementation plan
│   ├── MCP_TOOL_SCHEMAS.ts     # Tool schema definitions
│   └── LLM_CONVERSATION_EXAMPLES.md
├── docs/
│   └── ARCHITECTURE.md         # This file
└── package.json
```

---

## 6. Key Architectural Decisions

1. **Store-first pattern**: All state mutations go through Zustand. MCP handlers read/write via `useAppStore.getState()`. Three.js components subscribe to store slices.

2. **Generic MCP forwarding**: Instead of a switch statement per tool in the MCP server, all tool calls are forwarded to the app via `sendToApp(command, args)`. The app-side `mcpHandlers.ts` handles dispatch.

3. **SceneConnector pattern**: A tiny R3F component (`SceneConnector`) inside `<Canvas>` exposes the Three.js scene to non-R3F code (mcpHandlers) via `setSceneRef()`.

4. **Two-phase intent routing**: Fast regex heuristics handle ~60% of commands (undo, play, reset, select) without an LLM call. Only ambiguous/complex inputs go to LLM classification.

5. **Pre-execution fuzzy matching**: Part names in tool args are fuzzy-matched before execution, reducing `PART_NOT_FOUND` errors and retry overhead.

6. **DEV-mode test exports**: Store, geometry utils, and bridge are exposed on `window` in development mode, enabling Playwright tests to call store actions directly without DOM interaction.

7. **Shared types via Zod**: `shared/types.ts` provides both TypeScript types and runtime validation schemas, used by both frontend and server (with `.js` extension imports for ESM compatibility).
