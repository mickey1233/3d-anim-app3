/**
 * featureTypes.ts — Assembly feature type definitions for feature-based mating.
 *
 * These types form the foundation of the v3 feature-based assembly inference pipeline.
 * They sit above the existing face-cluster / anchor system and describe SEMANTIC features
 * (holes, pegs, planar faces, slots, etc.) rather than raw mesh clusters.
 *
 * Backward compat: nothing in this file modifies or replaces any existing v2 face-based code.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitive / enum types
// ---------------------------------------------------------------------------

/** The geometric category of an assembly feature. */
export type FeatureType =
  | 'planar_face'       // large flat support/mating surface
  | 'cylindrical_hole'  // through hole or blind hole
  | 'blind_hole'        // non-through pocket
  | 'slot'              // rectangular or curved channel
  | 'peg'               // protruding cylinder or pin
  | 'tab'               // flat protruding tongue/latch
  | 'socket'            // recessed receptacle
  | 'rail'              // linear guide channel
  | 'edge_notch'        // cutout at part edge
  | 'edge_connector'    // PCB-style edge connector
  | 'support_pad';      // standoff or mounting pad

/** Semantic role of the feature within an assembly relationship. */
export type SemanticRole =
  | 'insert'    // this feature moves into a receiving feature
  | 'receive'   // this feature accepts an insert
  | 'fasten'    // screw hole, snap, clip
  | 'support'   // load-bearing surface
  | 'align'     // guide/alignment pin/rail
  | 'seal'      // sealing surface
  | 'unknown';

// ---------------------------------------------------------------------------
// Pose and geometry
// ---------------------------------------------------------------------------

/**
 * Feature origin and orientation.
 * All "local" values are in PART LOCAL space.
 * "world" values are populated at runtime after the part transform is known.
 */
export type FeaturePose = {
  /** Feature origin in PART LOCAL space */
  localPosition: [number, number, number];
  /** Primary axis (hole axis, face normal, peg axis) in part local space */
  localAxis: [number, number, number];
  /** Secondary axis for oriented features (slot long axis, edge direction) */
  localSecondaryAxis?: [number, number, number];
  /** Cached world-space position (populated at runtime after part transform) */
  worldPosition?: [number, number, number];
  /** Cached world-space primary axis (populated at runtime after part transform) */
  worldAxis?: [number, number, number];
};

/** Dimensional measurements for a feature. All units are meters. */
export type FeatureDimensions = {
  /** For holes/pegs: diameter in meters */
  diameter?: number;
  /** For holes: depth in meters. null means through-hole. */
  depth?: number | null;
  /** For planar faces: area in m² */
  area?: number;
  /** For slots/rails: long axis length in meters */
  length?: number;
  /** For slots/rails/tabs: width in meters */
  width?: number;
  /** For tabs: thickness in meters */
  thickness?: number;
  /** Tolerance window for matching (in meters). Required. */
  tolerance: number;
};

// ---------------------------------------------------------------------------
// Core feature type
// ---------------------------------------------------------------------------

/** A single detected assembly feature on one part. */
export type AssemblyFeature = {
  /** UUID for this feature */
  id: string;
  type: FeatureType;
  /** UUID of the owning part */
  partId: string;
  pose: FeaturePose;
  dimensions: FeatureDimensions;
  semanticRole: SemanticRole;
  /**
   * Face cluster normal this feature belongs to (links back to the existing
   * clusterPlanarFaces system for backward compatibility).
   */
  supportFaceNormal?: [number, number, number];
  /** 0–1 confidence score from the extractor */
  confidence: number;
  /** Human-readable label, e.g. "M3 hole" or "top planar face" */
  label?: string;
  /** Which extraction method found this feature */
  extractedBy: 'planar_cluster' | 'circle_fit' | 'peg_detect' | 'slot_detect' | 'manual' | 'vlm_hint';
};

/** A group of related features forming a pattern (e.g. 4×M3 hole pattern). */
export type FeatureGroup = {
  id: string;
  partId: string;
  features: AssemblyFeature[];
  /** Pattern type */
  patternType?: 'single' | 'linear_array' | 'circular_array' | 'irregular';
  patternCount?: number;
};

// ---------------------------------------------------------------------------
// Matching / candidate types
// ---------------------------------------------------------------------------

/** A proposed pairing between one feature on source and one on target part. */
export type FeaturePair = {
  sourceFeature: AssemblyFeature;
  targetFeature: AssemblyFeature;
  /** Overall compatibility score 0–1 */
  compatibilityScore: number;
  /** How well dimensions match 0–1 */
  dimensionFitScore: number;
  /** How well axes align (anti-parallel for faces, parallel for holes/pegs) 0–1 */
  axisAlignmentScore: number;
  /** Human-readable diagnostic notes */
  notes: string[];
};

/** The rigid transform solution that aligns source to target. */
export type AlignmentSolution = {
  /**
   * ALWAYS absolute world-space position for the source part after alignment.
   * NOT a delta. Apply this directly as the part's new world position.
   */
  translation: [number, number, number];
  /**
   * ALWAYS absolute world-space quaternion [x,y,z,w] for the source part after alignment.
   * NOT a delta rotation.
   */
  rotation: [number, number, number, number];
  /** Marks this as absolute world pose (not a delta transform) */
  solutionType: 'absolute_world';
  /** Approach direction (unit vector, world space) — direction source moves toward target */
  approachDirection: [number, number, number];
  /** Which feature pairs were used to compute this solution */
  usedPairs: FeaturePair[];
  /** Solver method that produced this solution */
  method: 'axis_align' | 'point_align' | 'plane_align' | 'pattern_align' | 'peg_slot' | 'socket_insert';
  /** Residual error after solving (meters) */
  residualError: number;
  /** Number of feature pairs used in pattern_align solve (≥2 when method='pattern_align') */
  patternPairCount?: number;
  /** Solver diagnostic messages */
  diagnostics: string[];
};

/** A full candidate assembly hypothesis ranking source ↔ target. */
export type MatingCandidate = {
  id: string;
  sourcePartId: string;
  targetPartId: string;
  /** One or more feature pairs that together define the assembly constraint */
  featurePairs: FeaturePair[];
  /** Computed rigid transform (populated by featureSolver) */
  transform?: AlignmentSolution;
  /** Aggregate score 0–1 */
  totalScore: number;
  scoreBreakdown: {
    featureCompatibility: number;
    dimensionFit: number;
    axisAlignment: number;
    faceSupportConsistency: number;
    collisionPenalty: number;
    insertionFeasibility: number;
    symmetryAmbiguityPenalty: number;
    recipePrior: number;
    vlmRerank?: number;
  };
  /** Human-readable summary for display */
  description: string;
  /** Solver / matcher diagnostic messages */
  diagnostics: string[];
};

// ---------------------------------------------------------------------------
// Learning / recipe types
// ---------------------------------------------------------------------------

/**
 * Persistent learned recipe for a part pair.
 * This extends the existing MateRecipe from mateRecipes.ts with feature-level detail.
 */
export type AssemblyRecipe = {
  id: string;
  sourcePartName: string;
  targetPartName: string;
  /** Human-readable description of the feature pair involved */
  featurePairDescription: string;
  /** Backward compat: face id used in the v2 face-based system */
  sourceFace?: string;
  targetFace?: string;
  sourceMethod?: string;
  targetMethod?: string;
  /** User's own explanation of WHY this assembly is correct */
  whyDescription?: string;
  /** Generalizable English rule for LLM injection */
  pattern?: string;
  /** Wrong approach to avoid */
  antiPattern?: string;
  /** Geometry characteristics that identify this situation */
  geometrySignal?: string;
  savedAt: string;
};

/**
 * Serialization-safe version of FeaturePair (no THREE.js objects, just plain numbers).
 * Used in DemonstrationRecord to avoid serializing full AssemblyFeature objects.
 */
export type SerializedFeaturePair = {
  sourceFeatureId: string;
  sourceFeatureType: FeatureType;
  targetFeatureId: string;
  targetFeatureType: FeatureType;
  compatibilityScore: number;
  dimensionFitScore: number;
  axisAlignmentScore: number;
  notes: string[];
};

/** A human demonstration record for future imitation learning. */
export type DemonstrationRecord = {
  id: string;
  timestamp: string;
  sourcePartId: string;
  sourcePartName: string;
  targetPartId: string;
  targetPartName: string;
  /** ID of the MatingCandidate the user chose */
  chosenCandidateId?: string;
  /**
   * Serialized feature pairs — stored as plain objects, not THREE.js instances.
   * Optional for backward compat with old records.
   */
  chosenFeaturePairs?: SerializedFeaturePair[];
  /**
   * Final transform applied. Optional for backward compat with old records.
   */
  finalTransform?: {
    translation: [number, number, number];
    rotation: [number, number, number, number]; // quaternion xyzw
    approachDirection: [number, number, number];
    method: string;
    residualError: number;
  };
  /** Human explanation of why this assembly is correct */
  textExplanation?: string;
  /** The wrong approach to avoid */
  antiPattern?: string;
  /** Geometry signal for similar-case recognition */
  geometrySignal?: string;
  /** AI-generated generalizable rule */
  generalizedRule?: string;
  /**
   * Scene snapshot: part transforms at time of demonstration.
   * Key = partId, value = { position, quaternion }.
   */
  sceneSnapshot?: Record<
    string,
    { position: [number, number, number]; quaternion: [number, number, number, number] }
  >;
};

// ---------------------------------------------------------------------------
// Zod schemas for types that cross the network boundary
// ---------------------------------------------------------------------------

export const FeatureTypeSchema = z.enum([
  'planar_face',
  'cylindrical_hole',
  'blind_hole',
  'slot',
  'peg',
  'tab',
  'socket',
  'rail',
  'edge_notch',
  'edge_connector',
  'support_pad',
]);

export const SemanticRoleSchema = z.enum([
  'insert',
  'receive',
  'fasten',
  'support',
  'align',
  'seal',
  'unknown',
]);

export const Vec3TupleSchema = z.tuple([z.number(), z.number(), z.number()]);
export const Vec4TupleSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const FeaturePoseSchema = z.object({
  localPosition: Vec3TupleSchema,
  localAxis: Vec3TupleSchema,
  localSecondaryAxis: Vec3TupleSchema.optional(),
  worldPosition: Vec3TupleSchema.optional(),
  worldAxis: Vec3TupleSchema.optional(),
});

export const FeatureDimensionsSchema = z.object({
  diameter: z.number().positive().optional(),
  depth: z.number().nullable().optional(),
  area: z.number().nonnegative().optional(),
  length: z.number().positive().optional(),
  width: z.number().positive().optional(),
  thickness: z.number().positive().optional(),
  tolerance: z.number().nonnegative(),
});

export const AssemblyFeatureSchema = z.object({
  id: z.string().uuid(),
  type: FeatureTypeSchema,
  partId: z.string(),
  pose: FeaturePoseSchema,
  dimensions: FeatureDimensionsSchema,
  semanticRole: SemanticRoleSchema,
  supportFaceNormal: Vec3TupleSchema.optional(),
  confidence: z.number().min(0).max(1),
  label: z.string().optional(),
  extractedBy: z.enum(['planar_cluster', 'circle_fit', 'peg_detect', 'slot_detect', 'manual', 'vlm_hint']),
});

export const FeaturePairSchema = z.object({
  sourceFeature: AssemblyFeatureSchema,
  targetFeature: AssemblyFeatureSchema,
  compatibilityScore: z.number().min(0).max(1),
  dimensionFitScore: z.number().min(0).max(1),
  axisAlignmentScore: z.number().min(0).max(1),
  notes: z.array(z.string()),
});

export const AlignmentSolutionSchema = z.object({
  translation: Vec3TupleSchema,
  rotation: Vec4TupleSchema,
  solutionType: z.literal('absolute_world'),
  approachDirection: Vec3TupleSchema,
  usedPairs: z.array(FeaturePairSchema),
  method: z.enum(['axis_align', 'point_align', 'plane_align', 'pattern_align', 'peg_slot', 'socket_insert']),
  residualError: z.number().nonnegative(),
  patternPairCount: z.number().int().positive().optional(),
  diagnostics: z.array(z.string()),
});

export const MatingCandidateSchema = z.object({
  id: z.string().uuid(),
  sourcePartId: z.string(),
  targetPartId: z.string(),
  featurePairs: z.array(FeaturePairSchema),
  transform: AlignmentSolutionSchema.optional(),
  totalScore: z.number().min(0).max(1),
  scoreBreakdown: z.object({
    featureCompatibility: z.number(),
    dimensionFit: z.number(),
    axisAlignment: z.number(),
    faceSupportConsistency: z.number(),
    collisionPenalty: z.number(),
    insertionFeasibility: z.number(),
    symmetryAmbiguityPenalty: z.number(),
    recipePrior: z.number(),
    vlmRerank: z.number().optional(),
  }),
  description: z.string(),
  diagnostics: z.array(z.string()),
});

export const AssemblyRecipeSchema = z.object({
  id: z.string(),
  sourcePartName: z.string(),
  targetPartName: z.string(),
  featurePairDescription: z.string(),
  sourceFace: z.string().optional(),
  targetFace: z.string().optional(),
  sourceMethod: z.string().optional(),
  targetMethod: z.string().optional(),
  whyDescription: z.string().optional(),
  pattern: z.string().optional(),
  antiPattern: z.string().optional(),
  geometrySignal: z.string().optional(),
  savedAt: z.string(),
});

export const SerializedFeaturePairSchema = z.object({
  sourceFeatureId: z.string(),
  sourceFeatureType: FeatureTypeSchema,
  targetFeatureId: z.string(),
  targetFeatureType: FeatureTypeSchema,
  compatibilityScore: z.number().min(0).max(1),
  dimensionFitScore: z.number().min(0).max(1),
  axisAlignmentScore: z.number().min(0).max(1),
  notes: z.array(z.string()),
});

export const DemonstrationRecordSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.string(),
  sourcePartId: z.string(),
  sourcePartName: z.string(),
  targetPartId: z.string(),
  targetPartName: z.string(),
  chosenCandidateId: z.string().optional(),
  chosenFeaturePairs: z.array(SerializedFeaturePairSchema).optional(),
  finalTransform: z.object({
    translation: Vec3TupleSchema,
    rotation: Vec4TupleSchema,
    approachDirection: Vec3TupleSchema,
    method: z.string(),
    residualError: z.number().nonnegative(),
  }).optional(),
  textExplanation: z.string().optional(),
  antiPattern: z.string().optional(),
  geometrySignal: z.string().optional(),
  generalizedRule: z.string().optional(),
  sceneSnapshot: z.record(
    z.string(),
    z.object({
      position: Vec3TupleSchema,
      quaternion: Vec4TupleSchema,
    })
  ).optional(),
});
