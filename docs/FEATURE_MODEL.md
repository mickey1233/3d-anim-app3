# Feature Model: Assembly Feature Types

## Overview

The v3 feature model describes assembly geometry in terms of **semantic features** rather
than raw mesh clusters. Each feature is an `AssemblyFeature` record with a type, pose,
dimensions, and a semantic role.

Features are extracted by `featureExtractor.ts` and matched by `featureMatcher.ts`.

---

## Feature Types

### `planar_face`
A large flat surface suitable for mating or support.

| Field | Description |
|-------|-------------|
| `pose.localAxis` | Face normal in part-local space |
| `dimensions.area` | Surface area in m² |
| `dimensions.tolerance` | ~1% of sqrt(area) |
| Extraction | `clusterPlanarFaces` from faceClustering.ts |
| Confidence | Scales with area (large faces = high confidence) |
| Role | `support` |

**Physical meaning**: Top surface of a box, mounting flange, PCB face, shelf surface.

---

### `cylindrical_hole`
A circular hole (through or blind). Detected by fitting circles to plane cluster vertices.

| Field | Description |
|-------|-------------|
| `pose.localAxis` | Hole axis (normal of the containing face) |
| `dimensions.diameter` | Hole diameter in meters |
| `dimensions.depth` | Hole depth (null = through-hole) |
| `dimensions.tolerance` | ~10% of diameter |
| Extraction | `circle_fit` — least-squares algebraic circle fit |
| Confidence | 1 - 4*residual (lower residual = higher confidence) |
| Role | `receive` |

**Physical meaning**: Screw hole, pin receptacle, press-fit bore, alignment hole.

---

### `blind_hole`
Non-through pocket. Same structure as `cylindrical_hole` but `depth` is finite.

Currently extracted as `cylindrical_hole` with non-null depth. Distinction may be important
for insertion feasibility checks.

---

### `peg`
A protruding cylinder or pin above the main support plane.

| Field | Description |
|-------|-------------|
| `pose.localAxis` | Peg axis (same direction as support face normal) |
| `dimensions.diameter` | Peg diameter in meters |
| `dimensions.depth` | Peg height above support plane |
| `dimensions.tolerance` | ~10% of diameter |
| Extraction | `peg_detect` — cluster vertices above support plane, circle fit |
| Confidence | 0.7 * (1 - 3*residual) |
| Role | `insert` |

**Physical meaning**: Alignment pin, snap post, PCB standoff, dovetail protrusion.

---

### `slot`
A rectangular or curved channel. Detection is currently a stub.

| Field | Description |
|-------|-------------|
| `pose.localAxis` | Slot depth axis |
| `pose.localSecondaryAxis` | Slot long axis |
| `dimensions.length` | Slot length |
| `dimensions.width` | Slot width |
| `dimensions.depth` | Slot depth |
| Extraction | `slot_detect` (TODO — stub) |
| Role | `receive` |

**Physical meaning**: T-slot, linear rail channel, PCB card slot, keyed slot.

---

### `peg` (variants)
- Standard peg: circular cross-section, protrudes along face normal
- Tab peg: flat protrusion (future: `tab` type)

---

### `tab`
Flat protruding tongue or latch feature. Not yet extracted automatically.

| Role | `insert` |
| Extraction | `manual` or `vlm_hint` |

---

### `socket`
Recessed receptacle for an edge connector or plug.

| Role | `receive` |
| Extraction | `manual` or `vlm_hint` |

---

### `rail`
Linear guide channel.

| Role | `align` |
| Extraction | `slot_detect` (shared with slot, distinguished by length > 3× width) |

---

### `edge_notch`
Cutout at a part edge.

| Role | `unknown` |
| Extraction | `manual` or `vlm_hint` |

---

### `edge_connector`
PCB-style edge connector.

| Role | `insert` |
| Extraction | `manual` or `vlm_hint` |

---

### `support_pad`
Standoff or mounting pad — a small raised planar feature.

| Role | `support` |
| Extraction | `planar_cluster` (same as planar_face, distinguished by area threshold) |

---

## Semantic Roles

| Role | Meaning | Typical Feature Types |
|------|---------|-----------------------|
| `insert` | Moves into receiving feature | peg, tab, edge_connector |
| `receive` | Accepts an insert | cylindrical_hole, blind_hole, slot, socket |
| `fasten` | Screw hole, snap, clip | cylindrical_hole (threaded) |
| `support` | Load-bearing surface | planar_face, support_pad |
| `align` | Guide/alignment | rail, peg (as alignment pin) |
| `seal` | Sealing surface | planar_face (gasketed) |
| `unknown` | Unclassified | edge_notch, any unrecognized |

---

## Confidence Levels

| Confidence | Meaning |
|------------|---------|
| 0.9 – 1.0 | High: large planar face or near-perfect circle fit |
| 0.6 – 0.9 | Medium: moderate area or reasonable circle residual |
| 0.3 – 0.6 | Low: small feature or high residual |
| 0.0 – 0.3 | Very low: barely detected, likely noise |

---

## Extraction Pipeline Summary

```
extractFeatures(obj, partId)
    │
    ├── Stage 1: extractPlanarFaceFeatures()
    │       clusterPlanarFaces() per mesh child
    │       → planar_face features (one per cluster)
    │
    ├── Stage 2: extractCircleHoleFeatures()
    │       project vertices onto each planar cluster
    │       fitCircleToPoints2D() (algebraic least squares)
    │       → cylindrical_hole features
    │
    ├── Stage 3: extractPegFeatures()
    │       find largest upward-facing planar feature (support plane)
    │       cluster vertices above support plane
    │       fitCircleToPoints2D() on each spatial cluster
    │       → peg features (only if circle < 50% of support face area)
    │
    └── Stage 4: extractSlotFeatures()  [stub, returns []]
            TODO: parallel edge pair matching
```

---

## Mapping to v2 Face System

| v3 Feature | v2 Equivalent |
|------------|---------------|
| `planar_face` (faceId=top) | `resolveAnchor(object, 'top', 'planar_cluster')` |
| `planar_face` (faceId=bottom) | `resolveAnchor(object, 'bottom', 'planar_cluster')` |
| `cylindrical_hole` | No equivalent — new in v3 |
| `peg` | No equivalent — new in v3 |
| AnchorResult.centerLocal | FeaturePose.localPosition |
| AnchorResult.normalLocal | FeaturePose.localAxis |

The v3 feature system is additive — it does not replace the v2 face/anchor system.
