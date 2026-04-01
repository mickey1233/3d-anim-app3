/**
 * assemblyEntity.ts — Canonical abstraction for an assembly entity.
 *
 * An AssemblyEntity represents any addressable unit in the assembly graph:
 *   - a single part
 *   - a group of parts (rigid body)
 *   - a future subassembly / module (scaffolded, not yet fully used)
 *
 * Design goals:
 *   - Replaces ad-hoc `partId + optional sourceGroupId` patterns
 *   - Enables solver, grounding, and planning code to reason about groups
 *     and subassemblies without knowing the underlying part IDs
 *   - Backward-compatible: a single-part entity is just a degenerate group
 *
 * NOT responsible for:
 *   - Storing transforms (→ store.ts overridesById / manualTransformById)
 *   - Solving mates (→ solver.ts)
 *   - Grounding text → entity (→ objectGrounder.ts, future entityGrounder.ts)
 */

// ---------------------------------------------------------------------------
// Core type
// ---------------------------------------------------------------------------

export type AssemblyEntityType = 'part' | 'group' | 'subassembly';

export type AssemblyEntity = {
  /** Stable unique ID.
   *  - For 'part': equals the part's store ID (Three.js object UUID).
   *  - For 'group': equals the AssemblyGroup.id from the store.
   *  - For 'subassembly': a caller-assigned stable ID.
   */
  entityId: string;

  entityType: AssemblyEntityType;

  /** All part IDs that are members of this entity (order: representative first). */
  memberPartIds: string[];

  /** The part used as the motion anchor / transform reference for the entity.
   *  Defaults to memberPartIds[0] when not set.
   */
  representativePartId?: string;

  /** Human-readable label for UI and chat replies. */
  displayName: string;

  /** VLM-derived or heuristic category, e.g. 'fan', 'thermal', 'chassis'. */
  semanticCategory?: string;

  /** Short description, e.g. "horizontal cooling fan left". */
  semanticDescription?: string;

  /** The store AssemblyGroup.id when entityType === 'group'. Null otherwise. */
  sourceGroupId?: string;

  // ── Optional geometry (populated if available) ────────────────────────────

  /** Axis-aligned bounding box size [w, h, d] in scene units.
   *  For groups: the union bbox of all members.
   */
  bboxSize?: [number, number, number];

  /** Derived semantic tags for quick filtering.
   *  Examples: 'fan', 'structural', 'thermal', 'cover', 'pcb'
   */
  semanticTags?: string[];
};

// ---------------------------------------------------------------------------
// Lightweight result types for future grounding / planning phases
// ---------------------------------------------------------------------------

/** Result of resolving a text reference to an entity (future entityGrounder). */
export type EntityGroundingCandidate = {
  entity: AssemblyEntity;
  score: number;
  reason: string;
};

/** Pair of source + target entities for an assembly operation. */
export type AssemblyEntityPair = {
  source: AssemblyEntity;
  target: AssemblyEntity;
  assemblyIntent?: string;
};
