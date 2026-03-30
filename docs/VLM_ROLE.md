# VLM Role in Assembly

## What VLM Does

### Layer 1 — Semantic Description (semanticDescriber.ts)
- Identifies part roles (lid, body, bracket, …)
- Classifies assembly intent (insert, cover, mount, …)
- Suggests contact regions and approach direction
- Hints at applicable solver families

### Multi-view Mate Inference (structuredMate.ts)
- Analyzes rendered screenshots of both parts
- Votes on face pairs, anchor methods
- Reranks geometry candidates by semantic plausibility

### Recipe Learning Context
- Injected as few-shot examples into LLM mate inference prompts
- Helps LLM generalize from saved human corrections

## What VLM Does NOT Do

- **Compute transforms** — geometry solver does this
- **Override geometry** — VLM hints; solver decides
- **Output final poses** — VLM output is always hints/description

## Failure Behavior

All VLM layers are failure-safe:
- semanticDescriber.ts returns null → system continues without semantic hints
- structuredMate.ts times out → falls back to geometry-only candidates
- agent.vlm_rerank_candidates fails → returns empty reranked list

## Configuration

Set AGENT_LLM_PROVIDER to control which LLM backs VLM calls:
- `gemini` (default) — requires GEMINI_API_KEY
- `ollama` — requires OLLAMA_BASE_URL
- `claude` — requires ANTHROPIC_API_KEY
- `openai` — requires OPENAI_API_KEY
- `none` — disables VLM entirely
