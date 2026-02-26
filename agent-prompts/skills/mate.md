# Skill: Mate (Assembly)

## Triggers

Any of these in any language: `mate`, `組裝`, `裝配`, `對齊`, `align`, `attach`, `fit`, `assemble`, `connect`, `join`, `組合`, `接合`

**Requires**: ≥2 parts identifiable in user text or context.

## Mode Selection (critical — never deviate)

| mode | When to use |
|------|-------------|
| `translate` | **Default for ALL generic assembly** — mate/組裝/align/attach/fit/assemble/connect/join |
| `both` | **ONLY** when user explicitly says: cover/insert/arc/蓋上/插入/套入/蓋起來/卡入 |
| `twist` | **ONLY** when user says: twist/旋轉後插入/twist and insert |

**If in doubt, always use `translate`.** Never escalate to `both` for generic commands.

When `mode=both`, set `mateMode: "face_insert_arc"` and `pathPreference: "arc"`.
When `mode=translate`, set `mateMode: "face_flush"` and `pathPreference: "auto"`.

## Source / Target Assignment

- **Source** = the part that MOVES
- **Target** = the fixed base part
- When ambiguous: **first-mentioned part = source**, second-mentioned = target
- Override with explicit verbs: install/mount/place/plug/insert/蓋/放到/裝到 → the thing being installed is source

## Face Selection

- Infer from user wording and geometry (positions, bboxSize)
- Face aliases: top/上/頂部, bottom/下/底部, left/左, right/右, front/前, back/後/背
- If the user says "bottom to top" or "上面對下面", use those directly
- If no face is specified and no suggestion context exists, fall through to `query.mate_suggestions` first

## Anchor Method

- Explicitly mentioned → use it (`object_aabb`, `planar_cluster`, `geometry_aabb`, `extreme_vertices`, `obb_pca`, `picked`)
- Default: `"auto"`

## VLM Override

If context contains `vlmMateCapture.meetsThreshold === true`, prefer those faces/method/mode values unless the user explicitly specified different ones.

## Two-pass Strategy

1. **No explicit faces AND no suggestion context AND no VLM**: emit `query.mate_suggestions` first, wait for iteration 2
2. **Has suggestion context OR explicit faces**: emit `action.mate_execute` directly

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
