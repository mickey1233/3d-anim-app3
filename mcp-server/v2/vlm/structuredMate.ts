import { VlmMateInferenceSchema } from '../../../shared/schema/vlm.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type VlmImage = { name: string; data: string; mime: string };
type VlmPart = { name: string };
type ProviderName = 'mock' | 'ollama' | 'gemini' | 'none';

type StructuredMateResult = {
  provider: ProviderName;
  mateInference?: any;
  repairAttempts: number;
  error?: string;
};

const DEFAULT_TIMEOUT_MS = Number(process.env.VLM_MATE_TIMEOUT_MS || 4000);
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.VLM_MATE_MODEL || process.env.OLLAMA_MODEL || 'qwen3.5:27b';
const GEMINI_MODEL = process.env.GEMINI_MODEL || process.env.VLM_MATE_MODEL || 'gemini-1.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const FACE_VALUES = new Set(['top', 'bottom', 'left', 'right', 'front', 'back']);
const METHOD_VALUES = new Set([
  'planar_cluster',
  'face_projection',
  'geometry_aabb',
  'object_aabb',
  'obb_pca',
  'picked',
]);
const MODE_VALUES = new Set(['translate', 'twist', 'both']);
const INTENT_VALUES = new Set(['default', 'cover', 'insert']);

let lastOllamaHealthCheckAt = 0;
let lastOllamaHealth = false;

function normalizeOllamaModelName(name: unknown) {
  if (typeof name !== 'string') return '';
  return name.trim().toLowerCase();
}

const DEFAULT_ASSEMBLY_GUIDE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'prompt',
  'ASSEMBLY.md'
);

let cachedAssemblyGuide: { path: string; mtimeMs: number; content: string } | null = null;

function loadAssemblyGuide() {
  const filePath = process.env.VLM_MATE_GUIDE_PATH || DEFAULT_ASSEMBLY_GUIDE_PATH;
  try {
    const stat = fs.statSync(filePath);
    const mtimeMs = stat.mtimeMs;
    if (cachedAssemblyGuide && cachedAssemblyGuide.path === filePath && cachedAssemblyGuide.mtimeMs === mtimeMs) {
      return cachedAssemblyGuide.content;
    }
    const content = fs.readFileSync(filePath, 'utf8').trim();
    cachedAssemblyGuide = { path: filePath, mtimeMs, content };
    return content;
  } catch {
    cachedAssemblyGuide = { path: filePath, mtimeMs: 0, content: '' };
    return '';
  }
}

function withTimeout(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeout };
}

async function checkOllamaReachable() {
  const now = Date.now();
  if (now - lastOllamaHealthCheckAt < 30_000) return lastOllamaHealth;
  lastOllamaHealthCheckAt = now;
  const { controller, timeout } = withTimeout(Math.min(DEFAULT_TIMEOUT_MS, 1000));
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: controller.signal });
    if (!res.ok) {
      lastOllamaHealth = false;
      return false;
    }
    await res.json().catch(() => null);
    lastOllamaHealth = true;
    return lastOllamaHealth;
  } catch {
    lastOllamaHealth = false;
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function extractJsonObject(raw: string) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function asObj(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' ? (value as Record<string, any>) : null;
}

function normalizeEnumString(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
}

function clamp01(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function trimString(value: unknown, max = 220) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function sanitizeMateInferenceAgainstContext(raw: unknown, mateContext: unknown, parts?: VlmPart[]) {
  const parsed = VlmMateInferenceSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.flatten(), value: null };
  }

  const value = { ...parsed.data } as any;
  const diagnosticsFlags = new Set<string>();
  const ctx = asObj(mateContext);
  const geometry = asObj(ctx?.geometry);
  const captureViews = Array.isArray(ctx?.captureViews) ? ctx?.captureViews.filter((v: any) => v && typeof v === 'object') : [];
  const candidates = Array.isArray(geometry?.candidates) ? geometry.candidates.filter((c: any) => c && typeof c === 'object') : [];
  const partsList = Array.isArray(parts) ? parts.filter((p) => p && typeof p.name === 'string') : [];
  const hadModelSelectedCandidate =
    typeof value.selected_candidate_index === 'number' || typeof value.selected_candidate_key === 'string';
  let candidateSelectionSource: 'model' | 'view_votes' | 'none' = hadModelSelectedCandidate ? 'model' : 'none';
  const partNameByNorm = new Map<string, string>();
  for (const part of partsList) {
    const key = String(part.name || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '');
    if (key) partNameByNorm.set(key, part.name);
  }

  const allowedCandidateIndexes = new Set<number>(
    candidates
      .map((candidate: any) => Number(candidate?.candidateIndex))
      .filter((n: number) => Number.isInteger(n))
  );
  const allowedCandidateKeys = new Set<string>(
    candidates
      .map((candidate: any) => (typeof candidate?.candidateKey === 'string' ? candidate.candidateKey : null))
      .filter(Boolean) as string[]
  );
  const allowedViewNames = new Set<string>(
    captureViews
      .map((view: any) => (typeof view?.name === 'string' ? view.name : null))
      .filter(Boolean) as string[]
  );
  const candidateByIndex = new Map<number, any>();
  const candidateByKey = new Map<string, any>();
  for (const candidate of candidates) {
    const idx = Number(candidate?.candidateIndex);
    const key = typeof candidate?.candidateKey === 'string' ? candidate.candidateKey : undefined;
    if (Number.isInteger(idx)) candidateByIndex.set(idx, candidate);
    if (key) candidateByKey.set(key, candidate);
  }
  const invalidEnums: string[] = [];
  const validateEnumField = (field: string, allowed: Set<string>) => {
    const normalized = normalizeEnumString(value[field]);
    if (!normalized) return;
    if ((field === 'source_method' || field === 'target_method') && (normalized === 'auto' || normalized === 'extreme_vertices')) {
      value[field] = 'planar_cluster';
      diagnosticsFlags.add('enum_normalized');
      return;
    }
    if (!allowed.has(normalized)) {
      invalidEnums.push(`${field}=${String(value[field])}`);
      return;
    }
    if (value[field] !== normalized) diagnosticsFlags.add('enum_normalized');
    value[field] = normalized;
  };
  const normalizePartRef = (ref: unknown) => {
    if (typeof ref !== 'string') return undefined;
    const rawText = ref.trim();
    if (!rawText) return undefined;
    const exact = partsList.find((part) => part.name === rawText)?.name;
    if (exact) return exact;
    const key = rawText.toLowerCase().replace(/\s+/g, '');
    return partNameByNorm.get(key) || rawText;
  };
  const syncSelectedCandidateFields = () => {
    const selectedIndex = typeof value.selected_candidate_index === 'number' ? value.selected_candidate_index : undefined;
    const selectedKey = typeof value.selected_candidate_key === 'string' ? value.selected_candidate_key : undefined;
    const fromIndex = selectedIndex !== undefined ? candidateByIndex.get(selectedIndex) : null;
    const fromKey = selectedKey ? candidateByKey.get(selectedKey) : null;

    if (fromIndex && !selectedKey && typeof fromIndex?.candidateKey === 'string') {
      value.selected_candidate_key = fromIndex.candidateKey;
      diagnosticsFlags.add('selected_candidate_synced');
    }
    if (fromKey && selectedIndex === undefined && Number.isInteger(Number(fromKey?.candidateIndex))) {
      value.selected_candidate_index = Number(fromKey.candidateIndex);
      diagnosticsFlags.add('selected_candidate_synced');
    }

    if (fromIndex && fromKey && fromIndex !== fromKey) {
      if (typeof fromIndex?.candidateKey === 'string') {
        value.selected_candidate_key = fromIndex.candidateKey;
        diagnosticsFlags.add('selected_candidate_conflict_resolved');
      } else if (Number.isInteger(Number(fromKey?.candidateIndex))) {
        value.selected_candidate_index = Number(fromKey.candidateIndex);
        diagnosticsFlags.add('selected_candidate_conflict_resolved');
      }
    }
  };
  const applyCandidateToMateFields = (candidate: any) => {
    if (!candidate || typeof candidate !== 'object') return;
    const candidatePairs: Array<[string, string]> = [
      ['source_face', 'sourceFace'],
      ['target_face', 'targetFace'],
      ['source_method', 'sourceMethod'],
      ['target_method', 'targetMethod'],
    ];
    for (const [dst, src] of candidatePairs) {
      const candidateValue = normalizeEnumString(candidate?.[src]);
      if (candidateValue && value[dst] !== candidateValue) {
        value[dst] = candidateValue;
        diagnosticsFlags.add('candidate_field_sync_applied');
      }
    }
  };

  if (
    typeof value.selected_candidate_index === 'number' &&
    !allowedCandidateIndexes.has(value.selected_candidate_index)
  ) {
    delete value.selected_candidate_index;
  }
  if (typeof value.selected_candidate_key === 'string' && !allowedCandidateKeys.has(value.selected_candidate_key)) {
    delete value.selected_candidate_key;
  }
  if (typeof value.candidate_index === 'number' && !allowedCandidateIndexes.has(value.candidate_index)) {
    delete value.candidate_index;
  }
  if (typeof value.candidate_key === 'string' && !allowedCandidateKeys.has(value.candidate_key)) {
    delete value.candidate_key;
  }

  const normalizedConfidence = clamp01(value.confidence);
  if (value.confidence !== normalizedConfidence && normalizedConfidence !== undefined) diagnosticsFlags.add('confidence_clamped');
  value.confidence = normalizedConfidence;
  const normalizedReason = trimString(value.reason, 300);
  if (typeof value.reason === 'string' && value.reason !== normalizedReason) diagnosticsFlags.add('reason_trimmed');
  value.reason = normalizedReason;
  const normalizedSourcePartRef = normalizePartRef(value.source_part_ref);
  const normalizedTargetPartRef = normalizePartRef(value.target_part_ref);
  if (value.source_part_ref !== normalizedSourcePartRef || value.target_part_ref !== normalizedTargetPartRef) {
    if (normalizedSourcePartRef || normalizedTargetPartRef) diagnosticsFlags.add('part_ref_normalized');
  }
  value.source_part_ref = normalizedSourcePartRef;
  value.target_part_ref = normalizedTargetPartRef;

  validateEnumField('source_face', FACE_VALUES);
  validateEnumField('target_face', FACE_VALUES);
  validateEnumField('source_method', METHOD_VALUES);
  validateEnumField('target_method', METHOD_VALUES);
  validateEnumField('mode', MODE_VALUES);
  validateEnumField('intent', INTENT_VALUES);

  if (Array.isArray(value.view_votes)) {
    const originalVoteCount = value.view_votes.length;
    value.view_votes = value.view_votes
      .filter((vote: any) => typeof vote?.view_name === 'string' && (!allowedViewNames.size || allowedViewNames.has(vote.view_name)))
      .map((vote: any) => {
        const next = { ...vote };
        if (typeof next.candidate_index === 'number' && !allowedCandidateIndexes.has(next.candidate_index)) {
          delete next.candidate_index;
          diagnosticsFlags.add('view_vote_candidate_dropped');
        }
        if (typeof next.candidate_key === 'string' && !allowedCandidateKeys.has(next.candidate_key)) {
          delete next.candidate_key;
          diagnosticsFlags.add('view_vote_candidate_dropped');
        }
        next.view_name = String(next.view_name).trim();
        const nextConfidence = clamp01(next.confidence);
        if (next.confidence !== nextConfidence && nextConfidence !== undefined) diagnosticsFlags.add('view_vote_confidence_clamped');
        next.confidence = nextConfidence;
        const nextReason = trimString(next.reason, 160);
        if (typeof next.reason === 'string' && next.reason !== nextReason) diagnosticsFlags.add('view_vote_reason_trimmed');
        next.reason = nextReason;
        return next;
      })
      .slice(0, 24);
    if (value.view_votes.length !== originalVoteCount) diagnosticsFlags.add('view_votes_filtered');
    const dedupedVotes: any[] = [];
    const seenViews = new Set<string>();
    for (const vote of value.view_votes) {
      if (!vote?.view_name || seenViews.has(vote.view_name)) continue;
      seenViews.add(vote.view_name);
      dedupedVotes.push(vote);
    }
    if (dedupedVotes.length !== value.view_votes.length) diagnosticsFlags.add('view_vote_deduped');
    value.view_votes = dedupedVotes;
  }

  if (Array.isArray(value.alternatives)) {
    value.alternatives = value.alternatives.map((candidate: any) => {
      const next = { ...candidate };
      const normalizeCandidateField = (field: string, allowed: Set<string>) => {
        const normalized = normalizeEnumString(next[field]);
        if (!normalized) return;
        if ((field === 'source_method' || field === 'target_method') && (normalized === 'auto' || normalized === 'extreme_vertices')) {
          next[field] = 'planar_cluster';
          diagnosticsFlags.add('enum_normalized');
          return;
        }
        if (allowed.has(normalized)) next[field] = normalized;
        else delete next[field];
      };
      normalizeCandidateField('source_face', FACE_VALUES);
      normalizeCandidateField('target_face', FACE_VALUES);
      normalizeCandidateField('source_method', METHOD_VALUES);
      normalizeCandidateField('target_method', METHOD_VALUES);
      normalizeCandidateField('mode', MODE_VALUES);
      normalizeCandidateField('intent', INTENT_VALUES);
      const altConfidence = clamp01(next.confidence);
      if (next.confidence !== altConfidence && altConfidence !== undefined) diagnosticsFlags.add('alt_confidence_clamped');
      next.confidence = altConfidence;
      next.reason = trimString(next.reason, 160);
      return next;
    }).slice(0, 6);
  }

  if (!value.source_part_ref && typeof ctx?.sourcePartName === 'string') value.source_part_ref = ctx.sourcePartName;
  if (!value.target_part_ref && typeof ctx?.targetPartName === 'string') value.target_part_ref = ctx.targetPartName;

  syncSelectedCandidateFields();

  if (
    (value.selected_candidate_index === undefined || !value.selected_candidate_key) &&
    Array.isArray(value.view_votes) &&
    value.view_votes.length
  ) {
    const weights = new Map<string, { weight: number; idx?: number; key?: string }>();
    for (const vote of value.view_votes) {
      const idx = typeof vote?.candidate_index === 'number' ? vote.candidate_index : undefined;
      const key = typeof vote?.candidate_key === 'string' ? vote.candidate_key : undefined;
      const normalizedKey = key || (idx !== undefined ? `idx:${idx}` : null);
      if (!normalizedKey) continue;
      const weight = typeof vote?.confidence === 'number' ? vote.confidence : 0.5;
      const current = weights.get(normalizedKey) || { weight: 0, idx, key };
      current.weight += weight;
      if (idx !== undefined) current.idx = idx;
      if (key) current.key = key;
      weights.set(normalizedKey, current);
    }
    const best = [...weights.values()].sort((a, b) => b.weight - a.weight)[0];
    if (best) {
      if (value.selected_candidate_index === undefined && typeof best.idx === 'number') {
        value.selected_candidate_index = best.idx;
        diagnosticsFlags.add('selected_candidate_derived_from_view_votes');
        candidateSelectionSource = 'view_votes';
      }
      if (!value.selected_candidate_key && typeof best.key === 'string') {
        value.selected_candidate_key = best.key;
        diagnosticsFlags.add('selected_candidate_derived_from_view_votes');
        if (candidateSelectionSource === 'none') candidateSelectionSource = 'view_votes';
      }
      syncSelectedCandidateFields();
    }
  }

  const selectedCandidate =
    (typeof value.selected_candidate_index === 'number' && candidateByIndex.get(value.selected_candidate_index)) ||
    (typeof value.selected_candidate_key === 'string' && candidateByKey.get(value.selected_candidate_key)) ||
    null;
  if (selectedCandidate) applyCandidateToMateFields(selectedCandidate);

  if (invalidEnums.length) {
    return {
      ok: false as const,
      error: { invalidEnums, message: 'invalid enum values in mate inference' },
      value: null,
    };
  }

  if (candidates.length) {
    const hasSelection =
      typeof value.selected_candidate_index === 'number' || typeof value.selected_candidate_key === 'string';
    const hasVoteCandidate = Array.isArray(value.view_votes)
      ? value.view_votes.some((vote: any) => typeof vote?.candidate_index === 'number' || typeof vote?.candidate_key === 'string')
      : false;
    if (!hasSelection && !hasVoteCandidate) {
      return {
        ok: false as const,
        error: { message: 'missing candidate selection', candidateCount: candidates.length },
        value: null,
      };
    }
  }

  const voteRows = Array.isArray(value.view_votes) ? value.view_votes : [];
  const voteTallies = new Map<string, { weight: number; votes: number; idx?: number; key?: string }>();
  for (const vote of voteRows) {
    const idx = typeof vote?.candidate_index === 'number' ? vote.candidate_index : undefined;
    const key = typeof vote?.candidate_key === 'string' ? vote.candidate_key : undefined;
    const bucketKey = key || (idx !== undefined ? `idx:${idx}` : null);
    if (!bucketKey) continue;
    const confidence = typeof vote?.confidence === 'number' ? vote.confidence : 0.5;
    const row = voteTallies.get(bucketKey) || { weight: 0, votes: 0, idx, key };
    row.weight += confidence;
    row.votes += 1;
    if (idx !== undefined) row.idx = idx;
    if (key) row.key = key;
    voteTallies.set(bucketKey, row);
  }
  const tallyRows = [...voteTallies.values()].sort((a, b) => b.weight - a.weight);
  const totalVoteWeight = tallyRows.reduce((sum, row) => sum + row.weight, 0);
  const topVote = tallyRows[0];
  const viewConsensus = topVote && totalVoteWeight > 1e-9 ? Math.max(0, Math.min(1, topVote.weight / totalVoteWeight)) : undefined;
  const viewAgreement = topVote && voteRows.length ? Math.max(0, Math.min(1, topVote.votes / voteRows.length)) : undefined;
  const selectedKeyForCompare =
    (typeof value.selected_candidate_key === 'string' && value.selected_candidate_key) ||
    (typeof value.selected_candidate_index === 'number' ? `idx:${value.selected_candidate_index}` : undefined);
  const consensusKeyForCompare = topVote?.key || (typeof topVote?.idx === 'number' ? `idx:${topVote.idx}` : undefined);
  if (voteTallies.size > 1 && (viewConsensus ?? 1) < 0.7) diagnosticsFlags.add('view_vote_conflict');
  if (voteRows.length === 0) diagnosticsFlags.add('view_votes_missing');
  if (voteRows.length > 0 && voteTallies.size <= 1) diagnosticsFlags.add('view_votes_consistent');

  value.diagnostics = {
    ...(asObj(value.diagnostics) || {}),
    view_vote_count: voteRows.length,
    candidate_vote_options: voteTallies.size,
    ...(viewConsensus !== undefined ? { view_consensus: Number(viewConsensus.toFixed(4)) } : {}),
    ...(viewAgreement !== undefined ? { view_agreement: Number(viewAgreement.toFixed(4)) } : {}),
    ...(typeof topVote?.idx === 'number' ? { consensus_candidate_index: topVote.idx } : {}),
    ...(typeof topVote?.key === 'string' ? { consensus_candidate_key: topVote.key } : {}),
    ...(selectedKeyForCompare && consensusKeyForCompare
      ? { selected_matches_consensus: selectedKeyForCompare === consensusKeyForCompare }
      : {}),
    candidate_selection_source: candidateSelectionSource,
    flags: [...diagnosticsFlags].sort(),
  };

  return { ok: true as const, value, error: null };
}

function buildMatePrompt(params: { images: VlmImage[]; parts: VlmPart[]; mateContext: unknown; mode: 'initial' | 'repair'; previousRaw?: string; validationError?: unknown }) {
  const { images, parts, mateContext, mode, previousRaw, validationError } = params;
  const ctx = asObj(mateContext);
  const geometry = asObj(ctx?.geometry);
  const explicitHints = asObj(ctx?.explicitHints);
  const sceneRelation = asObj(ctx?.sceneRelation);
  const captureFrame = asObj(ctx?.captureFrame);
  const candidates = Array.isArray(geometry?.candidates) ? geometry.candidates.slice(0, 8) : [];
  const views = Array.isArray(ctx?.captureViews) ? ctx.captureViews.slice(0, 12) : [];
  const compactViews = views.map((view: any) => ({
    name: String(view?.name || ''),
    label: String(view?.label || ''),
    cameraPose: Array.isArray(view?.cameraPose) ? view.cameraPose.slice(0, 7) : undefined,
  }));
  const compactCandidates = candidates.map((candidate: any) => ({
    idx: Number.isInteger(Number(candidate?.candidateIndex)) ? Number(candidate.candidateIndex) : undefined,
    key: typeof candidate?.candidateKey === 'string' ? candidate.candidateKey : undefined,
    sourceFace: candidate?.sourceFace,
    targetFace: candidate?.targetFace,
    sourceMethod: candidate?.sourceMethod,
    targetMethod: candidate?.targetMethod,
    score: typeof candidate?.score === 'number' ? Number(candidate.score.toFixed(4)) : candidate?.score,
    semanticScore: typeof candidate?.semanticScore === 'number' ? Number(candidate.semanticScore.toFixed(4)) : candidate?.semanticScore,
    tags: Array.isArray(candidate?.tags) ? candidate.tags.slice(0, 10) : [],
  }));

  const assemblyGuide = loadAssemblyGuide();

  const promptLines = [
    'Task: Infer structured CAD mate arguments from multi-view images + geometry candidates.',
    '',
    '=== PHASE 1: Semantic identification (required — output in "reasoning" field) ===',
    'Before selecting any candidate, answer these in 1-2 sentences in the "reasoning" field:',
    '  a) What does the SOURCE part appear to be? (e.g. "a small cap/connector/plug")',
    '  b) What does the TARGET part appear to be? (e.g. "a body/housing/base")',
    '  c) Which part covers/inserts into which, and along which axis?',
    '',
    '=== PHASE 2: Candidate selection ===',
    'You MUST choose from the provided geometry candidates when possible.',
    'Return JSON only. No markdown.',
    'After reasoning (Phase 1), select the candidate that matches your semantic assessment.',
    'CRITICAL: All Spark parts assemble along Y-axis — prefer bottom→top candidate unless impossible.',
    'IMPORTANT: Look for physical mating features (screws, pins, holes, tabs, slots, lips) on part faces to determine which faces should mate — do NOT rely solely on center-to-center offset direction. Parts placed side-by-side may still mate on top/bottom faces if one has screws/pins below and the other has holes/sockets above.',
    'Use candidate-ranking mode: select one candidate (or abstain) and keep face/method fields consistent with that candidate.',
    'Use multi-view voting: provide per-view votes for as many named views as possible, then choose selected_candidate from the strongest overall evidence.',
    'Face directions follow captureFrame axes (target-part local frame), not global world axes.',
    ...(assemblyGuide ? ['', 'Assembly guide (project-specific):', assemblyGuide] : []),
    '',
    'Output schema keys (all optional except confidence/reason if unsure):',
    '{',
    '  "selected_candidate_index": number,',
    '  "selected_candidate_key": string,',
    '  "source_part_ref": string,',
    '  "target_part_ref": string,',
    '  "source_face": "top|bottom|left|right|front|back",',
    '  "target_face": "top|bottom|left|right|front|back",',
    '  "source_method": "planar_cluster|face_projection|geometry_aabb|object_aabb|obb_pca|picked",',
    '  "target_method": "planar_cluster|face_projection|geometry_aabb|object_aabb|obb_pca|picked",',
    '  "mode": "translate|twist|both",',
    '  "intent": "default|cover|insert",',
    '  "abstain": boolean,',
    '  "confidence": number(0..1),',
    '  "reason": string,',
    '  "reasoning": string (Phase 1 semantic identification — describe each part and assembly axis),',
    '  "view_votes": [{ "view_name": string, "candidate_index": number?, "candidate_key": string?, "confidence": number?, "reason": string? }],',
    '  "alternatives": [same shape as candidate-level fields]',
    '}',
    '',
    'Hard constraints:',
    '- If candidates are provided, include selected_candidate_index or selected_candidate_key (unless abstain=true).',
    '- view_votes entries must use ONLY the provided view names.',
    '- candidate_index/candidate_key in top-level and view_votes must come from provided candidate list.',
    '- If selected candidate is idx=X, source_face/target_face/source_method/target_method should match that candidate.',
    '- Interpret top/bottom/left/right/front/back in captureFrame (pose-invariant), not camera/world drift.',
    '',
    `Images count: ${images.length}`,
    `Views: ${views.map((view: any) => `${String(view?.name || '?')} (${String(view?.label || '?')})`).join(', ') || 'unknown'}`,
    `View metadata JSON: ${JSON.stringify(compactViews)}`,
    `Scene parts: ${parts.map((part) => `'${part.name}'`).join(', ') || 'none'}`,
    `Source/Target hint: ${String(ctx?.sourcePartName || '?')} -> ${String(ctx?.targetPartName || '?')}`,
    `Instruction: ${String(ctx?.instruction || '')}`,
    `Explicit hints: ${JSON.stringify(explicitHints || {})}`,
    `Capture frame: ${JSON.stringify(captureFrame || {})}`,
    `Scene relation: ${JSON.stringify(sceneRelation || {})}`,
    `Geometry intent/mode hint: ${JSON.stringify({ intent: geometry?.intent, suggestedMode: geometry?.suggestedMode, expectedFromCenters: geometry?.expectedFromCenters })}`,
    `Source dominant face normals (world-space, by area): ${JSON.stringify(geometry?.sourceDominantFaces ?? [])}`,
    `Target dominant face normals (world-space, by area): ${JSON.stringify(geometry?.targetDominantFaces ?? [])}`,
    `Geometry candidates JSON: ${JSON.stringify(compactCandidates)}`,
    'Geometry candidates (choose one when possible):',
    ...candidates.map((candidate: any) =>
      `- idx=${candidate?.candidateIndex} key=${candidate?.candidateKey} face=${candidate?.sourceFace}->${candidate?.targetFace} method=${candidate?.sourceMethod}/${candidate?.targetMethod} score=${Number(candidate?.score ?? 0).toFixed?.(3) ?? candidate?.score} semantic=${Number(candidate?.semanticScore ?? 0).toFixed?.(3) ?? candidate?.semanticScore} tags=${Array.isArray(candidate?.tags) ? candidate.tags.join('|') : ''}`
    ),
  ];

  if (mode === 'repair') {
    promptLines.push(
      '',
      'Previous output failed schema/context validation. Return corrected JSON only.',
      `Validation error summary: ${JSON.stringify(validationError || {})}`,
      `Previous output: ${String(previousRaw || '').slice(0, 4000)}`
    );
  }

  return promptLines.join('\n');
}

async function callOllamaVlmJson(prompt: string, images: VlmImage[]) {
  if (!(await checkOllamaReachable())) return { ok: false as const, rawText: '', parsed: null, error: 'ollama_unreachable' };
  const { controller, timeout } = withTimeout(DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        format: 'json',
        options: { temperature: 0.1 },
        messages: [
          {
            role: 'system',
            content: 'You are a strict JSON visual assembly inference assistant. Output JSON only.',
          },
          {
            role: 'user',
            content: prompt,
            images: images.slice(0, 10).map((img) => img.data),
          },
        ],
      }),
    });
    if (!response.ok) return { ok: false as const, rawText: '', parsed: null, error: `ollama_http_${response.status}` };
    const payload = await response.json();
    const rawText = String(payload?.message?.content || '').trim();
    return { ok: true as const, rawText, parsed: extractJsonObject(rawText), error: undefined };
  } catch (error: any) {
    return { ok: false as const, rawText: '', parsed: null, error: error?.message || 'ollama_failed' };
  } finally {
    clearTimeout(timeout);
  }
}

async function callGeminiVlmJson(prompt: string, images: VlmImage[]) {
  if (!GEMINI_API_KEY) return { ok: false as const, rawText: '', parsed: null, error: 'gemini_key_missing' };
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const client = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = client.getGenerativeModel({ model: GEMINI_MODEL });
  const { controller, timeout } = withTimeout(DEFAULT_TIMEOUT_MS);
  try {
    const imageParts = images.slice(0, 10).map((img) => ({
      inlineData: { data: img.data, mimeType: img.mime || 'image/png' },
    }));
    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }, ...imageParts],
        } as any,
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
      signal: controller.signal as any,
    });
    const rawText = String(result.response.text() || '').trim();
    return { ok: true as const, rawText, parsed: extractJsonObject(rawText), error: undefined };
  } catch (error: any) {
    return { ok: false as const, rawText: '', parsed: null, error: error?.message || 'gemini_failed' };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveProviderChain(): Promise<{ providerSetting: string; providersToTry: ProviderName[] }> {
  const providerSetting = String(process.env.V2_VLM_PROVIDER || process.env.VLM_PROVIDER || 'auto')
    .trim()
    .toLowerCase();

  if (providerSetting === 'none' || providerSetting === 'off') {
    return { providerSetting, providersToTry: ['none'] };
  }

  if (providerSetting === 'mock') return { providerSetting, providersToTry: ['mock'] };
  if (providerSetting === 'ollama') return { providerSetting, providersToTry: ['ollama'] };
  if (providerSetting === 'gemini') return { providerSetting, providersToTry: ['gemini'] };

  // auto / unknown
  const providersToTry: ProviderName[] = [];
  if (GEMINI_API_KEY) providersToTry.push('gemini');
  if (await checkOllamaReachable()) providersToTry.push('ollama');
  providersToTry.push('mock');
  return { providerSetting: 'auto', providersToTry };
}

export async function inferStructuredMateWithVlm(images: VlmImage[], parts: VlmPart[], mateContext: unknown): Promise<StructuredMateResult> {
  const { providersToTry } = await resolveProviderChain();
  const fallbackProvider = providersToTry[0] || 'mock';
  if (!mateContext) return { provider: fallbackProvider, repairAttempts: 0 };

  let lastError: string | undefined;
  let lastProvider: ProviderName = fallbackProvider;
  let lastNonMockProvider: ProviderName | null = null;
  let lastRepairAttempts = 0;

  for (const provider of providersToTry) {
    lastProvider = provider;
    if (provider !== 'mock' && provider !== 'none') lastNonMockProvider = provider;
    if (provider === 'none') return { provider, repairAttempts: 0 };
    if (provider === 'mock') {
      if (lastNonMockProvider) {
        return {
          provider: lastNonMockProvider,
          repairAttempts: lastRepairAttempts,
          ...(lastError ? { error: lastError } : { error: 'fallback_to_mock' }),
        };
      }
      return { provider, repairAttempts: 0 };
    }

    const callProvider = provider === 'gemini' ? callGeminiVlmJson : callOllamaVlmJson;
    let previousRaw = '';
    let validationError: unknown = null;
    let providerCallFailed = false;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const prompt = buildMatePrompt({
        images,
        parts,
        mateContext,
        mode: attempt === 0 ? 'initial' : 'repair',
        previousRaw,
        validationError,
      });
      const response = await callProvider(prompt, images);
      if (!response.ok) {
        providerCallFailed = true;
        lastError = response.error || 'provider_call_failed';
        lastRepairAttempts = attempt;
        break;
      }
      previousRaw = response.rawText;
      const sanitized = sanitizeMateInferenceAgainstContext(response.parsed, mateContext, parts);
      if (sanitized.ok && sanitized.value) {
        return {
          provider,
          mateInference: sanitized.value,
          repairAttempts: attempt,
        };
      }
      validationError = sanitized.error;
      lastError = 'schema_validation_failed';
      lastRepairAttempts = attempt;
    }

    if (!providerCallFailed) {
      lastError = 'schema_repair_failed';
      lastRepairAttempts = 2;
    }
  }

  return {
    provider: lastProvider,
    repairAttempts: lastRepairAttempts,
    ...(lastError ? { error: lastError } : {}),
  };
}
