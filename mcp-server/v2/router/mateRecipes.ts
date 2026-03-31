/**
 * mateRecipes.ts — Persistent mate recipe + pattern learning store.
 *
 * Two levels of learning:
 *
 * 1. EXACT RECIPE (order-independent part-name key)
 *    When the exact same part pair is requested again, skip LLM entirely and
 *    return the saved face/method.
 *
 * 2. GENERALIZABLE PATTERN (injected as few-shot examples into every LLM prompt)
 *    The "pattern" field captures WHY the assembly is correct so the LLM can
 *    apply the same reasoning to similar-but-not-identical situations.
 *    e.g. "Two fans side-by-side → lateral face pair, NOT top/bottom"
 *
 * Storage: mcp-server/v2/router/mate-recipes.json
 * Key: sorted uppercase part names joined with '|'  (order-independent)
 */

import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { DemonstrationPriorScore } from '../../../shared/schema/assemblySemanticTypes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECIPES_FILE = path.resolve(__dirname, 'mate-recipes.json');
const DEMONSTRATIONS_FILE = path.resolve(__dirname, 'mate-demonstrations.json');

export type MateRecipe = {
  sourceName: string;
  targetName: string;
  sourceFace: string;
  targetFace: string;
  sourceMethod: string;
  targetMethod: string;

  // --- Learning / generalization fields ---

  /**
   * The user's own explanation of WHY this assembly is correct
   * (in their own words, any language).
   * e.g. "這兩個風扇是左右並排的，應該用側面接合"
   */
  whyDescription?: string;

  /**
   * A generalizable assembly rule extracted from this example.
   * Written in English for consistent LLM injection.
   * e.g. "When two identical/similar parts are positioned side-by-side (same Y,
   * different X), connect at their facing lateral faces (right→left), NOT top/bottom."
   */
  pattern?: string;

  /**
   * The wrong approach that should NOT be used, and why.
   * e.g. "Do NOT use bottom→top — that stacks them vertically instead of joining side-by-side."
   */
  antiPattern?: string;

  /**
   * Geometry signal that triggered this rule (helps LLM identify similar cases).
   * e.g. "same bbox size, large horizontal offset (dx >> dy), nearly zero dY"
   */
  geometrySignal?: string;

  savedAt: string;
};

type RecipeStore = Record<string, MateRecipe>;

let cache: RecipeStore | null = null;

function recipeKey(nameA: string, nameB: string): string {
  return [nameA.toUpperCase(), nameB.toUpperCase()].sort().join('|');
}

async function loadStore(): Promise<RecipeStore> {
  if (cache !== null) return cache;
  try {
    const raw = await readFile(RECIPES_FILE, 'utf-8');
    cache = JSON.parse(raw) as RecipeStore;
  } catch {
    cache = {};
  }
  return cache;
}

async function persistStore(store: RecipeStore): Promise<void> {
  cache = store;
  await writeFile(RECIPES_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

/** Find a saved exact recipe for a part pair. Returns null if none exists. */
export async function findRecipe(nameA: string, nameB: string): Promise<MateRecipe | null> {
  const store = await loadStore();
  return store[recipeKey(nameA, nameB)] ?? null;
}

/** Save (or overwrite) a recipe. */
export async function saveRecipe(recipe: Omit<MateRecipe, 'savedAt'>): Promise<MateRecipe> {
  const store = await loadStore();
  const full: MateRecipe = { ...recipe, savedAt: new Date().toISOString() };
  store[recipeKey(recipe.sourceName, recipe.targetName)] = full;
  await persistStore(store);
  return full;
}

/** Delete a recipe. Returns true if it existed. */
export async function deleteRecipe(nameA: string, nameB: string): Promise<boolean> {
  const store = await loadStore();
  const key = recipeKey(nameA, nameB);
  if (!(key in store)) return false;
  delete store[key];
  await persistStore(store);
  return true;
}

/** Return all saved recipes. */
export async function listRecipes(): Promise<MateRecipe[]> {
  const store = await loadStore();
  return Object.values(store);
}

/**
 * Build a few-shot learning context block to inject into LLM prompts.
 * This is the key to generalization: the LLM reads these examples and
 * applies the same reasoning patterns to new, unseen part pairs.
 *
 * Returns empty string if no patterns have been saved yet.
 */
export async function getLearningContext(): Promise<string> {
  const recipes = await listRecipes();
  const withPatterns = recipes.filter((r) => r.pattern || r.whyDescription);
  if (withPatterns.length === 0) return '';

  const lines: string[] = [
    '## Learned Assembly Patterns (from user corrections — HIGH PRIORITY)',
    'These are real examples where the AI got it wrong and the user corrected it.',
    'Apply these reasoning patterns to similar situations even for new parts.',
    '',
  ];

  withPatterns.forEach((r, i) => {
    lines.push(`### Example ${i + 1}: ${r.sourceName} ↔ ${r.targetName}`);
    lines.push(`- **Correct assembly**: ${r.sourceName} (${r.sourceFace}) → ${r.targetName} (${r.targetFace})`);
    if (r.whyDescription) lines.push(`- **Why (user's words)**: ${r.whyDescription}`);
    if (r.pattern) lines.push(`- **Generalizable rule**: ${r.pattern}`);
    if (r.antiPattern) lines.push(`- **Anti-pattern (avoid)**: ${r.antiPattern}`);
    if (r.geometrySignal) lines.push(`- **Geometry signal**: ${r.geometrySignal}`);
    lines.push('');
  });

  return lines.join('\n');
}

/** Clear in-memory cache (for hot-reload / testing). */
export function clearRecipeCache(): void {
  cache = null;
}

// =============================================================================
// DemonstrationRecord — Human demonstration storage for imitation learning
// =============================================================================

/**
 * A human demonstration record capturing which assembly configuration
 * the user chose, their explanation, and a scene snapshot for future learning.
 *
 * These demonstrations complement the exact-recipe system:
 * - Recipes = exact part-pair cache (skip LLM)
 * - Demonstrations = richer learning signal with scene context + explanations
 */
/** Serialization-safe feature pair (no THREE.js objects). */
export type SerializedFeaturePair = {
  sourceFeatureId: string;
  sourceFeatureType: string;
  targetFeatureId: string;
  targetFeatureType: string;
  compatibilityScore: number;
  dimensionFitScore: number;
  axisAlignmentScore: number;
  notes: string[];
};

export type DemonstrationRecord = {
  id: string;
  timestamp: string;
  sourcePartId: string;
  sourcePartName: string;
  targetPartId: string;
  targetPartName: string;
  /** ID of the MatingCandidate the user chose (optional — not always available) */
  chosenCandidateId?: string;
  /** Serialized feature pairs chosen by the human. Optional for backward compat. */
  chosenFeaturePairs?: SerializedFeaturePair[];
  /** Final transform applied. Optional for backward compat. */
  finalTransform?: {
    translation: [number, number, number];
    rotation: [number, number, number, number]; // quaternion xyzw
    approachDirection: [number, number, number];
    method: string;
    residualError: number;
  };
  /** User's explanation in their own words */
  textExplanation?: string;
  /** The wrong approach to avoid */
  antiPattern?: string;
  /** AI-generated generalizable rule */
  generalizedRule?: string;
  /** Scene snapshot at time of demonstration */
  sceneSnapshot?: Record<
    string,
    { position: [number, number, number]; quaternion: [number, number, number, number] }
  >;
};

type DemonstrationStore = DemonstrationRecord[];

let demoCache: DemonstrationStore | null = null;

async function loadDemoStore(): Promise<DemonstrationStore> {
  if (demoCache !== null) return demoCache;
  try {
    const raw = await readFile(DEMONSTRATIONS_FILE, 'utf-8');
    demoCache = JSON.parse(raw) as DemonstrationStore;
    if (!Array.isArray(demoCache)) demoCache = [];
  } catch {
    demoCache = [];
  }
  return demoCache;
}

async function persistDemoStore(store: DemonstrationStore): Promise<void> {
  demoCache = store;
  await writeFile(DEMONSTRATIONS_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Save a new DemonstrationRecord. Deduplicates by id (overwrite if same id).
 */
export async function saveDemonstration(
  record: DemonstrationRecord
): Promise<DemonstrationRecord> {
  const store = await loadDemoStore();
  const idx = store.findIndex((d) => d.id === record.id);
  if (idx >= 0) {
    store[idx] = record;
  } else {
    store.push(record);
  }
  await persistDemoStore(store);
  return record;
}

/**
 * Return all saved demonstrations, newest first.
 */
export async function listDemonstrations(): Promise<DemonstrationRecord[]> {
  const store = await loadDemoStore();
  return [...store].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Find demonstrations for a specific part pair (order-independent).
 */
export async function findDemonstrations(
  nameA: string,
  nameB: string
): Promise<DemonstrationRecord[]> {
  const store = await loadDemoStore();
  const upperA = nameA.toUpperCase();
  const upperB = nameB.toUpperCase();
  return store.filter((d) => {
    const srcUpper = d.sourcePartName.toUpperCase();
    const tgtUpper = d.targetPartName.toUpperCase();
    return (srcUpper === upperA && tgtUpper === upperB) ||
           (srcUpper === upperB && tgtUpper === upperA);
  });
}

/**
 * Relevance score for a demonstration record relative to a query part pair.
 */
export type DemonstrationRelevanceScore = {
  record: DemonstrationRecord;
  score: number;
  /** Component scores for debugging */
  nameMatchScore: number;
  featureTypeScore: number;
};

/**
 * Find demonstrations relevant to a part pair, returning scored results.
 *
 * Scoring:
 * - +0.6 exact part name match (both parts)
 * - +0.3 partial part name match (one part or substring)
 * - +0.2 keyword overlap (feature types, descriptions)
 *
 * Returns sorted descending by score; only items with score > 0.1.
 */
/** Clear demonstration cache (for hot-reload / testing). */
export function clearDemoCache(): void {
  demoCache = null;
}

// =============================================================================
// Demonstration Retrieval Prior — relevance-scored demo lookup for LLM context
// =============================================================================

/**
 * Find demonstrations relevant to a candidate assembly.
 * Uses part-name match, feature type overlap, and text keyword match.
 * Returns scored list, descending by relevance.
 */
export async function findRelevantDemonstrations(params: {
  sourcePartName: string;
  targetPartName: string;
  featureTypes?: string[];
  maxResults?: number;
}): Promise<DemonstrationPriorScore[]> {
  const { sourcePartName, targetPartName, featureTypes = [], maxResults = 5 } = params;
  const store = await loadDemoStore();
  if (store.length === 0) return [];

  const upperSrc = sourcePartName.toUpperCase();
  const upperTgt = targetPartName.toUpperCase();

  const scored: DemonstrationPriorScore[] = [];

  for (const demo of store) {
    const demoSrc = demo.sourcePartName.toUpperCase();
    const demoTgt = demo.targetPartName.toUpperCase();

    let score = 0;
    let nameMatchScore = 0;
    let featureTypeScore = 0;
    let textScore = 0;
    const matchedFeatureTypes: string[] = [];

    // Part name matching (order-independent)
    const exactMatch =
      (demoSrc === upperSrc && demoTgt === upperTgt) ||
      (demoSrc === upperTgt && demoTgt === upperSrc);
    if (exactMatch) {
      nameMatchScore = 0.6;
      score += nameMatchScore;
    } else {
      // Partial/substring match
      const partialSrcA = demoSrc.includes(upperSrc) || upperSrc.includes(demoSrc);
      const partialTgtB = demoTgt.includes(upperTgt) || upperTgt.includes(demoTgt);
      const partialSrcB = demoSrc.includes(upperTgt) || upperTgt.includes(demoSrc);
      const partialTgtA = demoTgt.includes(upperSrc) || upperSrc.includes(demoTgt);
      if ((partialSrcA && partialTgtB) || (partialSrcB && partialTgtA)) {
        nameMatchScore = 0.3;
        score += nameMatchScore;
      }
    }

    // Feature type overlap
    if (featureTypes.length > 0 && demo.chosenFeaturePairs && demo.chosenFeaturePairs.length > 0) {
      const demoTypeSet = new Set<string>();
      for (const fp of demo.chosenFeaturePairs) {
        demoTypeSet.add(fp.sourceFeatureType);
        demoTypeSet.add(fp.targetFeatureType);
      }
      let matches = 0;
      for (const ft of featureTypes) {
        if (demoTypeSet.has(ft)) {
          matches++;
          matchedFeatureTypes.push(ft);
        }
      }
      featureTypeScore = matches / featureTypes.length;
      score += featureTypeScore * 0.3;
    }

    // Keyword match in generalizedRule or textExplanation
    const ruleText = ((demo.generalizedRule ?? '') + ' ' + (demo.textExplanation ?? '')).toLowerCase();
    if (ruleText.length > 0 && featureTypes.length > 0) {
      let kwMatches = 0;
      for (const ft of featureTypes) {
        if (ruleText.includes(ft.toLowerCase())) kwMatches++;
      }
      textScore = featureTypes.length > 0 ? kwMatches / featureTypes.length : 0;
      score += textScore * 0.1;
    }

    if (score < 0.05) continue; // Skip irrelevant demos

    scored.push({
      demonstrationId: demo.id,
      sourcePartName: demo.sourcePartName,
      targetPartName: demo.targetPartName,
      totalScore: Math.min(1, score),
      nameMatchScore,
      featureTypeScore,
      textScore,
      matchedFeatureTypes,
      generalizedRuleSummary: demo.generalizedRule?.slice(0, 100),
    });
  }

  scored.sort((a, b) => b.totalScore - a.totalScore);
  return scored.slice(0, maxResults);
}

/**
 * Build compact text summarizing relevant demonstrations for LLM prompt injection.
 * Returns empty string when no relevant demonstrations are found.
 */
export async function getDemonstrationLearningContext(params: {
  sourcePartName: string;
  targetPartName: string;
  featureTypes?: string[];
  maxDemos?: number;
}): Promise<string> {
  const { sourcePartName, targetPartName, featureTypes, maxDemos = 3 } = params;
  const relevant = await findRelevantDemonstrations({
    sourcePartName,
    targetPartName,
    ...(featureTypes !== undefined ? { featureTypes } : {}),
    maxResults: maxDemos,
  });

  if (relevant.length === 0) return '';

  const store = await loadDemoStore();
  const demoById = new Map(store.map(d => [d.id, d]));

  const lines: string[] = [
    '## Relevant Assembly Demonstrations',
    `(retrieved for: ${sourcePartName} ↔ ${targetPartName})`,
    '',
  ];

  relevant.forEach((rel, i) => {
    const demo = demoById.get(rel.demonstrationId);
    if (!demo) return;

    const scoreLabel = rel.nameMatchScore > 0 ? 'part match' : 'feature match';
    lines.push(`Demo #${i + 1} (score=${rel.totalScore.toFixed(2)}, ${scoreLabel}): ${demo.sourcePartName} ↔ ${demo.targetPartName}`);

    if (demo.textExplanation) {
      lines.push(`  Reason: ${demo.textExplanation}`);
    }
    if (demo.generalizedRule) {
      lines.push(`  Rule: ${demo.generalizedRule}`);
    }
    if (demo.antiPattern) {
      lines.push(`  Anti-pattern: Do NOT ${demo.antiPattern}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}
