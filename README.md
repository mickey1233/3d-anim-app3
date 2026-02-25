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
`http://localhost:5274/?legacy=1`

## Setup & Run

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Run Dev Server (frontend)**:
   ```bash
   npm run dev
   ```
   Access at `http://localhost:5274` (v2 default).

3. **Run v2 WS Gateway (backend)**:
   ```bash
   npx tsx mcp-server/v2/index.ts
   ```
   Default port: `ws://localhost:3112`
   Default router provider: `mock` (`ROUTER_PROVIDER=mock`).

### Optional: Real LLM assist (with safe fallback)
- Default behavior stays deterministic mock routing.
- To enable real-model assist for chat Q&A + mate inference:
  ```bash
  export ROUTER_LLM_ENABLE=1
  export ROUTER_LLM_PROVIDER=auto   # auto | ollama | gemini
  ```
- **Ollama mode**:
  ```bash
  export OLLAMA_BASE_URL=http://127.0.0.1:11434
  export OLLAMA_MODEL=qwen2.5:7b-instruct
  ```
- **Gemini mode**:
  ```bash
  export GEMINI_API_KEY=your_key
  export GEMINI_MODEL=gemini-1.5-flash
  ```
- If real provider is unavailable/timeouts, router automatically falls back to mock heuristics.

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
1. Open `http://localhost:5274`
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
- Web UI: start `npm run devflow:server` then open `http://127.0.0.1:4271/`

## Project Structure (v2)
- `src/v2/app`: AppShell / layout
- `src/v2/three`: v2 Canvas + mating + anchors
- `src/v2/store`: v2 state + history
- `mcp-server/v2`: v2 WS gateway + router + VLM mock
- `shared/schema`: zod schemas (protocol/tools/trace/vlm)
