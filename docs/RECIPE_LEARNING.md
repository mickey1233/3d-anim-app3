# Recipe & Demonstration Learning

## Overview

Two-level learning system:

### Level 1: Exact Recipe Cache
**File**: `mcp-server/v2/router/mate-recipes.json`

When the same part pair appears again, the saved face/method is used directly — LLM is skipped entirely.

Trigger: user says "記住這個組裝" / "remember this mate"

Stored fields: sourceFace, targetFace, sourceMethod, targetMethod, whyDescription, pattern, antiPattern, geometrySignal

### Level 2: Pattern Injection (Generalization)
The `pattern` field (English generalizable rule) is injected as a few-shot example into every LLM inference prompt via `getLearningContext()`.

Example pattern: "When two identical parts are side-by-side horizontally, connect at facing lateral faces (right→left), NOT top/bottom."

### Level 3: Demonstration Priors
**File**: `mcp-server/v2/router/mate-demonstrations.json`

Richer records with:
- Feature pairs chosen by human
- Final transform applied
- Text explanation + generalizedRule + antiPattern
- Scene snapshot

Used in:
1. `findRelevantDemonstrations()` → `DemonstrationPriorScore[]`
2. Injected into LLM prompts via `getDemonstrationLearningContext()`
3. Candidate generation boost via `demonstrationPriors` option in `generateMatingCandidates()`
4. Solver scoring via `scoreDemoPriors()` in `solverScoring.ts`

## MCP Tools

- `mate.save_recipe` — save exact recipe + pattern
- `mate.record_demonstration` — save rich demonstration
- `agent.find_relevant_demonstrations` (WS) — fetch scored demo priors
- `agent.list_demonstrations` (WS) — list all demonstrations
