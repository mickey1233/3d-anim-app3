# Assembly Mode and Twist Knowledge

## Mode Selection

### `mode=translate`
Use only when source and target parts have the same world orientation (quaternions are nearly identical, < 5° difference). The solver will move the source to align its face with the target face without any rotation.

**Example**: Both parts axis-aligned, stacking part1 on top of base. part1 bottom → base top, no rotation needed.

### `mode=both` (most common)
Use when source and target have different world orientations OR when face normals won't align via translation alone. The solver applies both a rotation (to align face normals) and a translation.

**Always use `mode=both` when**:
- `sceneRelation.hasRotationMismatch = true` (source was manually rotated)
- `sceneRelation.rotationMismatchDeg > 5`
- Source and target visually appear at different angles to each other
- Cover/insert/snap-fit relationships where normals must be brought into alignment

**Example**: part1 rotated 45° on Y axis relative to base → mate part1 to base needs `mode=both` to first rotate part1's bottom face normal to match base's top face normal, then translate.

### `mode=twist`
Use only when the parts are already translationally aligned and only need a pure rotation. Rare in practice.

---

## Twist Skill

After `mode=both` aligns face normals, there may be residual in-plane rotation (the part is correctly seated but rotated around the mating axis). Twist corrects this.

### Auto twist (default)
When no twist is specified, `computeTwistFromTangents` automatically minimizes residual rotation by aligning face tangents. This works well for most assemblies.

### Manual twist override
Specify twist when the auto-computed alignment is wrong (e.g., screw holes need to be at a specific angle, connector keys must orient a specific way).

Chat syntax:
- `"mate part1 base twist 90"` → 90° around face normal (target_face/normal)
- `"mate part1 base twist -45 tangent"` → -45° around face tangent
- `"mate part1 base spin 180 x"` → 180° around world X axis
- `"mate part1 base twist 0"` → explicit zero twist (overrides auto)

### Twist axis and space combinations

#### `axisSpace: 'target_face'` (most common)
The axis is defined relative to the target face's local coordinate frame:

| axis | Description | Use when |
|------|-------------|----------|
| `normal` | Perpendicular to face (in/out direction) | Spinning part around the mating axis — corrects in-plane orientation (most common) |
| `tangent` | Horizontal direction of face | Tilting relative to face horizontal |
| `bitangent` | Depth direction of face | Tilting relative to face depth |

#### `axisSpace: 'world'`
The axis is a fixed world axis (X/Y/Z). Use when:
- The scene is clearly axis-aligned
- The user specifies a world axis explicitly ("twist 90 around Y")
- The assembly has a known orientation in world space

| axis | Description |
|------|-------------|
| `x` | World X axis |
| `y` | World Y axis (vertical in most scenes) |
| `z` | World Z axis |

#### `axisSpace: 'source_face'`
The axis is defined relative to the source face frame (after normal rotation). Rarely needed; use when the source's own frame is more intuitive than the target's.

### When to change twist space

**Use `target_face/normal`** (default) when:
- Correcting rotational misalignment after flush mating
- The user says "rotate N degrees" or "twist N degrees" without specifying an axis

**Use `world`** when:
- The user explicitly says "rotate around X/Y/Z"
- The part needs to align with a world-space feature (e.g., a horizontal slot)
- The assembly is clearly axis-aligned and world axes are intuitive

**Use `target_face/tangent` or `bitangent`** when:
- The part needs to be tilted relative to the mating face (not spun around its normal)
- This is unusual — most twist corrections are around the normal axis

---

## Anchor Method Reference

| Method | Selection Logic | Best For |
|--------|----------------|----------|
| `planar_cluster` | Face cluster with normal most aligned to the requested direction | Simple geometry with clear flat faces (boxes, cylinders, plates) |
| `face_projection` | Face cluster whose **center** is most extreme along the requested axis | Complex CAD parts with no large axis-aligned face; when all 6 faces resolve to the same location with `planar_cluster` |
| `geometry_aabb` | Geometry bounding box face in the requested direction | Quick fallback; may be off if protrusions extend the bbox |
| `object_aabb` | World-space bounding box (includes all children) | Rough positioning only; avoid for slots/recesses |
| `obb_pca` | PCA-oriented bounding box | Diagonally-placed or rotated parts |
| `picked` | Exact user-clicked face | When user selects a specific face interactively |

### When to use `face_projection`

Use `face_projection` instead of `planar_cluster` when:
- The part has **complex or organic geometry** with many small faces at varied angles (no dominant flat face).
- All 6 face IDs (`top`/`bottom`/`left`/`right`/`front`/`back`) seem to anchor at the **same point** — this indicates `planar_cluster` is always picking the same cluster because none has a strongly aligned normal.
- The part is a **real-world CAD import** (e.g., engine parts, connectors, spark plug bodies) rather than a simple primitive.
- `geometry_aabb` gives the right ballpark position but you want the anchor to land on **actual geometry** rather than an imaginary bbox face.

`face_projection` is safe to use as the default method for any part — it degrades gracefully to a reasonable position even when geometry is simple.

## Decision Tree for Mode

```
Is sceneRelation.hasRotationMismatch = true?
  YES → mode=both (always, regardless of visual appearance)
  NO  →
    Are parts both axis-aligned (quaternions match)?
      YES → mode=translate (if just stacking/sliding)
      NO  → mode=both
    Is it cover/insert/snap-fit?
      YES → mode=both (face normals likely need alignment)
      NO  → follow geometry.suggestedMode
```

## Decision Tree for Twist Space

```
User specifies axis by name (x/y/z)?
  YES → axisSpace=world, axis=x|y|z
  NO  →
    User says "around normal" or no axis specified?
      YES → axisSpace=target_face, axis=normal (default)
    User says "tangent"?
      YES → axisSpace=target_face, axis=tangent
    User says "bitangent"?
      YES → axisSpace=target_face, axis=bitangent
```
