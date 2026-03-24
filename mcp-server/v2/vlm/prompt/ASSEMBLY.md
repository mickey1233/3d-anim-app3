# Assembly intent / mode / face guide (project-specific)

This file is injected into the VLM/VLA prompt to reduce hardcoded logic in code and to improve reasoning across different assembly scenarios.

## Spark Product Assembly Rules (highest priority — overrides generic rules below)

**All parts in this Spark assembly ALWAYS insert/cover along the LOCAL Y-axis (vertical).**

- Default face pair: `source_face=bottom`, `target_face=top`
- Exception: only deviate from bottom→top if the geometry candidate list has ZERO viable vertical pair
- When you see screw holes or snap pins, they are on the BOTTOM face of one part and the TOP face of the other
- Role semantics: cap / lid / cover / connector / plug = **source** (the part that moves); base / body / housing / chassis / frame = **target** (fixed part)
- If you cannot determine roles visually, default to: the smaller/lighter-looking part is source

**Two-step reasoning (fill "reasoning" field before selecting candidate):**
1. Describe each part in ≤5 words (e.g., "spark plug cap", "engine block port")
2. State which covers/inserts into which and why
3. Then select the geometry candidate with bottom→top faces (or closest vertical pair)

## What you must infer
- **Relationship** between the two parts (cover / insert / flush / side attach / screw-like / hinge-like).
- **Intent** (`default|cover|insert`)
- **Mode** (`translate|twist|both`) describing whether motion needs translation, rotation, or both.
- **Faces** (`top/bottom/left/right/front/back`) for source and target.
- **Methods** (`planar_cluster|face_projection|geometry_aabb|object_aabb|obb_pca|picked`) to compute anchors/normals.

## Coordinate frame (important)
- Face labels follow the part's **LOCAL coordinate axes** (they rotate with the part):
  - `top` = local +Y, `bottom` = local −Y
  - `right` = local +X, `left` = local −X
  - `front` = local +Z, `back` = local −Z
- If the whole assembly is rotated/moved in the scene, face meaning should stay stable.
- Prefer inferences that remain valid under global pose changes.

## Definitions
- `intent=cover`: a lid/cap/shell should end up **closing or covering** the target (lid→base, cap→bottle, cover→housing).
- `intent=insert`: a plug/pin/key should end up **inside a socket/slot/hole** of the target (plug→socket, pin→hole, key→keyway).
- `intent=default`: generic flush alignment / attach when cover/insert is not the dominant relation.

- `mode=translate`: move only; orientation already correct. Use only when source and target face normals are already aligned (both parts have the same world orientation).
- `mode=twist`: rotate only (or rotation-dominant); translation is small.
- `mode=both`: needs both rotation + translation. **Required whenever the source has been rotated** relative to the target. Also common for cover/insert when normals are not aligned.

**Critical rule**: If the metadata shows `hasRotationMismatch=true` or `rotationMismatchDeg > 5`, you MUST output `mode=both`. Never output `mode=translate` when the source part has been manually rotated (non-identity quaternion relative to target).

## Twist skill — when and how to specify

**When to use twist** (within `mode=both`):
- Source face normal aligns to target, but the part ends up rotated around that axis at the wrong angle (e.g., screw holes don't line up, connector keys are misoriented).
- Use twist to rotate around the mating face normal to correct the in-plane orientation.

**Twist axis choices:**
| axisSpace | axis | When to use |
|-----------|------|-------------|
| `target_face` | `normal` | Spin around the face normal (most common — corrects in-plane rotation) |
| `target_face` | `tangent` | Spin around the horizontal axis of the face (tilts the part) |
| `target_face` | `bitangent` | Spin around the depth axis of the face (tilts the other way) |
| `world` | `x` / `y` / `z` | Spin around a world axis (use when the scene is axis-aligned and the rotation axis is obvious) |

**Default twist behavior (no twist specified)**: The solver auto-computes minimal twist via `computeTwistFromTangents` to align face tangents. This handles most cases automatically.

**Override twist via chat**: `"mate part1 base twist 90"` → 90° around face normal; `"mate part1 base spin 45 tangent"` → 45° around tangent; `"mate part1 base twist 180 x"` → 180° around world X.

## Common scenarios (examples)
1) **Lid on base (cover)**: `intent=cover`, often `bottom -> top` (lid bottom to base top). Use `mode=translate` if normals are already aligned; otherwise `mode=both`.
2) **Bottle cap screw-on**: `intent=cover`, often `mode=twist` or `mode=both` (rotate while moving along axis).
3) **Plug into socket (insert)**: `intent=insert`, `mode=translate` if keyed orientation already matches, else `mode=both`.
4) **Rail/slide**: mostly `mode=translate`; intent can be insert-like or default depending on whether it ends up inside a channel.
5) **Snap-fit clip**: often `mode=both`; bbox-based methods can be misleading.
6) **Hinge/pin**: usually `insert` + `both`; align axis/normal then insert along axis.
7) **Side panel attach**: `default` or `cover`, often `translate`, typically `left<->right` or `front<->back`.
8) **Bayonet / quarter-turn lock**: often `cover`, `mode=both` (twist while moving along axis); choose faces aligned to the locking axis.
9) **Dovetail / slide-in**: `insert` or `default`, mostly `translate` along one axis; faces often `left/right` or `front/back`.
10) **Press-fit / tight insertion**: `insert`, `mode=translate` (or `both` if keyed); avoid `object_aabb` when protrusions hide the true cavity.
11) **Alignment pins / dowels**: `insert`, `mode=translate` if already oriented, else `both`; faces depend on the insertion axis (not always `bottom/top`).

## Method selection guidance
- `face_projection` — Selects the planar face cluster whose **center** is most extreme along the requested local axis (highest center.Y for "top", etc.). Unlike `planar_cluster` (which picks by normal alignment), `face_projection` picks by geometric position — the topmost/bottommost/etc. face group. Preferred for complex CAD parts with no large flat face aligned to an axis. Result position is similar to `geometry_aabb` but placed on an actual face surface.
- If a **slot / recess** exists, bbox can overestimate clearance. Avoid choosing `object_aabb` as the only method; consider `planar_cluster`, `face_projection`, or `obb_pca`.
- Prefer methods that describe the **actual contact surface** over methods dominated by external protrusions.
- If the candidate list already contains an insert-friendly method pair, prefer it for `intent=insert` unless images strongly contradict.

## Insert operations (critical)

When `geometry.intent=insert`:
- The source part goes INSIDE the target (plug into socket, PCB into housing, pin into hole).
- The **target face** is the **opening of the cavity** — for upright parts this is almost always `top` (local +Y), the open side where you insert things.
- The **source face** is the face that enters the cavity first — almost always `bottom` (local −Y), pointing toward the opening.
- **Default insert pair: `source(bottom) → target(top)`**. Use this unless geometry candidates show a different axis.
- Ignore visual appearance when the source is rotated — the correct face is determined by the cavity geometry, NOT by which side of the source visually faces toward the target in the scene images.

When `geometry.intent=insert` AND `geometry.suggestedMode=both` (rotation mismatch):
- The source part has been physically rotated. Its visual appearance is **misleading** — do NOT change the face selection based on rotation.
- Use `geometry.rankingTop` (pre-computed from geometry) as your primary candidate selection.
- `geometry.expectedFromCenters` gives the correct insert axis — trust it over your visual assessment.

## Rotation metadata (authoritative — do not override with visual guess)
- `sceneRelation.hasRotationMismatch`: if `true`, source and target have different world orientations. Face normals will NOT align via translation alone. **Always output `mode=both`** in this case.
- `sceneRelation.rotationMismatchDeg`: angle in degrees between source and target world quaternions. >5° means rotation is needed. >15° means significant misalignment.
- `geometry.suggestedMode`: the geometry system's mode recommendation, already accounting for rotation mismatch. Prefer this over your visual assessment for `mode`.

## Multi-view evidence guidance
- Side views can be ambiguous. Prefer **Top** + **source_to_target / target_to_source** views for disambiguation.
- Use the provided view names only. Provide `view_votes` for as many views as possible.
- Choose one geometry candidate when possible, and keep face/method fields consistent with it.
