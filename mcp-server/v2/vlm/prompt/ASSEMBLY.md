# Assembly intent / mode / face guide (project-specific)

This file is injected into the VLM/VLA prompt to reduce hardcoded logic in code and to improve reasoning across different assembly scenarios.

## What you must infer
- **Relationship** between the two parts (cover / insert / flush / side attach / screw-like / hinge-like).
- **Intent** (`default|cover|insert`)
- **Mode** (`translate|twist|both`) describing whether motion needs translation, rotation, or both.
- **Faces** (`top/bottom/left/right/front/back`) for source and target.
- **Methods** (`planar_cluster|geometry_aabb|object_aabb|obb_pca|picked`) to compute anchors/normals.

## Coordinate frame (important)
- Face labels are interpreted in the **capture frame** (target-part frame), not fixed world axes.
- If the whole assembly is rotated/moved in the scene, face meaning should stay stable.
- Prefer inferences that remain valid under global pose changes.

## Definitions
- `intent=cover`: a lid/cap/shell should end up **closing or covering** the target (lid→base, cap→bottle, cover→housing).
- `intent=insert`: a plug/pin/key should end up **inside a socket/slot/hole** of the target (plug→socket, pin→hole, key→keyway).
- `intent=default`: generic flush alignment / attach when cover/insert is not the dominant relation.

- `mode=translate`: move only; orientation already correct.
- `mode=twist`: rotate only (or rotation-dominant); translation is small.
- `mode=both`: needs both rotation + translation (very common for cover/insert when normals are not aligned).

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
- If a **slot / recess** exists, bbox can overestimate clearance. Avoid choosing `object_aabb` as the only method; consider `planar_cluster` or `obb_pca`.
- Prefer methods that describe the **actual contact surface** over methods dominated by external protrusions.
- If the candidate list already contains an insert-friendly method pair, prefer it for `intent=insert` unless images strongly contradict.

## Multi-view evidence guidance
- Side views can be ambiguous. Prefer **Top** + **source_to_target / target_to_source** views for disambiguation.
- Use the provided view names only. Provide `view_votes` for as many views as possible.
- Choose one geometry candidate when possible, and keep face/method fields consistent with it.
