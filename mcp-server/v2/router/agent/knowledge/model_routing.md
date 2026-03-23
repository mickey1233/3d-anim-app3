# Model Routing Rules

This document defines which AI model to use for each type of user request.
The routing agent reads this file to decide the `targetModel` before calling the execution model.

## Available Models

| Model ID              | Description                                 | Cost | Speed |
|-----------------------|---------------------------------------------|------|-------|
| `gpt-4o`              | OpenAI GPT-4o — best reasoning, vision      | High | Med   |
| `gpt-4o-mini`         | OpenAI GPT-4o-mini — fast, cheap, capable   | Low  | Fast  |
| `o3-mini`             | OpenAI o3-mini — deep reasoning / planning  | Med  | Slow  |
| `ollama`              | Local Ollama model (offline / privacy)      | Free | Varies|
| `gemini`              | Google Gemini (fallback)                    | Low  | Fast  |

## Routing Rules (evaluate in order, pick the FIRST match)

### 1. Complex 3D assembly / mate operations
**Trigger**: User mentions mate, face, anchor, insert, cover, rotate, align, planar_cluster, face_projection, VLM, multi-step, assembly sequence
**→ targetModel**: `gpt-4o`
**Reason**: Needs strong spatial reasoning + knowledge of the assembly knowledge docs

### 2. Simple scene control
**Trigger**: grid, view, environment, lighting, select, mode, undo, redo, reset, step, label, snapshot
**→ targetModel**: `gpt-4o-mini`
**Reason**: Straightforward tool-call mapping, no complex reasoning needed

### 3. Code / schema / JSON generation
**Trigger**: User wants to generate code, write schema, debug TypeScript, fix import, explain function
**→ targetModel**: `gpt-4o`
**Reason**: Code tasks benefit from GPT-4o's strong coding ability

### 4. Deep planning / multi-step reasoning
**Trigger**: "plan how to", "figure out the best way", "what is the optimal", "compare", "analyze"
**→ targetModel**: `o3-mini`
**Reason**: o3-mini excels at chain-of-thought planning tasks

### 5. Simple Q&A / chat / general questions
**Trigger**: Any short conversational message, greetings, general questions not related to 3D assembly
**→ targetModel**: `gpt-4o-mini`
**Reason**: Fast and cheap for simple responses

### 6. Privacy / offline required
**Trigger**: User explicitly requests offline or local processing
**→ targetModel**: `ollama`
**Reason**: Local model, no data leaves the machine

### 7. Fallback
**Trigger**: None of the above match
**→ targetModel**: `gpt-4o-mini`

## Output Format for Routing Decision

The router must output JSON only:
```json
{
  "targetModel": "<model id from the table above>",
  "reason": "<one sentence why>"
}
```
