/**
 * commandFirstRouter.ts — Command-first execution policy.
 *
 * Before calling the LLM, detect clear assembly action verbs + resolvable
 * source/target entities. If found, execute directly without LLM inference.
 *
 * Handles:
 *   - Exact recipe match (skip LLM + face/method inference entirely)
 *   - Group/module as first-class source
 *   - Diagnostics for all fast-path decisions
 */

import type { ToolCall } from '../../../shared/schema/index.js';
import type { RouterContext } from './types.js';
import { findRecipe, findGroupRecipe } from './mateRecipes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommandFirstDiagnostics = {
  usedCommandFirstExecution: boolean;
  usedRecipeMatch: boolean;
  recipeId: string | null;
  recipeConfidence: number;
  usedGroupModulePath: boolean;
  sourceResolvedAs: 'part' | 'group' | null;
  targetResolvedAs: 'part' | 'group' | null;
  sourceName: string | null;
  targetName: string | null;
  sourceId: string | null;
  targetId: string | null;
  faceMethodFromRecipe: boolean;
  detectedVerb: string | null;
};

export type CommandFirstResult = {
  matched: boolean;
  toolCalls: ToolCall[];
  replyText: string;
  diagnostics: CommandFirstDiagnostics;
};

// ---------------------------------------------------------------------------
// Action verb patterns (Chinese + English)
// ---------------------------------------------------------------------------

/**
 * Returns the position of the first matched verb, or -1.
 * Also returns the matched verb string.
 */
const ACTION_VERBS = [
  // Chinese — order matters: longer strings first to avoid partial matches
  '組裝到', '固定到', '安裝到', '裝配到', '鎖定到', '插入到',
  '組到', '裝到', '移到', '放到', '插到', '鎖到', '裝上',
  // English
  'mount onto', 'attach to', 'install on', 'install onto', 'fix to',
  'mount', 'attach', 'install',
];

function detectActionVerb(text: string): { verb: string; pos: number } | null {
  const lower = text.toLowerCase();
  for (const verb of ACTION_VERBS) {
    const idx = lower.indexOf(verb);
    if (idx !== -1) return { verb, pos: idx };
  }
  return null;
}

// ---------------------------------------------------------------------------
// User correction detection
// ---------------------------------------------------------------------------

const CORRECTION_CONFIRM_PHRASES = [
  '這樣是對的', '這樣對了', '對了', '就這樣', '儲存', 'save this', 'correct', 'save',
  '記錄這個', '記住這個', '學起來',
];

export function detectCorrectionConfirm(text: string): boolean {
  const lower = text.toLowerCase();
  return CORRECTION_CONFIRM_PHRASES.some((p) => lower.includes(p));
}

// ---------------------------------------------------------------------------
// Entity resolution — find parts and groups mentioned in text
// ---------------------------------------------------------------------------

type ResolvedEntity = {
  kind: 'part' | 'group';
  id: string;
  name: string;
  textPos: number;  // position of match in text (for before/after verb ordering)
};

function resolveEntitiesFromText(
  text: string,
  ctx: RouterContext
): ResolvedEntity[] {
  const lower = text.toLowerCase();
  const found: ResolvedEntity[] = [];

  // Match parts
  for (const part of ctx.parts) {
    const nameLower = part.name.toLowerCase();
    const idx = lower.indexOf(nameLower);
    if (idx !== -1) {
      found.push({ kind: 'part', id: part.id, name: part.name, textPos: idx });
    }
  }

  // Match groups
  for (const group of (ctx.groups ?? [])) {
    const nameLower = group.name.toLowerCase();
    const idx = lower.indexOf(nameLower);
    if (idx !== -1) {
      // Avoid duplicating individual parts already matched inside this group
      found.push({ kind: 'group', id: group.id, name: group.name, textPos: idx });
    }
  }

  // Deduplicate: if a group name contains a part name that's already matched
  // at the same position, prefer the group.
  const deduped: ResolvedEntity[] = [];
  for (const e of found) {
    const shadowed = found.some(
      (other) =>
        other !== e &&
        other.kind === 'group' &&
        Math.abs(other.textPos - e.textPos) <= 2 &&
        e.kind === 'part'
    );
    if (!shadowed) deduped.push(e);
  }

  // Sort by position in text
  deduped.sort((a, b) => a.textPos - b.textPos);
  return deduped;
}

// ---------------------------------------------------------------------------
// Source / Target assignment
// ---------------------------------------------------------------------------

/**
 * Given verb position + resolved entities, decide which is source and which is target.
 *
 * Rules:
 *   - "把 SOURCE 裝到 TARGET" → entity before verb = source, after = target
 *   - "SOURCE 裝到 TARGET" → same
 *   - "裝到 TARGET" with recentReferent.lastSource → use referent as source
 *   - If only one entity is found, it could be target (with referent as source)
 *     or source (if no target context).
 */
function assignSourceTarget(
  verbPos: number,
  entities: ResolvedEntity[],
  ctx: RouterContext
): { source: ResolvedEntity | null; target: ResolvedEntity | null } {
  if (entities.length === 0) return { source: null, target: null };

  const before = entities.filter((e) => e.textPos < verbPos);
  const after = entities.filter((e) => e.textPos >= verbPos);

  let source: ResolvedEntity | null = before[before.length - 1] ?? null;
  let target: ResolvedEntity | null = after[0] ?? null;

  // If only one entity after verb and none before, check recent referents
  if (!source && ctx.recentReferents?.lastSource) {
    const ref = ctx.recentReferents.lastSource;
    if (ref.entityType === 'group') {
      const grp = (ctx.groups ?? []).find((g) => g.id === ref.entityId);
      if (grp) source = { kind: 'group', id: grp.id, name: grp.name, textPos: -1 };
    } else {
      const part = ctx.parts.find((p) => p.id === ref.entityId);
      if (part) source = { kind: 'part', id: part.id, name: part.name, textPos: -1 };
    }
  }

  // If target still null but there's only one entity total, it's ambiguous.
  // Prefer it as target if a recent source referent exists, else skip.
  if (!target && entities.length === 1 && source) {
    // entity IS the source, no target found
    target = null;
  }

  return { source, target };
}

// ---------------------------------------------------------------------------
// Build tool call from resolved entities + optional recipe
// ---------------------------------------------------------------------------

function buildMateToolCall(
  source: ResolvedEntity,
  target: ResolvedEntity,
  recipe: Awaited<ReturnType<typeof findRecipe>> | null,
  ctx: RouterContext
): ToolCall {
  const sourceGroupId =
    source.kind === 'group'
      ? source.id
      : null;

  // Representative part ID: for groups, pick the first member part
  const sourcePartId = (() => {
    if (source.kind === 'part') return source.id;
    const grp = (ctx.groups ?? []).find((g) => g.id === source.id);
    return grp?.partIds?.[0] ?? source.id;
  })();

  const targetPartId = (() => {
    if (target.kind === 'part') return target.id;
    const grp = (ctx.groups ?? []).find((g) => g.id === target.id);
    return grp?.partIds?.[0] ?? target.id;
  })();

  const args: Record<string, unknown> = {
    sourcePart: { partId: sourcePartId },
    targetPart: { partId: targetPartId },
    noCaptureFastPath: true,
    commit: true,
    pushHistory: true,
  };

  if (sourceGroupId) {
    args.sourceGroupId = sourceGroupId;
  }

  if (recipe) {
    args.sourceFace = recipe.sourceFace;
    args.targetFace = recipe.targetFace;
    args.sourceMethod = recipe.sourceMethod;
    args.targetMethod = recipe.targetMethod;
  }

  return {
    tool: 'action.smart_mate_execute',
    args,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

const EMPTY_DIAG: CommandFirstDiagnostics = {
  usedCommandFirstExecution: false,
  usedRecipeMatch: false,
  recipeId: null,
  recipeConfidence: 0,
  usedGroupModulePath: false,
  sourceResolvedAs: null,
  targetResolvedAs: null,
  sourceName: null,
  targetName: null,
  sourceId: null,
  targetId: null,
  faceMethodFromRecipe: false,
  detectedVerb: null,
};

export async function tryCommandFirstRoute(
  text: string,
  ctx: RouterContext
): Promise<CommandFirstResult> {
  const noMatch: CommandFirstResult = {
    matched: false,
    toolCalls: [],
    replyText: '',
    diagnostics: EMPTY_DIAG,
  };

  // 1. Detect action verb
  const verbMatch = detectActionVerb(text);
  if (!verbMatch) return noMatch;

  // 2. Resolve entities
  const entities = resolveEntitiesFromText(text, ctx);
  if (entities.length === 0) return noMatch;

  // 3. Assign source / target based on verb position
  const { source, target } = assignSourceTarget(verbMatch.pos, entities, ctx);
  if (!source || !target) return noMatch;

  // 4. Check recipe cache
  const sourceNameForRecipe = source.name;
  const targetNameForRecipe = target.name;

  // For groups: also try recipe keyed by group name
  let recipe = await findRecipe(sourceNameForRecipe, targetNameForRecipe);
  let recipeFromGroup = false;

  if (!recipe && source.kind === 'group') {
    recipe = await findGroupRecipe(source.name, targetNameForRecipe);
    if (recipe) recipeFromGroup = true;
  }
  if (!recipe && target.kind === 'group') {
    recipe = await findGroupRecipe(sourceNameForRecipe, target.name);
  }

  const recipeConfidence = recipe ? (recipe.confidence ?? 0.95) : 0;
  const usedRecipeMatch = recipe !== null;

  // 5. Build tool call
  const toolCall = buildMateToolCall(source, target, recipe, ctx);
  const isGroupPath = source.kind === 'group' || target.kind === 'group';

  // 6. Build reply text
  const srcDisplay = source.kind === 'group' ? `模組 ${source.name}` : source.name;
  const tgtDisplay = target.kind === 'group' ? `模組 ${target.name}` : target.name;
  const recipeNote = usedRecipeMatch
    ? `（使用已學習的組裝方法：${recipe!.sourceFace}→${recipe!.targetFace}）`
    : '（使用幾何推斷）';
  const replyText = `正在把 ${srcDisplay} 裝到 ${tgtDisplay} ${recipeNote}`;

  const diagnostics: CommandFirstDiagnostics = {
    usedCommandFirstExecution: true,
    usedRecipeMatch,
    recipeId: usedRecipeMatch ? `${sourceNameForRecipe}|${targetNameForRecipe}` : null,
    recipeConfidence,
    usedGroupModulePath: isGroupPath,
    sourceResolvedAs: source.kind,
    targetResolvedAs: target.kind,
    sourceName: source.name,
    targetName: target.name,
    sourceId: source.id,
    targetId: target.id,
    faceMethodFromRecipe: usedRecipeMatch,
    detectedVerb: verbMatch.verb,
  };

  console.log(
    `[commandFirst] verb="${verbMatch.verb}" src=${source.kind}:${source.name} tgt=${target.kind}:${target.name} recipe=${usedRecipeMatch} group=${isGroupPath}`
  );

  return {
    matched: true,
    toolCalls: [toolCall],
    replyText,
    diagnostics,
  };
}
