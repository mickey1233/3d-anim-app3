# Architecture: v2 System (Current)

## Overview

The 3D CAD assembly studio uses a split architecture:
- **Frontend** (React + Three.js): renders scene, executes tool mutations, owns Zustand state
- **Backend** (Node.js WebSocket server): routes chat intent to tool calls via an LLM agent

Most tool execution happens **in the browser**. The backend is a routing layer, not a scene authority.

---

## Data Flow

```
User types chat message
        │
        ▼
Chat UI (src/v2/ui/ChatPanel.tsx)
        │  sends text over WebSocket
        ▼
WS Client (src/v2/network/client.ts)
        │  { command: 'agent.route', text: '...' }
        ▼
WebSocket Gateway (mcp-server/v2/wsGateway.ts)
        │  dispatches to router
        ▼
Router (mcp-server/v2/router/router.ts)
        │  selects provider based on env
        ▼
Agent Provider (mcp-server/v2/router/agentProvider.ts)
        │  reads agent-prompts/ markdown docs
        │  calls LLM (Gemini / Claude / Ollama / OpenAI)
        ▼
LLM returns { toolCalls: [{ tool, args }], replyText }
        │
        ▼
Gateway serializes tool calls
        │  sends { command: 'tool_proxy_invoke', tool, args } back to frontend
        ▼
WS Client receives tool_proxy_invoke
        │
        ▼
mcpToolExecutor.ts (src/v2/network/mcpToolExecutor.ts)
        │  dispatches on tool name
        │  reads/writes Zustand store
        │  calls Three.js solvers (solveMateTopBottom, etc.)
        ▼
Zustand store (src/v2/store/store.ts)
        │  React components rerender
        ▼
Three.js scene updated (src/v2/three/)
```

---

## Key Directories

| Path | Role |
|------|------|
| `src/v2/store/store.ts` | Single Zustand store for all app state |
| `src/v2/three/` | R3F scene, model loading, mating solvers |
| `src/v2/network/mcpToolExecutor.ts` | Frontend tool executor (~5200 lines) |
| `src/v2/ui/` | React panels (Chat, Parts, Steps, VLM, Mate) |
| `mcp-server/v2/wsGateway.ts` | WS server, request routing, side-channel commands |
| `mcp-server/v2/router/` | Intent routing, LLM agent, recipe learning |
| `agent-prompts/` | Markdown docs injected into LLM system prompt |
| `shared/schema/mcpToolsV3.ts` | Zod schemas for all MCP tools (~1600+ lines) |

---

## Special Routes (Backend-only)

These do NOT go through `mcpToolExecutor.ts`:

| Command | Handler |
|---------|---------|
| `agent.save_mate_recipe` | wsGateway → mateRecipes.saveRecipe |
| `agent.delete_mate_recipe` | wsGateway → mateRecipes.deleteRecipe |
| `agent.list_mate_recipes` | wsGateway → mateRecipes.listRecipes |
| `agent.save_demonstration` | wsGateway → mateRecipes.saveDemonstration |
| `agent.list_demonstrations` | wsGateway → mateRecipes.listDemonstrations |
| `agent.infer_mate_params` | wsGateway → mateParamsInfer.inferMateParams |
| `vlm.structured_mate` | wsGateway → structuredMate pipeline |
| `save_asset` | wsGateway → filesystem |

---

## Mate Execution Flow (v2 face-based)

```
action.smart_mate_execute
        │
        ▼
mcpToolExecutor: resolveFeature(sourcePart, targetPart)
        │  calls callAgentForMateParams() → LLM infers intent/faces/methods
        │  falls back to geometry heuristics
        ▼
solveMateTopBottom(sourceObj, targetObj, sourceFace, targetFace, mode)
        │  resolveAnchor() → FaceCluster → AnchorResult (centerLocal, normalLocal)
        │  buildMateTransform() → rotation quaternion + translation vector
        ▼
applyMateTransform(obj, transform)
        │  updates Three.js object position/quaternion
        ▼
currentStore().setPartOverride(partId, transform)
        │  triggers React rerender
        ▼
Part moves in scene
```

---

## Mate Execution Flow (v3 feature-based — new)

```
query.generate_candidates
        │
        ▼
extractFeatures(sourceObj, sourcePartId)   extractFeatures(targetObj, targetPartId)
        │  Stage 1: clusterPlanarFaces → planar_face features
        │  Stage 2: circle fit on plane clusters → cylindrical_hole features
        │  Stage 3: peg detection above support plane → peg features
        │  Stage 4: slot detection (stub)
        ▼
generateMatingCandidates(srcFeatures, tgtFeatures)
        │  feature type compatibility table
        │  dimension fit scoring (Gaussian)
        │  axis alignment scoring
        │  face support consistency (backward compat)
        ▼
MatingCandidate[] sorted by totalScore
        │
        ▼
(optional) solveAlignment(sourceObj, targetObj, featurePairs)
        │  plane_align / peg_slot / point_align / axis_align
        ▼
AlignmentSolution { translation, rotation, approachDirection }
```

---

## State Architecture

The Zustand store is exposed as `window.__V2_STORE__` in development for Playwright tests.

Top-level store slices:
- `parts` — byId map, order array, transforms, overrides
- `selection` — active feature, stack
- `steps` — assembly sequence
- `playback` — animation state
- `chat` — message history
- `mateDraft` / `matePreview` — in-progress mate state
- `vlm` — VLM analysis results
- `view` — environment, grid, anchor visibility
- `connection` — WebSocket state
