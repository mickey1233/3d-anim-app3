# 3D CAD Assembly & Animation Studio (v2)

This repo is undergoing a **full v2 rebuild** focused on a product-grade 3D CAD assembly / SOP workflow:
- v2 is now the default UI (legacy still available via query param).
- v2 uses a typed WS protocol, command router (mock provider), and a new responsive single-page layout.

## Features (v2 in progress)

### v2 Core (current)
- **Single-page responsive layout** with collapsible panels (no cut-off content).
- **Parts list** + selection + transform gizmo (orbit disabled while dragging).
- **Face-based mating (Top/Bottom)** with lighter preview markers and faster auto-anchor resolution.
- **SOP steps panel + timeline bar** (add/select).
- **Command bar** (mock router; structured tool calls + trace).
- **AI Chat router (mock provider)** with mixed Q&A + natural-language control.
- **VLM panel** (multi-image upload/reorder/delete + mock analyze).

### Legacy (v1)
Legacy UI remains accessible for comparison:
`http://localhost:5173/?legacy=1`

## Setup & Run

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Run Dev Server (frontend)**:
   ```bash
   npm run dev
   ```
   Access at `http://localhost:5173` (v2 default).

3. **Run v2 WS Gateway (backend)**:
   ```bash
   npx tsx mcp-server/v2/index.ts
   ```
   Default port: `ws://localhost:3011`
   Default router provider: `mock` (`ROUTER_PROVIDER=mock`).
   Optional agent router provider: `agent` (`ROUTER_PROVIDER=agent`).

### Router policies / prompts
- Mock router keyword policy: `mcp-server/v2/router/policy/keywords.json` (override via `V2_ROUTER_KEYWORDS_PATH`)
- Mock router NLU policy: `mcp-server/v2/router/policy/mockProvider.json` (override via `V2_ROUTER_MOCK_POLICY_PATH`)
- Agent router prompt/skills/QA: `mcp-server/v2/router/agent/` (override via `ROUTER_AGENT_DIR`)

### Optional: Real LLM assist (with safe fallback)
- Default behavior stays deterministic mock routing, but the server will automatically prefer **Gemini → Ollama → mock** when `ROUTER_LLM_PROVIDER=auto` (default) and the provider is available.
- To force/disable real-model assist for chat Q&A + mate inference:
  ```bash
  export ROUTER_LLM_ENABLE=1      # set 0 to disable
  export ROUTER_LLM_PROVIDER=auto   # auto | ollama | gemini
  export ROUTER_LLM_MODEL=qwen3:30b
  ```
- To enable full agent routing (LLM decides tool calls):
  ```bash
  export ROUTER_PROVIDER=agent
  ```
- To enable server-side web tools (weather + web search):
  ```bash
  export ROUTER_WEB_ENABLE=1
  ```
- To enable structured VLM mate inference (multi-view → structured JSON):
  ```bash
  export V2_VLM_PROVIDER=auto   # auto | ollama | gemini | mock | none (default: auto)
  export VLM_MATE_MODEL=qwen3.5:27b   # for ollama
  ```
- **Ollama mode**:
  ```bash
  export OLLAMA_BASE_URL=http://127.0.0.1:11434
  # Optional fallback if ROUTER_LLM_MODEL / VLM_MATE_MODEL are not set
  export OLLAMA_MODEL=qwen3:30b
  ```
- Default split models (without extra env):
  - LLM router/chat: `qwen3:30b`
  - VLM mate inference: `qwen3.5:27b`
- **Gemini mode**:
  ```bash
  export GEMINI_API_KEY=your_key
  export GEMINI_MODEL=gemini-1.5-flash
  ```
- If real provider is unavailable/timeouts, router automatically falls back to mock heuristics.

### How to confirm Ollama is enabled
- Quick HTTP check: `curl http://127.0.0.1:11434/api/tags`
- CLI check: `ollama ps`
- In v2 UI: **AI Chat** header shows the active `LLM:` model (and tooltip includes Ollama reachability).
- If `api/tags` returns `{"models":[]}` → Ollama is running, but you haven’t pulled any model yet (run `ollama pull <model>`).

### Why CPU/GPU usage may stay low
- If no real provider is available, the router/VLM fall back to **mock** → almost no extra compute.
- If you use **Gemini** (`ROUTER_LLM_PROVIDER=gemini` or `V2_VLM_PROVIDER=gemini`), inference runs in the cloud → your local CPU/GPU won’t spike.
- If you use **Ollama**, it may still run on CPU depending on your install/driver; confirm with `ollama ps` and your system GPU monitor.

## Chat Examples (v2)

- Q&A:
  - `我要如何新增step`
  - `這個 usd model 是什麼`
- Natural control:
  - `mate part1 and part2`
  - `mate part1 bottom and part2 top use object aabb method`
  - `請幫我把 part1 跟 part2 對齊`
  - `切到 rotate 模式`
  - `把格線關掉`

## Testing

### Manual v2 Smoke
1. Open `http://localhost:5173`
2. Select a part in the left panel
3. Use **Mate** panel to align Top/Bottom
4. Add a step and verify timeline updates
5. Upload images in VLM panel → Analyze (mock)

### Automated Smoke Test (Playwright)
v2 smoke test: `tests/v2_smoke.spec.ts`

To run (requires Playwright setup):
```bash
npx playwright test
```

## Devflow (tri-agent automation)

- Automated Plan→PRD→Implementation→Testing pipeline (only pauses for Plan/PRD approval): `docs/DEVFLOW.md`
- CLI: `npm run devflow -- "your requirement"` (or `./devflow "your requirement"`)
- API server: `npm run devflow:server`
- Web UI: start `npm run devflow:server` then open `http://127.0.0.1:4170/`

## Project Structure (v2)
- `src/v2/app`: AppShell / layout
- `src/v2/three`: v2 Canvas + mating + anchors
- `src/v2/store`: v2 state + history
- `mcp-server/v2`: v2 WS gateway + router + VLM mock
- `shared/schema`: zod schemas (protocol/tools/trace/vlm)
