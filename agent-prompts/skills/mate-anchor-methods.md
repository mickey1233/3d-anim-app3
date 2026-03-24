# Skill: Mate Anchor Methods

## Overview

An **anchor method** controls how the system finds the contact point/frame on a face.
Different methods produce different anchor positions and normals, which directly affects
where and how the part lands after mating.

The LLM chooses the method based on **intent** and **part geometry description**.
The frontend tries methods in priority order and uses the first that succeeds.

---

## Available Methods

### `auto`
**When to use**: Unknown part geometry, or safe default when no intent information.
- Tries `planar_cluster` → `geometry_aabb` → `object_aabb` internally
- Always succeeds (fallback chain)
- Good for: simple box parts, unknown geometry

### `planar_cluster`
**When to use**: Parts with **flat faces** (the most common case).
- Groups triangles by surface normal → finds the dominant flat cluster for the face direction
- Produces accurate centroid on the actual flat surface
- Best for: machined parts, flat panels, boxes, brackets, frames
- **Default for cover intent** (both source and target have flat mating faces)

### `geometry_aabb`
**When to use**: Parts with complex geometry but you want the **mesh bounding box** face.
- Uses the bounding box of the mesh geometry (local space)
- Stable for rounded/curved parts where planar_cluster finds too many small clusters
- Best for: cylinders, organic shapes, curved surfaces

### `object_aabb`
**When to use**: Multi-mesh objects or assemblies where you want the **whole object** bounding box.
- Uses the bounding box of the entire object (including children)
- Best for: assemblies, objects with multiple sub-meshes

### `extreme_vertices`
**When to use**: Parts with **pointed tips, pins, or pegs** that insert into holes.
- Finds vertices at the extreme end along the face direction
- Produces the tip/point anchor rather than the centroid
- **Default for insert source** (the pin/peg tip goes into the socket)
- Best for: connector pins, pegs, bolts, needles, spikes, prongs

### `obb_pca`
**When to use**: Rotated or oddly-oriented parts.
- PCA-based Oriented Bounding Box: finds the principal axes of the geometry
- Best for: parts that are not axis-aligned, diagonal shapes
- Slower than other methods; use when others fail

### `picked`
**When to use**: User explicitly clicked a face in the 3D viewport.
- Uses the face the user manually selected
- Highest precision, but requires user interaction
- Only available when user says "pick face", "手動選面", or similar

---

## Method Priority by Intent

### `insert` intent
```
Source (the pin/peg/plug):
  Priority: extreme_vertices → planar_cluster → geometry_aabb → object_aabb → auto

Target (the hole/socket/cavity):
  Priority: planar_cluster → extreme_vertices → geometry_aabb → object_aabb → auto
```
**Reason**: The tip of a pin needs `extreme_vertices` (the actual tip, not centroid).
The socket opening needs `planar_cluster` (the flat rim around the hole).

### `cover` intent
```
Both source and target:
  Priority: auto → planar_cluster → geometry_aabb → object_aabb → extreme_vertices
```
**Reason**: Lids and box bodies usually have large flat faces.
`planar_cluster` works well, but `auto` is safe too. `extreme_vertices` is last
because we want the surface center, not the extreme tip.

### `default` intent
```
Both source and target:
  Priority: auto → planar_cluster → geometry_aabb → object_aabb → extreme_vertices
```
**Reason**: General case — geometry normals drive face selection, `planar_cluster` works
for most flat parts. `auto` as first try is safe.

---

## Explicit User Override

If the user mentions a method name, use that method first:

| User says | Method |
|-----------|--------|
| "object aabb", "obj aabb", "物件aabb" | `object_aabb` |
| "geometry aabb", "geo aabb", "幾何aabb" | `geometry_aabb` |
| "planar cluster", "平面分群" | `planar_cluster` |
| "extreme vertices", "極值點" | `extreme_vertices` |
| "obb", "pca", "obb pca" | `obb_pca` |
| "pick face", "手動選面", "picked" | `picked` |
| "auto", "自動" | `auto` |

Explicit user method → use as single priority, no fallback needed.

---

## Common Part-Type → Method Mapping

| Part description | Source method | Target method |
|-----------------|---------------|---------------|
| Flat plate / board | `planar_cluster` | `planar_cluster` |
| Box / cube | `planar_cluster` | `planar_cluster` |
| Cylinder (end-face) | `geometry_aabb` | `geometry_aabb` |
| Screw / bolt tip | `extreme_vertices` | `planar_cluster` |
| PCB pin header | `extreme_vertices` | `planar_cluster` |
| Connector housing | `planar_cluster` | `planar_cluster` |
| Organic/complex mesh | `geometry_aabb` | `geometry_aabb` |
| Assembly group | `object_aabb` | `object_aabb` |
| Peg / pin / dowel | `extreme_vertices` | `planar_cluster` |
| Snap clip | `extreme_vertices` | `planar_cluster` |

---

## Output Format

When specifying methods in `action.mate_execute` or `query.mate_suggestions`, use:

```json
{
  "sourceMethod": "extreme_vertices",
  "targetMethod": "planar_cluster"
}
```

If unsure, use `"sourceMethod": "auto", "targetMethod": "auto"`.
