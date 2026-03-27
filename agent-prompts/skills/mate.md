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

### 6. ALWAYS use smart mate execute — NEVER skip this step

**For ALL mate commands, ALWAYS emit `action.smart_mate_execute` as the first and only tool call.**
This handles VLM analysis + execution in one step automatically.
Do NOT emit `query.mate_vlm_infer`, `action.mate_execute`, or `query.mate_suggestions` directly.

```json
{
  "tool": "action.smart_mate_execute",
  "args": {
    "sourcePart": { "partId": "<id of source part>" },
    "targetPart": { "partId": "<id of target part>" }
  }
}
```

- If user specified explicit faces (e.g. "bottom to top"), add `"sourceFace": "bottom", "targetFace": "top"` to args.
- If user specified a mode (e.g. "with rotation"), add `"mode": "both"` to args.

---

## Remembering a Mate (Learning from User Correction)

**Triggers**: `remember this mate`, `記住這個組裝`, `learn this`, `save this mate`, `記住`, `學習這個`, `讓ai學習`

There are TWO levels of learning:

### Level 1 — Exact match (same parts next time → skip LLM)
### Level 2 — Generalizable pattern (similar situation next time → LLM applies the rule)

**Both levels are saved together in a single `mate.save_recipe` call.**

### Workflow

**Step 1** — If the user has NOT already explained why: reply first asking for the reason.
> "好的，我記住了 {sourceName} ({sourceFace}) → {targetName} ({targetFace}) 這個組裝方式。
> 你能告訴我為什麼這樣組裝嗎？這樣下次遇到類似情況，我也能舉一反三。
> 例如：「因為這兩個零件是並排的，不能疊在一起」"

**Step 2** — Once you have both the face config AND the reason, call `mate.save_recipe` with ALL fields:

```json
{
  "tool": "mate.save_recipe",
  "args": {
    "sourceName": "<source part name>",
    "targetName": "<target part name>",
    "sourceFace": "<face>",
    "targetFace": "<face>",
    "sourceMethod": "planar_cluster",
    "targetMethod": "planar_cluster",
    "whyDescription": "<user's explanation in their own words>",
    "pattern": "<your English generalization of the rule, suitable for future LLM reasoning>",
    "antiPattern": "<what NOT to do and why>",
    "geometrySignal": "<geometry characteristics that identify this situation>"
  }
}
```

**Step 3** — Confirm:
> "已學習完成！
> ✓ 記住了 {sourceName} ↔ {targetName} 的精確組裝方式
> ✓ 學習規則：{pattern}
> 下次遇到類似情況，我會套用這個規則。"

### How to generate the `pattern` field

The `pattern` should generalize from the specific example to a broader rule:
- Bad: "HOR_FAN_LEFT uses right face"
- Good: "When two identical/similar parts are positioned side-by-side horizontally (same Y height, different X), connect at their facing lateral faces (right→left or left→right). Do NOT use top/bottom which stacks them vertically."

Consider:
- **Part type**: fan / screw / cover / connector / base — what is this type of part?
- **Relative position**: same height and side-by-side? one clearly above the other? one inside the other?
- **Assembly intent**: cover, insert, join side-by-side, stack
- **Wrong assumption to avoid**: what did the AI assume incorrectly?

### Example

User corrects: HOR_FAN_LEFT (right) → HOR_FAN_RIGHT (left)
User says: "因為這兩個風扇是左右並排的，不能疊在一起"

Generated pattern:
- `whyDescription`: "這兩個風扇是左右並排的，不能疊在一起"
- `pattern`: "When two identical or similar parts (e.g. fans, modules) are positioned side-by-side horizontally (similar Y height, significant horizontal X offset), connect at their facing lateral faces (right→left or left→right). Do NOT use top/bottom which would stack them vertically."
- `antiPattern`: "Do NOT use bottom→top for side-by-side parts — that stacks them on top of each other instead of joining them at their shared inner face."
- `geometrySignal`: "same bbox dimensions, large dx (horizontal offset), near-zero dy (same height), parts are the same type"

**Important**: `pattern` is injected into EVERY future mate inference prompt, even for unseen parts. Write it to be useful for reasoning about new situations.

---

## mateMode ↔ mode Mapping (for reference only — VLM decides this)

| `mode` | `mateMode` | `pathPreference` |
|--------|-----------|-----------------|
| `translate` | `face_flush` | `auto` |
| `both` | `face_insert_arc` | `arc` |
| `twist` | `face_flush` | `auto` (+ twist config) |
