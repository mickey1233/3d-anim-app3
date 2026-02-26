# Skill: Mate Geometry Reasoning

## Overview

When a user commands an assembly, the frontend computes **geometry hints** from the live 3D scene
and sends them as context. The LLM uses these hints — together with the user's text and part names —
to decide `sourceFace`, `targetFace`, `mode`, and `method`.

Geometry is computed first; semantics (LLM) decides last.

---

## Context Fields Available

The `geometryHint` JSON block contains:

```json
{
  "expectedFacePair": { "sourceFace": "bottom", "targetFace": "top" },
  "sourceBboxSize": [width, height, depth],
  "targetBboxSize": [width, height, depth],
  "relativePosition": { "dx": 0.0, "dy": 0.15, "dz": 0.0 },
  "topRankingPairs": [
    {
      "sourceFace": "bottom", "targetFace": "top",
      "sourceMethod": "planar_cluster", "targetMethod": "planar_cluster",
      "score": 0.87, "facingScore": 0.94, "approachScore": 0.81
    },
    ...
  ]
}
```

---

## How to Read `expectedFacePair`

Derived from the dominant axis of the vector from source center → target center.

| Dominant axis | delta direction | Expected source face | Expected target face |
|---|---|---|---|
| Y (vertical) | target above source | `top` | `bottom` |
| Y (vertical) | target below source | `bottom` | `top` |
| X (horizontal) | target to the right | `right` | `left` |
| X (horizontal) | target to the left | `left` | `right` |
| Z (depth) | target in front | `front` | `back` |
| Z (depth) | target behind | `back` | `front` |

**Important**: This is a geometric *hint*, not a command.
- A lid on a bottle → target is BELOW (the bottle), source is ABOVE (the lid).
  So `expectedFacePair = {sourceFace: "bottom", targetFace: "top"}` ✓
- A plug going into a socket → target socket might be to the side.
  Geometry hint is correct for horizontal inserts too.

---

## How to Read `topRankingPairs`

The frontend scores all 36 face pair combinations (6×6) using:
- **facingScore** (weight 0.46): normals are anti-parallel (facing each other) — most important
- **approachScore** (weight 0.26): normals point toward each other's center
- **distanceScore** (weight 0.22): contact faces are geometrically close
- **expectedFaceScore** (weight 0.02): matches the positional expectedFacePair — tiny weight

The **top-ranked pair** is usually the best geometric match.

### When to follow topRankingPairs
- `facingScore > 0.8` AND `score > 0.75` → follow geometry; high confidence
- Part has clear flat faces (box-like, planar) → geometry is reliable

### When to override topRankingPairs
- User explicitly says "bottom to top" / "left face" → use that, ignore geometry
- Part names strongly imply orientation (lid → bottom face attaches)
- `facingScore < 0.5` → geometry is ambiguous, prefer semantic reasoning

---

## Face Definitions (World Space)

| Face | Direction | World axis |
|------|-----------|-----------|
| `top` | +Y | upward |
| `bottom` | -Y | downward |
| `front` | +Z | toward viewer |
| `back` | -Z | away from viewer |
| `right` | +X | rightward |
| `left` | -X | leftward |

**Note**: These are in the **part's local frame** mapped to world axes.
A part that is tilted 45° may have no perfectly flat top face.
In that case, use the face whose normal most closely aligns with +Y.

---

## Reasoning About Assembly Direction

### Step-by-step logic:

1. **What does the instruction say?**
   - Explicit face ("bottom to top", "左面", "front face") → use that directly
   - No face specified → continue to step 2

2. **What do part names suggest?**
   - "lid" / "cap" / "cover" / "蓋子" → lid's bottom face to bottle's top face
   - "plug" / "pin" / "peg" / "插頭" → plug's front/tip face toward socket's opening
   - "base" / "bottom" / "底座" → this is the target's top face
   - "bracket" / "mount" → flat face of bracket to mounting surface

3. **What does geometry say?**
   - Use `topRankingPairs[0]` from geometryHint if facingScore > 0.75
   - Use `expectedFacePair` as tiebreaker

4. **Output the chosen face pair with reasoning.**

---

## Geometry Signals for Insert vs Cover

### Insert signals (from bboxSize)
```
sourceSize[X] < targetSize[X] * 0.94  AND  sourceSize[Z] < targetSize[Z] * 0.94
→ source can fit inside target in XZ plane → likely insert along Y axis
```

### Cover signals (from relativePosition)
```
abs(dy) > (sourceSize[Y] + targetSize[Y]) * 0.22
AND overlapX > 50%  AND  overlapZ > 50%
→ parts are stacked vertically with horizontal overlap → likely cover
```

### Flush / default signals
- Parts are side-by-side (dx or dz dominant, small dy)
- Similar sizes with no containment
- → face pair determined purely by facingScore from geometry

---

## Scoring Weight Rationale

The 0.46 / 0.26 / 0.22 / 0.02 weights were calibrated to ensure:
- **Geometry normals dominate** (0.46 + 0.26 = 0.72): Two flat faces pointing at each other
  is the strongest signal for which faces should mate.
- **Distance matters** (0.22): Closer faces are more likely the intended contact surfaces.
- **Position hint is minimal** (0.02): If the user moves a part sideways in the scene,
  we do NOT want the face selection to flip. The norm-based scores are stable.
- **Area bonus** (max 0.04): Larger flat faces are preferred (more stable mate surface).

This means: **do not over-rely on relativePosition** for face selection.
Use it only as a weak tiebreaker.
