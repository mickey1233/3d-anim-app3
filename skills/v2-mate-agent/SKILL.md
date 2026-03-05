---
name: v2-mate-agent
description: Maintain and extend the v2 AI-driven Mate (assembly) + chat routing pipeline. Use when refactoring hardcoded routing/assembly heuristics into policy/docs, tuning VLM multi-view mate inference (face/method/mode/intent), updating MCP tool schemas, or debugging why chat mate differs from the Mate panel.
---

# v2-mate-agent

## What this skill gives you
- A map of the **AI-first routing + mate** architecture (router agent + VLM structured mate).
- A workflow for moving “寫死” rules out of TS and into **policy/docs** that models can consume.
- Concrete debug steps + the fastest Playwright regressions to run.

## Key files (start here)
- Router (server):
  - `mcp-server/v2/wsGateway.ts` (handles `router_execute`, multi-iteration loop, tool proxy)
  - `mcp-server/v2/router/router.ts` (selects router provider)
  - `mcp-server/v2/router/agentProvider.ts` (LLM agent: reads `mcp-server/v2/router/agent/**/*.md`)
  - `mcp-server/v2/router/mockProvider.ts` (deterministic fallback; policy-driven)
  - Policies:
    - `mcp-server/v2/router/policy/keywords.json`
    - `mcp-server/v2/router/policy/mockProvider.json`
- Mate + tools (client):
  - `src/v2/network/mcpToolExecutor.ts` (`query.mate_vlm_infer`, `action.mate_execute`, multi-view capture)
- VLM structured mate (server):
  - `mcp-server/v2/vlm/analyze.ts` (bridges to structured mate)
  - `mcp-server/v2/vlm/structuredMate.ts` (provider + JSON repair/sanitize)
  - Prompt docs:
    - `mcp-server/v2/vlm/prompt/ASSEMBLY.md`
    - `mcp-server/v2/router/agent/knowledge/assembly.md`
- Schemas:
  - `shared/schema/mcpToolsV3.ts` (tool contracts)
  - `shared/schema/vlm.ts` (VLM result contracts)
- Tests:
  - `tests/v2_chat_router.spec.ts`
  - `tests/v2_query_mate_vlm_infer.spec.ts`
  - `tests/v2_mate_both_nested_parent.spec.ts`
  - `tests/v2_mate_vlm_cover_drift.spec.ts`
  - `tests/v2_mate_vlm_insert_drift.spec.ts`

## Workflow: remove hardcoded rules (“寫死”) safely

### 1) Prefer docs/policy over TS
- If it’s **parsing / synonyms / aliases / regex** → add it to router policy JSON (not TS):
  - `mcp-server/v2/router/policy/keywords.json`
  - `mcp-server/v2/router/policy/mockProvider.json`
- If it’s **mate semantics** (intent/mode/face/method meaning + examples) → update prompt docs:
  - `mcp-server/v2/vlm/prompt/ASSEMBLY.md`
  - `mcp-server/v2/router/agent/knowledge/assembly.md`

### 2) Keep the runtime agent in charge (AI-first)
- Router agent docs live in `mcp-server/v2/router/agent/`:
  - `SYSTEM.md` (hard rules: JSON only, allowed tools, query-before-action)
  - `WORKFLOWS.md` (multi-iteration patterns; e.g., mate = infer → execute)
  - `skills/*.md` (tool usage cheatsheets)
  - `qa/examples.md` (IO examples)

### 3) When mate feels wrong
- Confirm chat is doing **two-step** mate:
  1) `query.mate_vlm_infer` (multi-view capture + VLM)
  2) `action.mate_execute` (commit transform plan)
- Use fixtures to reproduce quickly:
  - `http://127.0.0.1:5173/?v=2&fixture=lid`
  - `http://127.0.0.1:5173/?v=2&fixture=slot`
  - `http://127.0.0.1:5173/?v=2&fixture=nested`
- If a heuristic/override is needed, make it:
  - **fallback-only** (AI wins when confident)
  - **configurable** (policy file) when possible
  - and **documented** in `ASSEMBLY.md`

## Local dev + fastest regressions
- Frontend: `npm run dev -- --host 127.0.0.1 --port 5173`
- v2 gateway: `npx tsx mcp-server/v2/index.ts`
- Focused tests:
  - `npx playwright test tests/v2_chat_router.spec.ts --reporter=line`
  - `npx playwright test tests/v2_query_mate_vlm_infer.spec.ts --reporter=line`
  - `npx playwright test tests/v2_mate_both_nested_parent.spec.ts --reporter=line`

## Env flags you’ll touch
- Router:
  - `ROUTER_PROVIDER=mock|agent`
  - `ROUTER_LLM_ENABLE=1` (agent/assist; safe fallback to mock)
  - `ROUTER_AGENT_DIR=...`
  - `V2_ROUTER_KEYWORDS_PATH=...`
  - `V2_ROUTER_MOCK_POLICY_PATH=...`
- VLM structured mate:
  - `VLM_MATE_GUIDE_PATH=...`
  - `V2_VLM_MOCK_PATTERNS_PATH=...`

## Notes
- Keep prompt/docs concise; put long explanations in the project docs and only load them when needed.
- Don’t add “AI-only” behavior to default Playwright runs; tests should pass with mock fallback.
