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

# 確認 Ollama 是否運行
curl http://127.0.0.1:11434/api/tags
ollama ps

# Devflow (tri-agent automation)
npm run devflow -- "requirement"     # CLI
npm run devflow:server               # Web UI on :4170
```

**URLs:** Default is v2 at `http://localhost:5173`. Legacy v1 via `?legacy=1`. Fixtures via `?fixture=boxes`.

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

- `src/v2/store/store.ts` — Single Zustand store (`V2State`). Scoped selectors pattern to avoid rerenders. Exposed as `window.__V2_STORE__` in dev for test access.
- `src/v2/three/` — R3F scene: `CanvasRoot.tsx` (root), `ModelLoader.tsx` (GLTF loading), `SceneRegistry.ts` (global scene/camera/renderer refs accessed via `getV2Scene()` etc.), `mating/` (face clustering, anchor resolution, mate solver).
- `src/v2/ui/` — React panels: Chat, CommandBar, MatePanel, PartsPanel, Steps, VLM.
- `src/v2/network/` — `client.ts` (singleton WS client with auto-reconnect, 20s request timeout), `mcpToolExecutor.ts` (tool dispatch returning `ToolEnvelope<T>`).
- `mcp-server/v2/` — `wsGateway.ts` (WS server + request routing), `router/router.ts` (intent router), `router/mockProvider.ts` (keyword-based NLP, default), `router/llmAssist.ts` (optional Gemini/Ollama).
- `mcp-server/v2/router/agent/` — agent 模式的 prompts/skills/QA 設定（`ROUTER_PROVIDER=agent` 時使用）。
- `mcp-server/v2/router/policy/` — mock router 的 keyword 與 NLU policy JSON。
- `mcp-server/v2/vlm/` — VLM 分析管線，`structuredMate.ts` 負責多視角影像 → 結構化 JSON。
- `mcp-server/v2/status/` / `mcp-server/v2/web/` — server 狀態端點。
- `shared/schema/` — Zod schemas shared between frontend and backend: `protocol.ts` (WS message types), `mcpToolsV3.ts` (all MCP tool schemas, ~1200 lines).
- `tests/` — Playwright E2E tests, prefixed `v2_`. Tests access store via `window.__V2_STORE__` and use 120s timeouts.

### MCP Tool Namespaces

Tools follow `namespace.action` naming: `selection.set`, `query.scene_state`, `action.mate_execute`, `preview.transform_plan`, `view.set_environment`, `steps.add`, `vlm.analyze`, `history.undo`, `mode.set_interaction_mode`, `ui.get_sync_state`.

### Mate System

Anchor resolution methods: `auto`, `planar_cluster`, `geometry_aabb`, `object_aabb`, `extreme_vertices`, `obb_pca`, `picked`. Mate modes: `face_flush`, `face_insert_arc`, `edge_to_edge`, `axis_to_axis`. Supports twist (`{ axisSpace, axis, angleDeg }`) and arc paths (`{ height, lateralBias }`).

### Router Providers

Default is `mockProvider` (keyword matching + Levenshtein fuzzy part name matching). Set `ROUTER_LLM_ENABLE=1` with `ROUTER_LLM_PROVIDER=auto|ollama|gemini` for real LLM routing. For full agent routing (LLM decides tool calls), set `ROUTER_PROVIDER=agent`.

Key env vars:
- `ROUTER_LLM_ENABLE=1` / `ROUTER_LLM_PROVIDER=auto|ollama|gemini` / `ROUTER_LLM_MODEL`
- `ROUTER_PROVIDER=agent` — switches to full agent loop (`mcp-server/v2/router/agent/`)
- `ROUTER_WEB_ENABLE=1` — enables server-side web tools (weather + search)
- `V2_VLM_PROVIDER=auto|ollama|gemini|mock|none` / `VLM_MATE_MODEL`
- `OLLAMA_BASE_URL` / `OLLAMA_MODEL` — Ollama 連線 (預設 `http://127.0.0.1:11434`)
- `GEMINI_API_KEY` / `GEMINI_MODEL`
- `V2_ROUTER_KEYWORDS_PATH` / `V2_ROUTER_MOCK_POLICY_PATH` / `ROUTER_AGENT_DIR` — 覆寫 policy/prompt 檔案路徑

## Conventions

- **Types over interfaces** — prevalent pattern throughout.
- **Zod for runtime validation** — all WS protocol messages and tool schemas validated with Zod.
- **Test file naming** — `v2_<feature>.spec.ts` in snake_case.
- **UI styling** — Tailwind utilities with glassmorphism pattern (`bg-black/60 backdrop-blur-md`).
- **Tool results** — Always wrapped in `ToolEnvelope<T>` (`{ ok, data, warnings }` or `{ ok: false, error }`).
- **Error codes** — `INVALID_ARGUMENT`, `NOT_FOUND`, `AMBIGUOUS_SELECTION`, `SCENE_OUT_OF_SYNC`, `SOLVER_FAILED`, etc.
- **No path aliases** — imports use relative paths.
- **strict TypeScript** — but `noUnusedLocals` and `noUnusedParameters` are disabled.
