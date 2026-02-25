# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A 3D CAD assembly & animation studio with an MCP (Model Context Protocol) backend. Users load GLB/GLTF models, mate parts together, build step-by-step assembly sequences, and control everything through a chat interface routed to MCP tools.

**Tech stack:** React 18 + TypeScript, Three.js via @react-three/fiber + drei, Zustand state, Vite 6.4, TailwindCSS, WebSocket-based MCP server, Playwright E2E tests.

## Commands

```bash
# Dev servers (both required for full functionality)
npm run dev                          # Frontend on :5173
npx tsx mcp-server/v2/index.ts       # MCP WebSocket server on :3011
./start.sh                           # Both together (frontend bg, backend fg)

# Build
npm run build                        # tsc + vite build

# Tests (Playwright)
npm test                             # All tests
npx playwright test tests/v2_smoke.spec.ts --reporter=line   # Single test file

# Devflow (tri-agent automation)
npm run devflow -- "requirement"     # CLI
npm run devflow:server               # Web UI on :4170
```

**URLs:** Default is v2 at `http://localhost:5173`. Legacy v1 via `?legacy=1`. Fixtures via `?fixture=<id>` — available IDs: `boxes` (default), `side`, `lid`, `shelf`, `slot`, `nested`.

## Architecture

### v1 vs v2

The app has two code paths selected in `src/main.tsx` by URL params. **v2 is the default and active development target.** v1 (`src/components/`, `src/store/`) is legacy. All new work goes in `src/v2/`.

### Data Flow

```
Chat UI → WS Client → WebSocket → Gateway → Router → Tool Execution
                                                         ↓
                                              (tool_proxy_invoke event)
                                                         ↓
                                              Frontend executes tool
                                              Updates Zustand store
```

Most tools execute **in the browser** via the tool proxy pattern. The backend routes chat intent to tool calls but the frontend's `mcpToolExecutor.ts` performs the actual scene mutations. Only `save_asset`, routing, and VLM analysis run server-side.

### Key Directories

- `src/v2/store/store.ts` — Single Zustand store (`V2State`). Top-level slices: `cadUrl`, `cadFileName`, `parts`, `selection`, `steps`, `playback`, `ui`, `interaction`, `markers`, `vlm`, `chat`, `view`, `connection`, `mateRequest`, `mateDraft`, `matePreview`. Scoped selectors pattern to avoid rerenders. Exposed as `window.__V2_STORE__` in dev for test access.
- `src/v2/three/` — R3F scene: `CanvasRoot.tsx` (root), `ModelLoader.tsx` (GLTF loading), `SceneRegistry.ts` (global scene/camera/renderer refs accessed via `getV2Scene()` etc.), `mating/` (face clustering, anchor resolution, mate solver).
- `src/v2/ui/` — React panels: Chat, CommandBar, MatePanel, PartsPanel, Steps, VLM.
- `src/v2/network/` — `client.ts` (singleton WS client with auto-reconnect, 20s request timeout), `mcpToolExecutor.ts` (tool dispatch returning `ToolEnvelope<T>`).
- `mcp-server/v2/` — `wsGateway.ts` (WS server + request routing), `router/router.ts` (intent router), `router/mockProvider.ts` (keyword-based NLP, default), `router/llmAssist.ts` (optional Gemini/Ollama).
- `shared/schema/` — Zod schemas shared between frontend and backend: `protocol.ts` (WS message types), `mcpToolsV3.ts` (all MCP tool schemas, ~1200 lines).
- `tests/` — Playwright E2E tests, prefixed `v2_`. Tests access store via `window.__V2_STORE__` and use 120s timeouts.

### MCP Tool Namespaces

Tools follow `namespace.action` naming: `selection.set`, `query.scene_state`, `action.mate_execute`, `preview.transform_plan`, `view.set_environment`, `steps.add`, `vlm.analyze`, `history.undo`, `mode.set_interaction_mode`, `ui.get_sync_state`.

### Mate System

Anchor resolution methods: `auto`, `planar_cluster`, `geometry_aabb`, `object_aabb`, `extreme_vertices`, `obb_pca`, `picked`. Mate modes (MCP schema): `face_flush`, `face_insert_arc`, `edge_to_edge`, `axis_to_axis`, `point_to_point`, `planar_slide`, `hinge_revolute`. Supports twist (`{ axisSpace, axis, angleDeg }`) and arc paths (`{ height, lateralBias }`).

Parts are referenced in tool args as `PartRef`: `{ partId?: string } | { partName?: string }` — at least one field required. The executor fuzzy-matches by name when `partId` is absent.

### Router Providers

Default is `mockProvider` (keyword matching + Levenshtein fuzzy part name matching). Set `ROUTER_LLM_ENABLE=1` with `ROUTER_LLM_PROVIDER=auto|ollama|gemini` for real LLM routing.

## Conventions

- **Types over interfaces** — prevalent pattern throughout.
- **Zod for runtime validation** — all WS protocol messages and tool schemas validated with Zod.
- **Test file naming** — `v2_<feature>.spec.ts` in snake_case.
- **UI styling** — Tailwind utilities with glassmorphism pattern (`bg-black/60 backdrop-blur-md`).
- **Tool results** — Always wrapped in `ToolEnvelope<T>`. Success: `{ ok: true, sceneRevision: number, data: T, warnings, debug? }`. Failure: `{ ok: false, sceneRevision?, error: { code, message, recoverable, suggestedToolCalls }, warnings }`.
- **Error codes** — `INVALID_ARGUMENT`, `NOT_FOUND`, `AMBIGUOUS_SELECTION`, `SCENE_OUT_OF_SYNC`, `SOLVER_FAILED`, etc.
- **No path aliases** — imports use relative paths.
- **strict TypeScript** — but `noUnusedLocals` and `noUnusedParameters` are disabled.
