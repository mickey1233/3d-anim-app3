# Skill: Mate (Assembly)

> For deep rules, see:
> - `skills/mate-intent.md` — intent classification (insert/cover/default) with 15+ examples
> - `skills/mate-geometry.md` — how to read geometryHint, face scoring weights, direction reasoning
> - `skills/mate-anchor-methods.md` — method selection by intent and part type
> - `skills/vlm-visual-reasoning.md` — VLM visual analysis guide

---

## Triggers

Any of these in any language: `mate`, `組裝`, `裝配`, `對齊`, `align`, `attach`, `fit`,
`assemble`, `connect`, `join`, `組合`, `接合`, `安裝`, `install`, `mount`

**Requires**: ≥2 parts identifiable in user text or context.

---

## Quick Decision Flow

### 1. Identify parts (source moves, target stays)
- First-mentioned = source (default), second = target
- Override: "install X onto Y" → X is source, Y is target

### 2. Classify intent (see `mate-intent.md`)
- User keywords → `insert` / `cover` / `default`
- Geometry context as secondary signal

### 3. Select mode
| Intent | Generic command | Explicit "cover/蓋上/arc" | Explicit "screw/twist" |
|--------|----------------|--------------------------|----------------------|
| insert | `translate` | `translate` | `twist` |
| cover | `translate` | `both` | — |
| default | `translate` | — | — |

**`translate` is always the default. Never use `both` unless user explicitly says so.**

### 4. Select faces
- Explicit in user text → use those
- Geometry topRankingPairs[0] if facingScore > 0.75 → follow geometry
- Part name semantics (lid→bottom, bottle→top) → use semantic reasoning
- Fallback: bottom→top

### 5. Select method (see `mate-anchor-methods.md`)
- Explicit in user text → use that
- insert intent → source: `extreme_vertices`, target: `planar_cluster`
- cover/default → both: `planar_cluster` (or `auto`)

### 6. Two-pass strategy
- **No geometry hint AND no explicit faces**: emit `query.mate_suggestions` first (iteration 1)
- **Has geometryHint OR explicit faces**: emit `action.mate_execute` directly

---

## mateMode ↔ mode Mapping

| `mode` | `mateMode` | `pathPreference` |
|--------|-----------|-----------------|
| `translate` | `face_flush` | `auto` |
| `both` | `face_insert_arc` | `arc` |
| `twist` | `face_flush` | `auto` (+ twist config) |

---

## VLM Override

If context contains `vlmMateCapture.meetsThreshold === true`, prefer those values
for face/method/mode unless the user explicitly specified different ones.

VLM confidence ≥ 0.75 → use VLM params
VLM confidence < 0.75 → use geometry/LLM params

---

## action.mate_execute Args Template

```json
{
  "sourcePart": { "partId": "..." },
  "targetPart": { "partId": "..." },
  "sourceFace": "bottom",
  "targetFace": "top",
  "sourceMethod": "auto",
  "targetMethod": "auto",
  "mode": "translate",
  "mateMode": "face_flush",
  "pathPreference": "auto",
  "commit": true,
  "pushHistory": true,
  "stepLabel": "Mate <source> to <target>"
}
```
