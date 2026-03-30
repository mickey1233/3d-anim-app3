# Mate Solver V3 — Feature-Based Assembly

## Overview

The feature-based assembly pipeline (v3) replaces the pure face-based approach with:
1. Feature extraction from mesh geometry
2. Feature-pair compatibility scoring
3. Kabsch SVD alignment for multi-point constraints
4. Solver scoring framework for solver family selection

## Feature Types

| Type | Description | Status |
|------|-------------|--------|
| planar_face | Large flat face cluster | ✅ Implemented |
| cylindrical_hole | Circular hole (Pratt fit) | ✅ Implemented |
| blind_hole | Non-through hole | ✅ Implemented |
| peg | Protruding cylindrical pin | ✅ Implemented |
| slot | Slot/pocket recess | ✅ Implemented |
| tab | Thin protruding tab | ⏳ Planned |
| socket | Recessed socket | ⏳ Planned |
| rail | Linear rail/groove | ⏳ Planned |
| edge_notch | Notch on edge | ⏳ Planned |
| edge_connector | PCB-style edge connector | ⏳ Planned |
| support_pad | Mounting support pad | ⏳ Planned |

## Solver Families

| Family | Algorithm | Status |
|--------|-----------|--------|
| plane_align | Face-flush translate | ✅ Implemented |
| peg_hole | Single-pair insertion | ✅ Implemented |
| pattern_align | Kabsch SVD (multi-point) | ✅ Implemented |
| slot_insert | Slot-pocket constraint | ⏳ Planned |
| rim_align | Circular rim-opening | ⏳ Planned |
| rail_slide | Rail-groove sliding | ⏳ Planned |

## MCP Tools

- `query.extract_features` — extract AssemblyFeature[] for a part
- `query.generate_candidates` — generate MatingCandidate[] for a part pair
- `query.candidate_detail` — get full candidate details
- `action.solve_candidate` — run geometry solver on a candidate
- `action.apply_candidate` — apply chosen candidate transform
- `mate.record_demonstration` — save human-corrected assembly as demonstration

## Learning

Two levels:
1. **Exact recipe** (mate.save_recipe) — exact part-pair → skip LLM
2. **Pattern** (whyDescription + pattern field) — generalized rule injected into LLM
3. **Demonstration** (mate.record_demonstration) — rich feature-level data for future retrieval
