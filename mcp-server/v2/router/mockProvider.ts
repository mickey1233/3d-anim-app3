import type { ToolCall } from '../../../shared/schema/index.js';
import type { RouterContext, RouterProvider } from './types.js';
import { answerGeneralQuestionWithLlm, inferMateWithLlm } from './llmAssist.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type MentionedPart = RouterContext['parts'][number] & {
  index: number;
  end: number;
  volume: number;
  groupId?: string;
};

const containsAny = (text: string, keywords: string[]) => keywords.some((keyword) => text.includes(keyword));

const volumeFromSize = (size?: [number, number, number]) => {
  if (!size) return 1;
  return Math.max(1e-6, Math.abs(size[0] * size[1] * size[2]));
};

const normalizeText = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeToken = (text: string) => normalizeText(text).replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');

type MateFaceId = 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back';
type MateMethodId =
  | 'auto'
  | 'planar_cluster'
  | 'geometry_aabb'
  | 'object_aabb'
  | 'extreme_vertices'
  | 'obb_pca'
  | 'picked';
type MateModeId = 'translate' | 'twist' | 'both';
type InteractionModeId = 'select' | 'move' | 'rotate' | 'mate';

type RouterKeywordPolicy = {
  grid?: { keywords?: unknown; on?: unknown; off?: unknown };
  reset?: { keywords?: unknown };
  all?: { keywords?: unknown };
  select?: { keywords?: unknown };
  mode?: { keywords?: unknown };
  greeting?: { keywords?: unknown };
  thanks?: { keywords?: unknown };
  question?: { keywords?: unknown };
  step?: { command?: unknown; help?: unknown };
  chat?: { help?: unknown };
  model?: { info?: unknown };
  mate?: { keywords?: unknown };
  autoAssemble?: { keywords?: unknown };
};

type RouterKeywordSets = {
  grid: { keywords: string[]; on: string[]; off: string[] };
  reset: string[];
  all: string[];
  select: string[];
  mode: string[];
  greeting: string[];
  thanks: string[];
  question: string[];
  stepCommand: string[];
  stepHelp: string[];
  chatHelp: string[];
  modelInfo: string[];
  mate: string[];
  autoAssemble: string[];
};

const normalizeKeywordList = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => normalizeText(item))
    .filter(Boolean);
};

const EMPTY_KEYWORD_SETS: RouterKeywordSets = {
  grid: { keywords: [], on: [], off: [] },
  reset: [],
  all: [],
  select: [],
  mode: [],
  greeting: [],
  thanks: [],
  question: [],
  stepCommand: [],
  stepHelp: [],
  chatHelp: [],
  modelInfo: [],
  mate: [],
  autoAssemble: [],
};

const buildKeywordSets = (policy: RouterKeywordPolicy | null): RouterKeywordSets => {
  const grid = policy?.grid ?? {};
  const reset = policy?.reset ?? {};
  const all = policy?.all ?? {};
  const select = policy?.select ?? {};
  const mode = policy?.mode ?? {};
  const greeting = policy?.greeting ?? {};
  const thanks = policy?.thanks ?? {};
  const question = policy?.question ?? {};
  const step = policy?.step ?? {};
  const chat = policy?.chat ?? {};
  const model = policy?.model ?? {};
  const mate = policy?.mate ?? {};
  const autoAssemble = policy?.autoAssemble ?? {};

  return {
    grid: {
      keywords: normalizeKeywordList(grid.keywords),
      on: normalizeKeywordList(grid.on),
      off: normalizeKeywordList(grid.off),
    },
    reset: normalizeKeywordList(reset.keywords),
    all: normalizeKeywordList(all.keywords),
    select: normalizeKeywordList(select.keywords),
    mode: normalizeKeywordList(mode.keywords),
    greeting: normalizeKeywordList(greeting.keywords),
    thanks: normalizeKeywordList(thanks.keywords),
    question: normalizeKeywordList(question.keywords),
    stepCommand: normalizeKeywordList(step.command),
    stepHelp: normalizeKeywordList(step.help),
    chatHelp: normalizeKeywordList(chat.help),
    modelInfo: normalizeKeywordList(model.info),
    mate: normalizeKeywordList(mate.keywords),
    autoAssemble: normalizeKeywordList((autoAssemble as any).keywords),
  };
};

const DEFAULT_KEYWORDS_POLICY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'policy',
  'keywords.json'
);

let cachedKeywordSets: { path: string; mtimeMs: number; sets: RouterKeywordSets } | null = null;

const getKeywordSets = (): RouterKeywordSets => {
  const policyPath = process.env.V2_ROUTER_KEYWORDS_PATH || DEFAULT_KEYWORDS_POLICY_PATH;
  try {
    const stat = fs.statSync(policyPath);
    const mtimeMs = stat.mtimeMs;
    if (cachedKeywordSets && cachedKeywordSets.path === policyPath && cachedKeywordSets.mtimeMs === mtimeMs) {
      return cachedKeywordSets.sets;
    }

    const raw = fs.readFileSync(policyPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const policy = parsed && typeof parsed === 'object' ? (parsed as RouterKeywordPolicy) : null;
    const sets = buildKeywordSets(policy);
    cachedKeywordSets = { path: policyPath, mtimeMs, sets };
    return sets;
  } catch {
    cachedKeywordSets = { path: policyPath, mtimeMs: 0, sets: EMPTY_KEYWORD_SETS };
    return EMPTY_KEYWORD_SETS;
  }
};

type MockProviderPolicy = {
  faces?: unknown;
  methods?: unknown;
  mateModeTokens?: unknown;
  sourceTarget?: unknown;
  environments?: unknown;
  interactionModes?: unknown;
  generalQuestionTokens?: unknown;
  stepCommandRegex?: unknown;
};

type MockProviderNluSets = {
  faces: Array<{ face: MateFaceId; aliases: string[] }>;
  methods: Array<{ method: MateMethodId; aliases: string[] }>;
  mateModeTokens: { both: string[]; twist: string[]; translate: string[] };
  sourceTarget: {
    sourceKeywords: string[];
    targetKeywords: string[];
    directionTokens: string[];
    placementKeywords: string[];
    targetNameKeywords: string[];
    llmOverrideKeywords: string[];
  };
  environments: Array<{ alias: string; environment: string }>;
  interactionModes: Record<InteractionModeId, string[]>;
  generalQuestionTokens: string[];
  stepCommandRegex: RegExp | null;
};

const EMPTY_MOCK_NLU_SETS: MockProviderNluSets = {
  faces: [],
  methods: [],
  mateModeTokens: { both: [], twist: [], translate: [] },
  sourceTarget: {
    sourceKeywords: [],
    targetKeywords: [],
    directionTokens: [],
    placementKeywords: [],
    targetNameKeywords: [],
    llmOverrideKeywords: [],
  },
  environments: [],
  interactionModes: { select: [], move: [], rotate: [], mate: [] },
  generalQuestionTokens: [],
  stepCommandRegex: null,
};

const DEFAULT_MOCK_POLICY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'policy',
  'mockProvider.json'
);

let cachedMockNlu: { path: string; mtimeMs: number; sets: MockProviderNluSets } | null = null;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const normalizeStringList = normalizeKeywordList;

const normalizeFaceAliasMap = (value: unknown): Array<{ face: MateFaceId; aliases: string[] }> => {
  const allowedFaces: MateFaceId[] = ['top', 'bottom', 'left', 'right', 'front', 'back'];
  const record = asRecord(value);
  if (record) {
    return allowedFaces
      .map((face) => ({ face, aliases: normalizeStringList(record[face]) }))
      .filter((item) => item.aliases.length > 0);
  }

  if (!Array.isArray(value)) return [];
  const out: Array<{ face: MateFaceId; aliases: string[] }> = [];
  for (const item of value) {
    const obj = asRecord(item);
    const face = obj && typeof obj.face === 'string' ? (normalizeText(obj.face) as MateFaceId) : null;
    if (!face || !allowedFaces.includes(face)) continue;
    const aliases = normalizeStringList(obj.aliases);
    if (!aliases.length) continue;
    out.push({ face, aliases });
  }
  return out;
};

const normalizeMethodAliasMap = (value: unknown): Array<{ method: MateMethodId; aliases: string[] }> => {
  const allowedMethods: MateMethodId[] = [
    'auto',
    'extreme_vertices',
    'planar_cluster',
    'geometry_aabb',
    'object_aabb',
    'obb_pca',
    'picked',
  ];
  const record = asRecord(value);
  if (record) {
    return allowedMethods
      .map((method) => ({ method, aliases: normalizeStringList(record[method]) }))
      .filter((item) => item.aliases.length > 0);
  }

  if (!Array.isArray(value)) return [];
  const out: Array<{ method: MateMethodId; aliases: string[] }> = [];
  for (const item of value) {
    const obj = asRecord(item);
    const method = obj && typeof obj.method === 'string' ? (normalizeText(obj.method) as MateMethodId) : null;
    if (!method || !allowedMethods.includes(method)) continue;
    const aliases = normalizeStringList(obj.aliases);
    if (!aliases.length) continue;
    out.push({ method, aliases });
  }
  return out;
};

const normalizeMateModeTokens = (value: unknown) => {
  const record = asRecord(value);
  if (!record) return { both: [], twist: [], translate: [] };
  return {
    both: normalizeStringList(record.both),
    twist: normalizeStringList(record.twist),
    translate: normalizeStringList(record.translate),
  };
};

const normalizeSourceTargetPolicy = (value: unknown) => {
  const record = asRecord(value);
  if (!record) {
    return {
      sourceKeywords: [],
      targetKeywords: [],
      directionTokens: [],
      placementKeywords: [],
      targetNameKeywords: [],
      llmOverrideKeywords: [],
    };
  }
  return {
    sourceKeywords: normalizeStringList(record.sourceKeywords),
    targetKeywords: normalizeStringList(record.targetKeywords),
    directionTokens: normalizeStringList(record.directionTokens),
    placementKeywords: normalizeStringList(record.placementKeywords),
    targetNameKeywords: normalizeStringList(record.targetNameKeywords),
    llmOverrideKeywords: normalizeStringList(record.llmOverrideKeywords),
  };
};

const normalizeEnvironmentAliases = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  const out: Array<{ alias: string; environment: string }> = [];
  for (const item of value) {
    const obj = asRecord(item);
    const alias = obj && typeof obj.alias === 'string' ? normalizeText(obj.alias) : '';
    const environment = obj && typeof obj.environment === 'string' ? normalizeText(obj.environment) : '';
    if (!alias || !environment) continue;
    out.push({ alias, environment });
  }
  return out;
};

const normalizeInteractionModeTokens = (value: unknown): Record<InteractionModeId, string[]> => {
  const record = asRecord(value);
  if (!record) return { select: [], move: [], rotate: [], mate: [] };
  return {
    select: normalizeStringList(record.select),
    move: normalizeStringList(record.move),
    rotate: normalizeStringList(record.rotate),
    mate: normalizeStringList(record.mate),
  };
};

const compileStepCommandRegex = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const pattern = value.trim();
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
};

const buildMockNluSets = (policy: MockProviderPolicy | null): MockProviderNluSets => {
  return {
    faces: normalizeFaceAliasMap(policy?.faces),
    methods: normalizeMethodAliasMap(policy?.methods),
    mateModeTokens: normalizeMateModeTokens(policy?.mateModeTokens),
    sourceTarget: normalizeSourceTargetPolicy(policy?.sourceTarget),
    environments: normalizeEnvironmentAliases(policy?.environments),
    interactionModes: normalizeInteractionModeTokens(policy?.interactionModes),
    generalQuestionTokens: normalizeStringList(policy?.generalQuestionTokens),
    stepCommandRegex: compileStepCommandRegex(policy?.stepCommandRegex),
  };
};

const getMockNluSets = (): MockProviderNluSets => {
  const policyPath = process.env.V2_ROUTER_MOCK_POLICY_PATH || DEFAULT_MOCK_POLICY_PATH;
  try {
    const stat = fs.statSync(policyPath);
    const mtimeMs = stat.mtimeMs;
    if (cachedMockNlu && cachedMockNlu.path === policyPath && cachedMockNlu.mtimeMs === mtimeMs) {
      return cachedMockNlu.sets;
    }

    const raw = fs.readFileSync(policyPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const policy = parsed && typeof parsed === 'object' ? (parsed as MockProviderPolicy) : null;
    const sets = buildMockNluSets(policy);
    cachedMockNlu = { path: policyPath, mtimeMs, sets };
    return sets;
  } catch {
    cachedMockNlu = { path: policyPath, mtimeMs: 0, sets: EMPTY_MOCK_NLU_SETS };
    return EMPTY_MOCK_NLU_SETS;
  }
};

const findPart = (text: string, parts: RouterContext['parts']) => {
  const lower = normalizeText(text);
  const tokenized = normalizeToken(text);
  let best: RouterContext['parts'][number] | null = null;
  let bestScore = -1;

  for (const part of parts) {
    const name = normalizeText(part.name);
    const nameToken = normalizeToken(part.name);
    const idToken = normalizeToken(part.id);
    let score = -1;
    if (lower === name) score = 200;
    else if (lower.includes(name)) score = 120 + name.length;
    else if (name.includes(lower)) score = 60 + lower.length;
    else if (tokenized === nameToken || tokenized === idToken) score = 110;
    else if (tokenized && (nameToken.includes(tokenized) || idToken.includes(tokenized))) score = 80 + tokenized.length;
    else if (tokenized && (tokenized.includes(nameToken) || tokenized.includes(idToken))) score = 65 + nameToken.length;

    if (score > bestScore) {
      bestScore = score;
      best = part;
    }
  }

  return bestScore >= 0 ? best : null;
};

const collectMentionedParts = (text: string, parts: RouterContext['parts']): MentionedPart[] => {
  const lower = normalizeText(text);
  const tokenizedText = normalizeToken(text);
  const found: MentionedPart[] = [];
  const seen = new Set<string>();

  const sorted = [...parts].sort((left, right) => right.name.length - left.name.length);
  for (const part of sorted) {
    const name = normalizeText(part.name);
    const nameToken = normalizeToken(part.name);
    const idToken = normalizeToken(part.id);
    const index = lower.indexOf(name);
    const tokenHit = tokenizedText.includes(nameToken) || tokenizedText.includes(idToken);
    if (index < 0 && !tokenHit) continue;
    if (seen.has(part.id)) continue;
    seen.add(part.id);
    found.push({
      ...part,
      index: index >= 0 ? index : Number.MAX_SAFE_INTEGER - found.length,
      end: index >= 0 ? index + name.length : Number.MAX_SAFE_INTEGER - found.length + 1,
      volume: volumeFromSize(part.bboxSize),
    });
  }

  return found.sort((left, right) => left.index - right.index);
};

const collectMentionedGroups = (
  text: string,
  groups: NonNullable<RouterContext['groups']>,
  parts: RouterContext['parts']
): MentionedPart[] => {
  const lower = normalizeText(text);
  const tokenizedText = normalizeToken(text);
  const found: MentionedPart[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    if (!group.partIds.length) continue;
    const name = normalizeText(group.name);
    const nameToken = normalizeToken(group.name);
    const index = lower.indexOf(name);
    const tokenHit = tokenizedText.includes(nameToken);
    if (index < 0 && !tokenHit) continue;
    if (seen.has(group.id)) continue;
    seen.add(group.id);

    const firstPartId = group.partIds[0] as string;
    const firstPart = parts.find((p) => p.id === firstPartId);
    found.push({
      id: firstPartId,
      name: group.name,
      ...(firstPart?.position ? { position: firstPart.position } : {}),
      ...(firstPart?.bboxSize ? { bboxSize: firstPart.bboxSize } : {}),
      index: index >= 0 ? index : Number.MAX_SAFE_INTEGER - found.length,
      end: index >= 0 ? index + name.length : Number.MAX_SAFE_INTEGER - found.length + 1,
      volume: volumeFromSize(firstPart?.bboxSize),
      groupId: group.id,
    });
  }

  return found.sort((left, right) => left.index - right.index);
};

const detectFaceFromSegment = (
  segment: string,
  nlu: MockProviderNluSets,
  prefer: 'first' | 'last' = 'first'
): MateFaceId | null => {
  const normalized = normalizeText(segment);
  let selectedFace: MateFaceId | null = null;
  let selectedIndex = prefer === 'first' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;

  for (const item of nlu.faces) {
    for (const alias of item.aliases) {
      if (!alias.trim()) continue;
      let start = 0;
      while (start < normalized.length) {
        const index = normalized.indexOf(alias, start);
        if (index < 0) break;
        if (
          (prefer === 'first' && index < selectedIndex) ||
          (prefer === 'last' && index > selectedIndex)
        ) {
          selectedIndex = index;
          selectedFace = item.face;
        }
        start = index + Math.max(alias.length, 1);
      }
    }
  }

  return selectedFace;
};

const detectFaceNear = (
  text: string,
  partName: string,
  partIndex: number,
  partEnd: number,
  nlu: MockProviderNluSets
): MateFaceId | null => {
  const lower = normalizeText(text);
  const before = lower.slice(Math.max(0, partIndex - 24), partIndex);
  const after = lower.slice(partEnd, Math.min(lower.length, partEnd + 24));
  const directAfter = detectFaceFromSegment(after, nlu, 'first');
  if (directAfter) return directAfter;
  const directBefore = detectFaceFromSegment(before, nlu, 'last');
  if (directBefore) return directBefore;

  const name = partName.toLowerCase();
  for (const item of nlu.faces) {
    for (const alias of item.aliases) {
      if (lower.includes(`${name} ${alias}`) || lower.includes(`${alias} ${name}`)) return item.face;
    }
  }
  return null;
};

const detectAnchorMethod = (text: string, nlu: MockProviderNluSets) => {
  const lower = normalizeText(text);
  for (const item of nlu.methods) {
    if (containsAny(lower, item.aliases)) return normalizeMateMethod(item.method, 'planar_cluster');
  }
  return 'planar_cluster' as const;
};

const hasAnchorMethodMention = (text: string, nlu: MockProviderNluSets) => {
  const lower = normalizeText(text);
  return nlu.methods.some((item) => containsAny(lower, item.aliases));
};

const detectExplicitMateMode = (text: string, nlu: MockProviderNluSets): MateModeId | null => {
  const lower = normalizeText(text);
  if (containsAny(lower, nlu.mateModeTokens.both)) return 'both';
  if (containsAny(lower, nlu.mateModeTokens.twist)) return 'twist';
  if (containsAny(lower, nlu.mateModeTokens.translate)) return 'translate';
  return null;
};

type MateSuggestionPick = {
  sourceFace?: MateFaceId;
  targetFace?: MateFaceId;
  sourceMethod?: MateMethodId;
  targetMethod?: MateMethodId;
  score?: number;
};

type MateSuggestionContext = {
  sourcePartId?: string;
  targetPartId?: string;
  suggestedMode?: MateModeId;
  intent?: string;
  expectedFromCenters?: {
    sourceFace?: MateFaceId;
    targetFace?: MateFaceId;
  };
  rankingTop?: MateSuggestionPick;
};

type MateVlmInferenceContext = {
  sourcePartId?: string;
  targetPartId?: string;
  inferred?: {
    sourcePartId?: string;
    targetPartId?: string;
    sourceFace?: MateFaceId;
    targetFace?: MateFaceId;
    sourceMethod?: MateMethodId;
    targetMethod?: MateMethodId;
    mode?: MateModeId;
    intent?: string;
    confidence?: number;
    origin?: string;
    arbitration?: string[];
    reason?: string;
  };
  vlm?: {
    provider?: string;
    confidence?: number;
    viewConsensus?: number;
    viewAgreement?: number;
    voteCount?: number;
    sourcePartRef?: string;
    targetPartRef?: string;
    fallbackUsed?: boolean;
    providerError?: string;
    candidateSelectionSource?: 'model' | 'view_votes' | 'none';
    selectedMatchesConsensus?: boolean;
    diagnosticsFlags?: string[];
  };
  geometry?: MateSuggestionContext;
};

const MATE_FACE_IDS: MateFaceId[] = ['top', 'bottom', 'left', 'right', 'front', 'back'];
const EXEC_MATE_METHOD_IDS: MateMethodId[] = [
  'planar_cluster',
  'geometry_aabb',
  'object_aabb',
  'obb_pca',
  'picked',
];
const MATE_MODE_IDS: MateModeId[] = ['translate', 'twist', 'both'];

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const asMateFace = (value: unknown): MateFaceId | undefined =>
  typeof value === 'string' && MATE_FACE_IDS.includes(value as MateFaceId) ? (value as MateFaceId) : undefined;

const isExecutableMateMethod = (value: unknown): value is MateMethodId =>
  typeof value === 'string' && EXEC_MATE_METHOD_IDS.includes(value as MateMethodId);

const normalizeMateMethod = (value: unknown, fallback: MateMethodId = 'planar_cluster'): MateMethodId => {
  if (typeof value !== 'string') return fallback;
  const method = normalizeText(value) as MateMethodId;
  if (method === 'auto' || method === 'extreme_vertices') return fallback;
  return isExecutableMateMethod(method) ? method : fallback;
};

const asMateMethod = (value: unknown): MateMethodId | undefined => {
  if (typeof value !== 'string') return undefined;
  return normalizeMateMethod(value, 'planar_cluster');
};

const asMateMode = (value: unknown): MateModeId | undefined =>
  typeof value === 'string' && MATE_MODE_IDS.includes(value as MateModeId) ? (value as MateModeId) : undefined;

const asMateConfidence = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, Number(value))) : undefined;

const summarizeVlmDiagFlagZh = (flag: string): string | null => {
  switch (flag) {
    case 'view_vote_conflict':
      return '視角衝突';
    case 'view_votes_consistent':
      return '視角一致';
    case 'selected_candidate_derived_from_view_votes':
      return '投票補選';
    case 'candidate_field_sync_applied':
      return '候選回填';
    case 'part_ref_normalized':
      return '零件名正規化';
    case 'confidence_clamped':
      return '信心值截斷';
    case 'enum_normalized':
      return '欄位正規化';
    case 'view_vote_deduped':
      return '視角去重';
    case 'view_votes_missing':
      return '無視角票';
    default:
      return null;
  }
};

const summarizeArbitrationZh = (tag: string): string | null => {
  switch (tag) {
    case 'cover_center_drift_guard':
    case 'insert_center_drift_guard':
      return '防中心漂移';
    case 'cover_vertical_face_override':
      return '蓋合改垂直面';
    case 'insert_vertical_face_override':
      return '插入改垂直面';
    case 'cover_mode_force_both':
      return '蓋合改both';
    case 'insert_mode_twist_to_both':
      return '插入改both';
    case 'insert_target_method_guard':
      return '插槽方法保護';
    case 'vlm_view_consensus_low':
      return '視角一致性低';
    case 'vlm_view_consensus_applied':
      return '採用視角共識';
    case 'vlm_consensus_candidate_override':
      return '共識候選覆寫';
    default:
      return null;
  }
};

const summarizeMateVlmContextZh = (params: {
  consensus?: number;
  selection?: 'model' | 'view_votes' | 'none';
  fallback?: boolean;
  provider?: string;
  diagFlags?: string[];
  arbitration?: string[];
}) => {
  const items: string[] = [];
  if (typeof params.consensus === 'number') {
    if (params.consensus < 0.5) items.push('視角分歧');
    else if (params.consensus >= 0.75) items.push('視角高度一致');
    else items.push('視角大致一致');
  }
  if (params.selection === 'view_votes') items.push('候選由投票決定');
  else if (params.selection === 'model') items.push('候選由模型直選');
  if (params.fallback) items.push(`視覺fallback(${params.provider || 'provider'})`);

  for (const flag of params.diagFlags || []) {
    const label = summarizeVlmDiagFlagZh(flag);
    if (label) items.push(label);
  }
  for (const tag of params.arbitration || []) {
    const label = summarizeArbitrationZh(tag);
    if (label) items.push(label);
  }

  return [...new Set(items)].slice(0, 3);
};

const extractSuggestionData = (result: unknown) => {
  const root = asObject(result);
  if (!root) return null;
  const rootData = asObject(root.data);
  if (rootData) return rootData;
  const nestedResult = asObject(root.result);
  if (!nestedResult) return root;
  const nestedData = asObject(nestedResult.data);
  return nestedData || nestedResult;
};



const extractMateSuggestionContext = (
  ctx: RouterContext,
  sourcePartId?: string,
  targetPartId?: string
): MateSuggestionContext | null => {
  const toolResults = Array.isArray(ctx.toolResults) ? ctx.toolResults : [];
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const item = toolResults[index];
    if (!item || item.tool !== 'query.mate_suggestions' || !item.ok) continue;
    const data = extractSuggestionData(item.result);
    if (!data) continue;

    const sourceObj = asObject(data.source);
    const targetObj = asObject(data.target);
    const resultSourceId =
      (typeof sourceObj?.partId === 'string' ? sourceObj.partId : undefined) ||
      (typeof sourceObj?.partName === 'string' ? sourceObj.partName : undefined);
    const resultTargetId =
      (typeof targetObj?.partId === 'string' ? targetObj.partId : undefined) ||
      (typeof targetObj?.partName === 'string' ? targetObj.partName : undefined);

    if (sourcePartId && targetPartId) {
      if (resultSourceId && resultTargetId) {
        if (resultSourceId !== sourcePartId || resultTargetId !== targetPartId) continue;
      }
    }

    const ranking = Array.isArray(data.ranking) ? data.ranking : [];
    const rankingTop = ranking.length > 0 ? asObject(ranking[0]) : null;
    const expected = asObject(data.expectedFromCenters);
    return {
      sourcePartId: resultSourceId,
      targetPartId: resultTargetId,
      suggestedMode: asMateMode(data.suggestedMode),
      intent: typeof data.intent === 'string' ? data.intent : undefined,
      expectedFromCenters: expected
        ? {
            sourceFace: asMateFace(expected.sourceFace),
            targetFace: asMateFace(expected.targetFace),
          }
        : undefined,
      rankingTop: rankingTop
        ? {
            sourceFace: asMateFace(rankingTop.sourceFace),
            targetFace: asMateFace(rankingTop.targetFace),
            sourceMethod: asMateMethod(rankingTop.sourceMethod),
            targetMethod: asMateMethod(rankingTop.targetMethod),
            score: typeof rankingTop.score === 'number' ? Number(rankingTop.score) : undefined,
          }
        : undefined,
    };
  }
  return null;
};

const extractMateVlmInferenceContext = (
  ctx: RouterContext,
  sourcePartId?: string,
  targetPartId?: string
): MateVlmInferenceContext | null => {
  const toolResults = Array.isArray(ctx.toolResults) ? ctx.toolResults : [];
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const item = toolResults[index];
    if (!item || item.tool !== 'query.mate_vlm_infer' || !item.ok) continue;
    const data = extractSuggestionData(item.result);
    if (!data) continue;

    const sourceObj = asObject(data.source);
    const targetObj = asObject(data.target);
    const inferredObj = asObject(data.inferred);
    const vlmObj = asObject(data.vlm);
    const vlmMateObj = asObject(vlmObj?.mateInference);
    const vlmDiagObj = asObject(vlmObj?.diagnostics);
    const geometryObj = asObject(data.geometry);
    const geometryExpected = asObject(geometryObj?.expectedFromCenters);
    const geometryRankingTop = asObject(geometryObj?.rankingTop);

    const resultSourceId =
      (typeof sourceObj?.partId === 'string' ? sourceObj.partId : undefined) ||
      (typeof inferredObj?.sourcePartId === 'string' ? inferredObj.sourcePartId : undefined);
    const resultTargetId =
      (typeof targetObj?.partId === 'string' ? targetObj.partId : undefined) ||
      (typeof inferredObj?.targetPartId === 'string' ? inferredObj.targetPartId : undefined);

    if (sourcePartId && targetPartId && resultSourceId && resultTargetId) {
      const sameOrder = resultSourceId === sourcePartId && resultTargetId === targetPartId;
      const swappedOrder = resultSourceId === targetPartId && resultTargetId === sourcePartId;
      if (!sameOrder && !swappedOrder) continue;
    }

    return {
      sourcePartId: resultSourceId,
      targetPartId: resultTargetId,
      inferred: inferredObj
        ? {
            sourcePartId: typeof inferredObj.sourcePartId === 'string' ? inferredObj.sourcePartId : undefined,
            targetPartId: typeof inferredObj.targetPartId === 'string' ? inferredObj.targetPartId : undefined,
            sourceFace: asMateFace(inferredObj.sourceFace),
            targetFace: asMateFace(inferredObj.targetFace),
            sourceMethod: asMateMethod(inferredObj.sourceMethod),
            targetMethod: asMateMethod(inferredObj.targetMethod),
            mode: asMateMode(inferredObj.mode),
            intent: typeof inferredObj.intent === 'string' ? inferredObj.intent : undefined,
            confidence: asMateConfidence(inferredObj.confidence),
            origin: typeof inferredObj.origin === 'string' ? inferredObj.origin : undefined,
            arbitration: Array.isArray(inferredObj.arbitration)
              ? inferredObj.arbitration.filter((item): item is string => typeof item === 'string').slice(0, 6)
              : undefined,
            reason: typeof inferredObj.reason === 'string' ? inferredObj.reason : undefined,
          }
        : undefined,
      vlm: vlmObj
        ? {
            provider: typeof vlmObj.provider === 'string' ? vlmObj.provider : (typeof vlmDiagObj?.provider === 'string' ? vlmDiagObj.provider : undefined),
            confidence: asMateConfidence(vlmObj.confidence),
            viewConsensus: asMateConfidence(vlmObj.viewConsensus),
            viewAgreement: asMateConfidence(vlmObj.viewAgreement),
            voteCount:
              typeof vlmObj.voteCount === 'number' && Number.isFinite(vlmObj.voteCount)
                ? Math.max(0, Math.floor(Number(vlmObj.voteCount)))
                : undefined,
            sourcePartRef: typeof vlmMateObj?.sourcePartRef === 'string' ? vlmMateObj.sourcePartRef : undefined,
            targetPartRef: typeof vlmMateObj?.targetPartRef === 'string' ? vlmMateObj.targetPartRef : undefined,
            fallbackUsed:
              typeof vlmDiagObj?.fallbackUsed === 'boolean'
                ? vlmDiagObj.fallbackUsed
                : typeof vlmDiagObj?.fallback_used === 'boolean'
                ? (vlmDiagObj.fallback_used as boolean)
                : undefined,
            providerError:
              typeof vlmDiagObj?.providerError === 'string'
                ? vlmDiagObj.providerError
                : typeof vlmDiagObj?.provider_error === 'string'
                ? vlmDiagObj.provider_error
                : undefined,
            candidateSelectionSource:
              typeof vlmDiagObj?.candidateSelectionSource === 'string' &&
              ['model', 'view_votes', 'none'].includes(vlmDiagObj.candidateSelectionSource)
                ? (vlmDiagObj.candidateSelectionSource as 'model' | 'view_votes' | 'none')
                : typeof vlmDiagObj?.candidate_selection_source === 'string' &&
                  ['model', 'view_votes', 'none'].includes(vlmDiagObj.candidate_selection_source)
                ? (vlmDiagObj.candidate_selection_source as 'model' | 'view_votes' | 'none')
                : undefined,
            selectedMatchesConsensus:
              typeof vlmDiagObj?.selectedMatchesConsensus === 'boolean'
                ? vlmDiagObj.selectedMatchesConsensus
                : typeof vlmDiagObj?.selected_matches_consensus === 'boolean'
                ? (vlmDiagObj.selected_matches_consensus as boolean)
                : undefined,
            diagnosticsFlags: Array.isArray(vlmDiagObj?.flags)
              ? vlmDiagObj.flags.filter((item): item is string => typeof item === 'string').slice(0, 6)
              : undefined,
          }
        : undefined,
      geometry: geometryObj
        ? {
            sourcePartId: resultSourceId,
            targetPartId: resultTargetId,
            suggestedMode: asMateMode(geometryObj.suggestedMode),
            intent: typeof geometryObj.intent === 'string' ? geometryObj.intent : undefined,
            expectedFromCenters: geometryExpected
              ? {
                  sourceFace: asMateFace(geometryExpected.sourceFace),
                  targetFace: asMateFace(geometryExpected.targetFace),
                }
              : undefined,
            rankingTop: geometryRankingTop
              ? {
                  sourceFace: asMateFace(geometryRankingTop.sourceFace),
                  targetFace: asMateFace(geometryRankingTop.targetFace),
                  sourceMethod: asMateMethod(geometryRankingTop.sourceMethod),
                  targetMethod: asMateMethod(geometryRankingTop.targetMethod),
                  score: typeof geometryRankingTop.score === 'number' ? Number(geometryRankingTop.score) : undefined,
                }
              : undefined,
          }
        : undefined,
    };
  }
  return null;
};

const inferSourceTarget = (text: string, mentioned: MentionedPart[], nlu: MockProviderNluSets) => {
  const lower = normalizeText(text);
  const first = mentioned[0];
  const second = mentioned[1];
  if (!first || !second) return null;

  let source = first;
  let target = second;
  let explicitDirection = false;
  let sourceFromKeyword = false;
  let targetFromKeyword = false;

  const sourceKeywords = nlu.sourceTarget.sourceKeywords;
  const targetKeywords = nlu.sourceTarget.targetKeywords;

  const sourceNearFirst = sourceKeywords.some((token) => {
    const before = lower.slice(Math.max(0, first.index - 20), first.index);
    const after = lower.slice(first.end, Math.min(lower.length, first.end + 20));
    return before.includes(token.trim()) || after.includes(token.trim());
  });
  const sourceNearSecond = sourceKeywords.some((token) => {
    const before = lower.slice(Math.max(0, second.index - 20), second.index);
    const after = lower.slice(second.end, Math.min(lower.length, second.end + 20));
    return before.includes(token.trim()) || after.includes(token.trim());
  });
  const targetNearFirst = targetKeywords.some((token) => {
    const before = lower.slice(Math.max(0, first.index - 20), first.index);
    const after = lower.slice(first.end, Math.min(lower.length, first.end + 20));
    return before.includes(token.trim()) || after.includes(token.trim());
  });
  const targetNearSecond = targetKeywords.some((token) => {
    const before = lower.slice(Math.max(0, second.index - 20), second.index);
    const after = lower.slice(second.end, Math.min(lower.length, second.end + 20));
    return before.includes(token.trim()) || after.includes(token.trim());
  });

  if (sourceNearFirst && targetNearSecond) {
    source = first;
    target = second;
    explicitDirection = true;
    sourceFromKeyword = true;
    targetFromKeyword = true;
  } else if (sourceNearSecond && targetNearFirst) {
    source = second;
    target = first;
    explicitDirection = true;
    sourceFromKeyword = true;
    targetFromKeyword = true;
  }

  const directionTokens = nlu.sourceTarget.directionTokens;
  let directionIndex = -1;
  for (const token of directionTokens) {
    directionIndex = lower.indexOf(token);
    if (directionIndex >= 0) break;
  }
  if (directionIndex >= 0) {
    const before = [...mentioned].filter((item) => item.index < directionIndex).pop();
    const after = mentioned.find((item) => item.index > directionIndex);
    if (before && after && before.id !== after.id) {
      source = before;
      target = after;
      explicitDirection = true;
    }
  }

  if (!explicitDirection && !sourceFromKeyword && !targetFromKeyword) {
    const placementKeywords = nlu.sourceTarget.placementKeywords;
    const hasPlacementVerb = containsAny(lower, placementKeywords);
    if (hasPlacementVerb) {
      const targetNameKeywords = nlu.sourceTarget.targetNameKeywords;
      const firstLooksLikeTarget = targetNameKeywords.some((kw) => first.name.toLowerCase().includes(kw));
      const secondLooksLikeTarget = targetNameKeywords.some((kw) => second.name.toLowerCase().includes(kw));
      if (firstLooksLikeTarget !== secondLooksLikeTarget) {
        target = firstLooksLikeTarget ? first : second;
        source = target.id === first.id ? second : first;
      } else if (Math.max(first.volume, second.volume) / Math.min(first.volume, second.volume) >= 1.4) {
        target = first.volume >= second.volume ? first : second;
        source = target.id === first.id ? second : first;
      }
    }
  }

  return { source, target, explicitDirection };
};

const shouldAllowLlmSourceTargetOverride = (text: string, nlu: MockProviderNluSets) => {
  const lower = normalizeText(text);
  return containsAny(lower, nlu.sourceTarget.llmOverrideKeywords);
};

const formatModelSummary = (ctx: RouterContext) => {
  const fileLabel = ctx.cadFileName ? `\`${ctx.cadFileName}\`` : '目前模型';
  const names = ctx.parts.slice(0, 6).map((part) => part.name);
  const partsLine =
    names.length > 0
      ? `${ctx.parts.length} 個零件：${names.join('、')}${ctx.parts.length > names.length ? '…' : ''}`
      : '目前尚未載入可辨識零件';
  const stepLine = typeof ctx.stepCount === 'number' ? `目前 steps：${ctx.stepCount}` : '目前 steps：未知';
  return `${fileLabel}，包含 ${partsLine}。${stepLine}。`;
};

const detectEnvironment = (text: string, nlu: MockProviderNluSets) => {
  for (const item of nlu.environments) {
    if (text.includes(item.alias)) return item.environment;
  }
  return null;
};

const detectMode = (text: string, nlu: MockProviderNluSets): InteractionModeId | null => {
  if (containsAny(text, nlu.interactionModes.rotate)) return 'rotate';
  if (containsAny(text, nlu.interactionModes.move)) return 'move';
  if (containsAny(text, nlu.interactionModes.mate)) return 'mate';
  if (containsAny(text, nlu.interactionModes.select)) return 'select';
  return null;
};

const looksLikeStepQuestion = (text: string, keywords: RouterKeywordSets) =>
  containsAny(text, keywords.stepHelp) || (containsAny(text, ['step']) && containsAny(text, keywords.question));

const looksLikeGeneralQuestion = (text: string, keywords: RouterKeywordSets, nlu: MockProviderNluSets) =>
  containsAny(text, keywords.question) ||
  text.endsWith('?') ||
  text.endsWith('？') ||
  containsAny(text, nlu.generalQuestionTokens);

const PROVIDER_STATUS_KEYWORDS = [
  'mock',
  'ollama',
  'gemini',
  'llm',
  'vlm',
  'provider',
  '模型',
  'model',
  '你是使用',
  '你用',
];


const buildProviderStatusReply = () => {
  const routerProvider = String(process.env.ROUTER_PROVIDER || 'mock').trim().toLowerCase();
  const llmEnabled = process.env.ROUTER_LLM_ENABLE !== '0';
  const llmProvider = llmEnabled ? String(process.env.ROUTER_LLM_PROVIDER || 'auto').trim().toLowerCase() : 'none';
  const vlmProvider = String(process.env.V2_VLM_PROVIDER || process.env.VLM_PROVIDER || 'auto').trim().toLowerCase();
  const llmModel = process.env.ROUTER_LLM_MODEL || process.env.OLLAMA_MODEL || 'qwen3:30b';
  const vlmModel = process.env.VLM_MATE_MODEL || process.env.OLLAMA_MODEL || 'qwen3.5:27b';
  return `目前設定：router=${routerProvider}，llm=${llmProvider}/${llmModel}，vlm=${vlmProvider}/${vlmModel}。`;
};

const buildFallbackReply = (ctx: RouterContext) => {
  if (!ctx.parts.length) {
    return '目前場景還沒有零件。先載入模型，再用「mate part1 and part2」或「切到 rotate 模式」。';
  }
  const sampleParts = ctx.parts.slice(0, 3).map((part) => part.name).join('、');
  return `目前有 ${ctx.parts.length} 個零件（例如：${sampleParts}）。你可以說「mate A and B」、「select A」或「add step 安裝」。`;
};

const buildStepHelpReply = () =>
  [
    '你可以直接問我，也可以直接下指令。',
    '新增 step 指令範例：',
    '- `新增 step 安裝定位`',
    '- `add step align cap to body`',
    '或先做完一個操作後輸入 `更新這個 step` / `save step`。',
  ].join('\n');

export const MockRouterProvider: RouterProvider = {
  async route(text: string, ctx: RouterContext) {
    const lower = normalizeText(text);
    const keywords = getKeywordSets();
    const nlu = getMockNluSets();
    const calls: ToolCall[] = [];

    if (!lower.trim()) {
      return { toolCalls: [], replyText: '請先輸入你想做的事。' };
    }

    if (containsAny(lower, keywords.greeting)) {
      return {
        toolCalls: [],
        replyText: ctx.parts.length
          ? `你好，目前場景有 ${ctx.parts.length} 個零件。你可以說「mate part1 and part2」或「如何新增step」。`
          : '你好！先載入模型後，我可以幫你做 mate、選取、重置或切換視圖。',
      };
    }

    if (containsAny(lower, keywords.thanks)) {
      return { toolCalls: [], replyText: '不客氣。你可以直接用自然句子說你要做的操作。' };
    }

    if (looksLikeStepQuestion(lower, keywords)) {
      return { toolCalls: [], replyText: buildStepHelpReply() };
    }

    if (containsAny(lower, keywords.stepCommand) && !containsAny(lower, keywords.question)) {
      // "delete step N" / "刪除 step N"
      const deleteMatch = lower.match(/(?:delete|remove|刪除|移除)\s*(?:step|步驟|步)\s*(\d+)/i);
      if (deleteMatch) {
        const stepNum = parseInt(deleteMatch[1]!, 10);
        const stepList = ctx.steps ?? [];
        const target = stepList.find((s) => s.index + 1 === stepNum);
        if (target) {
          calls.push({ tool: 'steps.delete', args: { stepId: target.id }, confidence: 0.93 });
          return { toolCalls: calls, replyText: `已刪除 Step ${stepNum}。` };
        }
        return { toolCalls: [], replyText: `找不到 Step ${stepNum}。目前共有 ${stepList.length} 個 step。` };
      }

      // "insert step after step N" / "在 step N 後面插入"
      const insertMatch = lower.match(/(?:insert|add|新增|插入)\s*(?:step|步驟)?\s*(?:after|在|之後|後面)?\s*(?:step|步驟|步)?\s*(\d+)/i)
        ?? lower.match(/(?:step|步驟|步)\s*(\d+)\s*(?:之後|後面|after)\s*(?:insert|add|新增|插入)/i);
      if (insertMatch) {
        const afterNum = parseInt(insertMatch[1]!, 10);
        const stepList = ctx.steps ?? [];
        const afterStep = stepList.find((s) => s.index + 1 === afterNum);
        const label = `Step ${stepList.length + 1}`;
        calls.push({
          tool: 'steps.insert',
          args: { afterStepId: afterStep?.id ?? null, label, select: true },
          confidence: 0.9,
        });
        return { toolCalls: calls, replyText: `已在 Step ${afterNum} 後插入新 Step。` };
      }

      // plain "add step"
      const stepList2 = ctx.steps ?? [];
      const label = `Step ${stepList2.length + 1}`;
      calls.push({
        tool: 'steps.add',
        args: { label, select: true },
        confidence: 0.9,
      });
      return { toolCalls: calls, replyText: `已新增 ${label}。` };
    }

    if (containsAny(lower, keywords.chatHelp)) {
      return {
        toolCalls: [],
        replyText: [
          '可直接對我說：',
          '- `mate part1 and part2`',
          '- `mate part1 bottom and part2 top use object aabb method`',
          '- `切到 rotate 模式`、`把格線關掉`、`重置全部`',
          '- `這個 usd 模型是什麼`、`如何新增 step`',
        ].join('\n'),
      };
    }

    if (containsAny(lower, keywords.modelInfo)) {
      return {
        toolCalls: [],
        replyText: `模型資訊：${formatModelSummary(ctx)}`,
      };
    }

    if (containsAny(lower, ['undo', '撤銷', '撤销', '上一步'])) {
      calls.push({ tool: 'history.undo', args: {}, confidence: 0.92 });
      return { toolCalls: calls, replyText: '已幫你執行復原。' };
    }

    if (containsAny(lower, ['redo', '重做', '恢復', '恢复'])) {
      calls.push({ tool: 'history.redo', args: {}, confidence: 0.92 });
      return { toolCalls: calls, replyText: '已幫你執行重做。' };
    }

    const AUTO_ASSEMBLE_INLINE = ['mate all', 'assemble all', 'auto assemble', 'autoassemble', '自動組裝', '全部組裝', '一鍵組裝'];
    if (
      (keywords.autoAssemble.length > 0 && containsAny(lower, keywords.autoAssemble)) ||
      containsAny(lower, AUTO_ASSEMBLE_INLINE)
    ) {
      calls.push({ tool: 'action.auto_assemble', args: {}, confidence: 0.92 });
      return { toolCalls: calls, replyText: '正在自動組裝所有零件，請稍候…' };
    }

    if (containsAny(lower, keywords.reset)) {
      const resetAll = containsAny(lower, keywords.all);
      if (resetAll) {
        calls.push({ tool: 'action.reset_all', args: {}, confidence: 0.9 });
        return { toolCalls: calls, replyText: '已重置全部零件。' };
      }

      // Detect reset mode: 'manual' if user says "restore" / "回到移動位置" / "回到手動"
      const wantsManual = containsAny(lower, ['restore', '移動位置', '手動位置', '手動', 'manual']);
      const mode = wantsManual ? 'manual' : 'initial';

      const part = findPart(lower, ctx.parts);
      if (part) {
        calls.push({
          tool: 'action.reset_part_transform',
          args: { part: { partId: part.id }, mode },
          confidence: 0.86,
        });
        const modeLabel = wantsManual ? '移動位置' : '初始位置';
        return { toolCalls: calls, replyText: `已重置 ${part.name} 到${modeLabel}。` };
      }

      calls.push({ tool: 'action.reset_all', args: {}, confidence: 0.6 });
      return { toolCalls: calls, replyText: '沒有辨識到指定零件，已先重置全部零件。' };
    }

    if (containsAny(lower, keywords.grid.keywords)) {
      const turnOn = containsAny(lower, keywords.grid.on);
      const turnOff = containsAny(lower, keywords.grid.off);
      if (turnOn || turnOff) {
        calls.push({
          tool: 'view.set_grid_visible',
          args: { visible: turnOn && !turnOff },
          confidence: 0.92,
        });
        return { toolCalls: calls, replyText: turnOn && !turnOff ? '格線已開啟。' : '格線已關閉。' };
      }
      return { toolCalls: [], replyText: '你要我把格線打開還是關掉？' };
    }

    const env = detectEnvironment(lower, nlu);
    if (env) {
      calls.push({
        tool: 'view.set_environment',
        args: { environment: env },
        confidence: 0.9,
      });
      return { toolCalls: calls, replyText: `環境已切換到 ${env}。` };
    }

    if (containsAny(lower, PROVIDER_STATUS_KEYWORDS)) {
      return {
        toolCalls: [],
        replyText: buildProviderStatusReply(),
      };
    }

    const mentionedParts = collectMentionedParts(text, ctx.parts);
    const mentionedGroups = collectMentionedGroups(text, ctx.groups ?? [], ctx.parts);
    const coveredByGroup = new Set(
      mentionedGroups.flatMap((mg) => {
        const grp = (ctx.groups ?? []).find((g) => g.id === mg.groupId);
        return grp ? grp.partIds : [];
      })
    );
    const mentioned = [
      ...mentionedParts.filter((p) => !coveredByGroup.has(p.id)),
      ...mentionedGroups,
    ].sort((a, b) => a.index - b.index);
    const mateLike = containsAny(lower, keywords.mate) || (lower.includes(' and ') && mentioned.length >= 2);
    if (mateLike) {
      if (mentioned.length < 2) {
        return {
          toolCalls: [],
          replyText: '我需要兩個零件名稱才能執行 mate，例如：`mate part1 and part2`。',
        };
      }

      const inferred = inferSourceTarget(text, mentioned, nlu);
      if (!inferred) {
        return {
          toolCalls: [],
          replyText: '我有偵測到零件名稱，但無法判定 source/target。請再描述一次「A 到 B」。',
        };
      }

      let source = inferred.source;
      let target = inferred.target;
      let mode = detectExplicitMateMode(text, nlu) ?? undefined;
      const detectedSourceFace = detectFaceNear(text, inferred.source.name, inferred.source.index, inferred.source.end, nlu);
      const detectedTargetFace = detectFaceNear(text, inferred.target.name, inferred.target.index, inferred.target.end, nlu);
      let sourceFace = detectedSourceFace || undefined;
      let targetFace = detectedTargetFace || undefined;
      const methodMentioned = hasAnchorMethodMention(text, nlu);
      const detectedMethod = detectAnchorMethod(text, nlu);
      let sourceMethod = methodMentioned ? detectedMethod : undefined;
      let targetMethod = methodMentioned ? detectedMethod : undefined;

      const explicitSourceFace = detectedSourceFace !== null;
      const explicitTargetFace = detectedTargetFace !== null;
      const hasFaceMention = nlu.faces.some((item) => containsAny(lower, item.aliases));
      const explicitFace = explicitSourceFace || explicitTargetFace || hasFaceMention;
      const explicitMethod = methodMentioned;
      const explicitMode = mode !== undefined;
      const explicitDirection = Boolean(inferred.explicitDirection);

      const mateVlmContext = extractMateVlmInferenceContext(ctx, source.id, target.id);
      const hasMateVlmContext = Boolean(mateVlmContext);
      const hasMateSuggestionContext = Boolean(extractMateSuggestionContext(ctx, source.id, target.id));

      if (!hasMateVlmContext) {
        calls.push({
          tool: 'query.mate_vlm_infer',
          args: {
            sourcePart: { partId: source.id },
            targetPart: { partId: target.id },
            instruction: text,
            ...(sourceFace ? { preferredSourceFace: sourceFace } : {}),
            ...(targetFace ? { preferredTargetFace: targetFace } : {}),
            sourceMethod: normalizeMateMethod(sourceMethod ?? 'planar_cluster', 'planar_cluster'),
            targetMethod: normalizeMateMethod(targetMethod ?? 'planar_cluster', 'planar_cluster'),
            ...(mode ? { preferredMode: mode } : {}),
            maxPairs: 12,
            maxViews: 6,
            maxWidthPx: 960,
            maxHeightPx: 640,
            format: 'jpeg',
          },
          confidence: 0.95,
        });
        return {
          toolCalls: calls,
          replyText: `正在擷取 ${source.name} 與 ${target.name} 的多角度影像，並用 VLM/VLA 分析 source/target、face、method、mode、intent…`,
        };
      }

      const mapVlmPartRefToMentioned = (ref?: string) => {
        if (!ref) return null;
        const token = normalizeToken(ref);
        if (!token) return null;
        return (
          mentioned.find((part) => normalizeToken(part.id) === token || normalizeToken(part.name) === token) || null
        );
      };

      const vlmInferred = mateVlmContext?.inferred;
      const vlmRefSource = mapVlmPartRefToMentioned(mateVlmContext?.vlm?.sourcePartRef);
      const vlmRefTarget = mapVlmPartRefToMentioned(mateVlmContext?.vlm?.targetPartRef);
      const vlmRefConfidence = Number(mateVlmContext?.vlm?.confidence ?? 0);
      if (
        !explicitDirection &&
        shouldAllowLlmSourceTargetOverride(text, nlu) &&
        vlmRefConfidence >= 0.82 &&
        vlmRefSource &&
        vlmRefTarget &&
        vlmRefSource.id !== vlmRefTarget.id
      ) {
        source = vlmRefSource;
        target = vlmRefTarget;
      }

      // Geometry context from VLM infer result — rotation-invariant
      const geometryCtx = mateVlmContext?.geometry;
      // Geometry-computed mode is authoritative (accounts for actual quaternion mismatch)
      if (!explicitMode) mode = geometryCtx?.suggestedMode ?? vlmInferred?.mode;
      // For insert intent, the correct face pair is a property of the TARGET's cavity geometry
      // (almost always bottom→top).  VLM visual inference is unreliable here because the source
      // part may be far from, or rotated relative to, the target — making "which side faces where"
      // visually ambiguous.  Use the geometry-precomputed rankingTop / expectedFromCenters instead.
      const geoIntentIsInsert = geometryCtx?.intent === 'insert' || vlmInferred?.intent === 'insert';
      const useGeoFace = geoIntentIsInsert && !explicitFace;
      const geoFaceSrc = geometryCtx?.rankingTop?.sourceFace ?? geometryCtx?.expectedFromCenters?.sourceFace;
      const geoFaceTgt = geometryCtx?.rankingTop?.targetFace ?? geometryCtx?.expectedFromCenters?.targetFace;
      if (!explicitSourceFace) sourceFace = (useGeoFace && geoFaceSrc) ? geoFaceSrc : vlmInferred?.sourceFace;
      if (!explicitTargetFace) targetFace = (useGeoFace && geoFaceTgt) ? geoFaceTgt : vlmInferred?.targetFace;
      const allowVlmMethodOverride = !explicitMethod && (!explicitFace || !explicitMode);
      if (allowVlmMethodOverride && vlmInferred?.sourceMethod) sourceMethod = vlmInferred.sourceMethod;
      if (allowVlmMethodOverride && vlmInferred?.targetMethod) targetMethod = vlmInferred.targetMethod;

      if ((!explicitFace || !explicitMethod || !explicitMode) && !hasMateSuggestionContext && !hasMateVlmContext) {
        const llmInference = await inferMateWithLlm(text, ctx);
        if (llmInference) {
          if (
            !explicitDirection &&
            shouldAllowLlmSourceTargetOverride(text, nlu) &&
            Number(llmInference.confidence ?? 0) >= 0.82
          ) {
            const sourceCandidate = mentioned.find((part) => part.id === llmInference.sourcePartId);
            const targetCandidate = mentioned.find((part) => part.id === llmInference.targetPartId);
            if (sourceCandidate && targetCandidate && sourceCandidate.id !== targetCandidate.id) {
              source = sourceCandidate;
              target = targetCandidate;
            }
          }
          if (!explicitMode && llmInference.mode) mode = llmInference.mode;
          if (!explicitSourceFace && llmInference.sourceFace) sourceFace = llmInference.sourceFace;
          if (!explicitTargetFace && llmInference.targetFace) targetFace = llmInference.targetFace;
          if (!explicitMethod && llmInference.sourceMethod) sourceMethod = llmInference.sourceMethod;
          if (!explicitMethod && llmInference.targetMethod) targetMethod = llmInference.targetMethod;
        }
      }

      const suggestionContext = mateVlmContext?.geometry ?? extractMateSuggestionContext(ctx, source.id, target.id);
      const needsSuggestionRound = (!explicitFace || !explicitMethod || !explicitMode) && !suggestionContext && !hasMateVlmContext;
      if (needsSuggestionRound) {
        calls.push({
          tool: 'query.mate_suggestions',
          args: {
            sourcePart: { partId: source.id },
            targetPart: { partId: target.id },
            instruction: text,
            ...(sourceFace ? { preferredSourceFace: sourceFace } : {}),
            ...(targetFace ? { preferredTargetFace: targetFace } : {}),
            sourceMethod: normalizeMateMethod(sourceMethod ?? 'planar_cluster', 'planar_cluster'),
            targetMethod: normalizeMateMethod(targetMethod ?? 'planar_cluster', 'planar_cluster'),
            maxPairs: 12,
          },
          confidence: 0.94,
        });
        return {
          toolCalls: calls,
          replyText: `正在分析 ${source.name} 與 ${target.name} 的接觸面與裝配方式，接著會自動執行 mate。`,
        };
      }

      const rankingTop = suggestionContext?.rankingTop;
      const expectedFromCenters = suggestionContext?.expectedFromCenters;
      const useSuggestedMethod = suggestionContext?.intent === 'insert' && !explicitFace;
      const resolvedSourceFace =
        sourceFace ?? rankingTop?.sourceFace ?? expectedFromCenters?.sourceFace ?? 'bottom';
      const resolvedTargetFace =
        targetFace ?? rankingTop?.targetFace ?? expectedFromCenters?.targetFace ?? 'top';
      const resolvedSourceMethod =
        normalizeMateMethod(sourceMethod ?? (useSuggestedMethod ? rankingTop?.sourceMethod : undefined), 'planar_cluster');
      const resolvedTargetMethod =
        normalizeMateMethod(targetMethod ?? (useSuggestedMethod ? rankingTop?.targetMethod : undefined), 'planar_cluster');
      const resolvedMode = mode ?? suggestionContext?.suggestedMode ?? 'both';
      const resolvedIntent = vlmInferred?.intent ?? suggestionContext?.intent;
      const inferredVia = vlmInferred?.origin ?? (hasMateVlmContext ? 'hybrid' : undefined);
      const inferredConfidence = typeof vlmInferred?.confidence === 'number' ? vlmInferred.confidence : undefined;
      const inferredConsensus = mateVlmContext?.vlm?.viewConsensus;
      const inferredArb = Array.isArray(vlmInferred?.arbitration) ? vlmInferred.arbitration.filter(Boolean).slice(0, 3) : [];
      const vlmDiagFlags = Array.isArray(mateVlmContext?.vlm?.diagnosticsFlags)
        ? mateVlmContext.vlm.diagnosticsFlags.filter(Boolean).slice(0, 3)
        : [];
      const vlmDiagSelection = mateVlmContext?.vlm?.candidateSelectionSource;
      const vlmDiagFallback = mateVlmContext?.vlm?.fallbackUsed;
      const vlmDiagProvider = mateVlmContext?.vlm?.provider;
      const vlmDiagSummaryZh = summarizeMateVlmContextZh({
        consensus: inferredConsensus,
        selection: vlmDiagSelection,
        fallback: vlmDiagFallback,
        provider: vlmDiagProvider,
        diagFlags: vlmDiagFlags,
        arbitration: inferredArb,
      });

      // Parse twist angle from natural language, e.g. "twist 90", "spin -45 tangent", "twist 180 x"
      const twistMatch = text.match(
        /\b(?:twist|spin)\s+(-?\d+(?:\.\d+)?)\s*(?:deg(?:rees?)?|°)?(?:\s+(?:around\s+)?(\w+))?/i
      );
      const twistDeg = twistMatch ? parseFloat(twistMatch[1]!) : undefined;
      const twistAxisRaw = twistMatch?.[2]?.toLowerCase();
      const VALID_TWIST_AXES = ['x', 'y', 'z', 'normal', 'tangent', 'bitangent'];
      const twistAxis = VALID_TWIST_AXES.includes(twistAxisRaw ?? '') ? twistAxisRaw : 'normal';
      const twistSpace = (twistAxis === 'x' || twistAxis === 'y' || twistAxis === 'z') ? 'world' : 'target_face';

      calls.push({
        tool: 'action.mate_execute',
        args: {
          sourcePart: { partId: source.id },
          targetPart: { partId: target.id },
          ...(source.groupId ? { sourceGroupId: source.groupId } : {}),
          ...(target.groupId ? { targetGroupId: target.groupId } : {}),
          sourceFace: resolvedSourceFace,
          targetFace: resolvedTargetFace,
          sourceMethod: resolvedSourceMethod,
          targetMethod: resolvedTargetMethod,
          mode: resolvedMode,
          mateMode: resolvedIntent === 'insert' ? 'face_insert_arc' : 'face_flush',
          pathPreference: resolvedIntent === 'insert' ? 'arc' : 'line',
          ...(twistDeg !== undefined ? {
            twist: { angleDeg: twistDeg, axis: twistAxis, axisSpace: twistSpace, constraint: 'free' }
          } : {}),
          commit: true,
          pushHistory: true,
          stepLabel: `Mate ${source.name} to ${target.name}`,
        },
        confidence: 0.9,
      });

      return {
        toolCalls: calls,
        replyText: `已解析：${source.name}(${resolvedSourceFace}) -> ${target.name}(${resolvedTargetFace})，method=${resolvedSourceMethod}/${resolvedTargetMethod}，mode=${resolvedMode}${
          resolvedIntent ? `，intent=${resolvedIntent}` : ''
        }${twistDeg !== undefined
          ? `，twist=${twistDeg}°/${twistAxis}/${twistSpace}`
          : (resolvedMode === 'both' || resolvedMode === 'twist')
            ? `，twist=auto/normal/target_face`
            : ''}${inferredVia ? `，via=${inferredVia}` : ''}${inferredConfidence !== undefined ? `，conf=${inferredConfidence.toFixed(2)}` : ''}${
          inferredConsensus !== undefined ? `，cons=${inferredConsensus.toFixed(2)}` : ''
        }${
          vlmDiagSelection && vlmDiagSelection !== 'none' ? `，vsel=${vlmDiagSelection}` : ''
        }${
          vlmDiagFallback ? `，vfb=${vlmDiagProvider || 'provider'}` : ''
        }${
          vlmDiagFlags.length ? `，vdiag=${vlmDiagFlags.join('+')}` : ''
        }${
          vlmDiagSummaryZh.length ? `，診斷=${vlmDiagSummaryZh.join('/')}` : ''
        }${
          inferredArb.length ? `，arb=${inferredArb.join('+')}` : ''
        }。`,
      };
    }

    if (containsAny(lower, keywords.mode) || containsAny(lower, ['rotate', 'move', 'mate', 'select', '模式'])) {
      const mode = detectMode(lower, nlu);
      if (mode) {
        calls.push({
          tool: 'mode.set_interaction_mode',
          args: { mode, reason: 'chat_router' },
          confidence: 0.88,
        });
        return { toolCalls: calls, replyText: `已切換到 ${mode} 模式。` };
      }
    }

    if (containsAny(lower, keywords.select)) {
      const part = findPart(lower, ctx.parts);
      if (part) {
        calls.push({
          tool: 'selection.set',
          args: {
            selection: {
              kind: 'part',
              part: { partId: part.id },
            },
            replace: true,
            autoResolve: true,
          },
          confidence: 0.84,
        });
        return { toolCalls: calls, replyText: `已選取 ${part.name}。` };
      }

      const labels = ctx.parts.slice(0, 5).map((partItem) => partItem.name);
      return {
        toolCalls: [],
        replyText:
          labels.length > 0
            ? `我沒找到你要選的零件。可用零件包含：${labels.join('、')}${ctx.parts.length > 5 ? '…' : ''}`
            : '目前場景還沒有可選零件。',
      };
    }

    if (looksLikeGeneralQuestion(lower, keywords, nlu)) {
      const llmAnswer = await answerGeneralQuestionWithLlm(text, ctx);
      if (llmAnswer) {
        return {
          toolCalls: [],
          replyText: llmAnswer,
        };
      }
    }

    return {
      toolCalls: [],
      replyText: buildFallbackReply(ctx),
    };
  },
};
