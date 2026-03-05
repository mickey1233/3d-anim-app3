import type { VlmResult } from '../../../shared/schema/index.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const asObj = (value: unknown): Record<string, any> | null =>
  value && typeof value === 'object' ? (value as Record<string, any>) : null;

type MockPatternPolicy = {
  intent?: { cover?: unknown; insert?: unknown };
  mode?: { both?: unknown; twist?: unknown; translate?: unknown };
};

type MockPatternSets = {
  intent: { cover: string[]; insert: string[] };
  mode: { both: string[]; twist: string[]; translate: string[] };
};

const DEFAULT_PATTERN_POLICY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'policy',
  'mockPatterns.json'
);

const normalizeText = (text: string) =>
  String(text || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeTokenList = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => normalizeText(item))
    .filter(Boolean);
};

const EMPTY_PATTERNS: MockPatternSets = {
  intent: { cover: [], insert: [] },
  mode: { both: [], twist: [], translate: [] },
};

let cachedPatterns: { path: string; mtimeMs: number; sets: MockPatternSets } | null = null;

function getMockPatterns(): MockPatternSets {
  const policyPath = process.env.V2_VLM_MOCK_PATTERNS_PATH || DEFAULT_PATTERN_POLICY_PATH;
  try {
    const stat = fs.statSync(policyPath);
    const mtimeMs = stat.mtimeMs;
    if (cachedPatterns && cachedPatterns.path === policyPath && cachedPatterns.mtimeMs === mtimeMs) {
      return cachedPatterns.sets;
    }
    const raw = fs.readFileSync(policyPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const policy = parsed && typeof parsed === 'object' ? (parsed as MockPatternPolicy) : null;
    const sets: MockPatternSets = {
      intent: {
        cover: normalizeTokenList(policy?.intent?.cover),
        insert: normalizeTokenList(policy?.intent?.insert),
      },
      mode: {
        both: normalizeTokenList(policy?.mode?.both),
        twist: normalizeTokenList(policy?.mode?.twist),
        translate: normalizeTokenList(policy?.mode?.translate),
      },
    };
    cachedPatterns = { path: policyPath, mtimeMs, sets };
    return sets;
  } catch {
    cachedPatterns = { path: policyPath, mtimeMs: 0, sets: EMPTY_PATTERNS };
    return EMPTY_PATTERNS;
  }
}

const matchesAny = (text: string, tokens: string[]) => tokens.some((token) => token && text.includes(token));

const inferIntentFromInstruction = (instruction: string) => {
  const patterns = getMockPatterns();
  const text = normalizeText(instruction);
  if (matchesAny(text, patterns.intent.cover)) return 'cover';
  if (matchesAny(text, patterns.intent.insert)) return 'insert';
  return 'default';
};

const inferModeFromInstruction = (instruction: string, fallback: string) => {
  const patterns = getMockPatterns();
  const text = normalizeText(instruction);
  if (matchesAny(text, patterns.mode.both)) return 'both';
  if (matchesAny(text, patterns.mode.twist)) return 'twist';
  if (matchesAny(text, patterns.mode.translate)) return 'translate';
  return fallback || 'translate';
};

const pickCandidate = (mateContext: Record<string, any> | null, instruction: string) => {
  const geometry = asObj(mateContext?.geometry);
  const candidates = Array.isArray(geometry?.candidates) ? geometry.candidates.filter((c) => c && typeof c === 'object') : [];
  if (!candidates.length) return null;
  const patterns = getMockPatterns();
  const lower = normalizeText(instruction);
  const isCover = matchesAny(lower, patterns.intent.cover);
  const isInsert = matchesAny(lower, patterns.intent.insert);
  const sceneRelation = asObj(mateContext?.sceneRelation);
  const sourceCenter = Array.isArray(sceneRelation?.sourceCenter) ? sceneRelation.sourceCenter : null;
  const targetCenter = Array.isArray(sceneRelation?.targetCenter) ? sceneRelation.targetCenter : null;
  const sourceAboveTarget =
    sourceCenter && targetCenter
      ? Number(sourceCenter[1] ?? 0) > Number(targetCenter[1] ?? 0) + 0.05
      : false;
  const sourceBelowTarget =
    sourceCenter && targetCenter
      ? Number(sourceCenter[1] ?? 0) < Number(targetCenter[1] ?? 0) - 0.05
      : false;
  const sorted = [...candidates].sort((a: any, b: any) => {
    const sa = Number(a.semanticScore ?? a.score ?? 0);
    const sb = Number(b.semanticScore ?? b.score ?? 0);
    return sb - sa;
  });
  if (isCover) {
    const preferred = sorted.find((c: any) => c.tags?.includes?.('vertical_pair') || c.tags?.includes?.('cover_friendly'));
    if (preferred) return preferred;
  }
  if (isInsert) {
    const verticalPreferred = sorted.find((c: any) => {
      const tags = Array.isArray(c?.tags) ? c.tags : [];
      if (!tags.includes('insert_friendly') || !tags.includes('vertical_pair')) return false;
      if (sourceAboveTarget) return tags.includes('bottom_to_top') || tags.includes('insert_downward_pair');
      if (sourceBelowTarget) return tags.includes('top_to_bottom');
      return true;
    });
    if (verticalPreferred) return verticalPreferred;
    const preferred = sorted.find((c: any) => c.tags?.includes?.('insert_friendly'));
    if (preferred) return preferred;
  }
  return sorted[0] ?? null;
};

const buildViewVotes = (params: {
  mateContext: Record<string, any> | null;
  instruction: string;
  pickedCandidate: any;
}) => {
  const geometry = asObj(params.mateContext?.geometry);
  const captureViews = Array.isArray(params.mateContext?.captureViews)
    ? params.mateContext?.captureViews.filter((v: any) => v && typeof v === 'object')
    : [];
  const candidates = Array.isArray(geometry?.candidates)
    ? geometry.candidates.filter((c: any) => c && typeof c === 'object')
    : [];
  if (!captureViews.length || !params.pickedCandidate) return [];

  const patterns = getMockPatterns();
  const lower = normalizeText(params.instruction);
  const isCover = matchesAny(lower, patterns.intent.cover);
  const isInsert = matchesAny(lower, patterns.intent.insert);
  const lateralCandidate =
    candidates.find((c: any) => c.tags?.includes?.('lateral_pair')) ||
    candidates.find((c: any) => c.tags?.includes?.('insert_friendly') === false && c.tags?.includes?.('vertical_pair') !== true) ||
    null;

  return captureViews.map((view: any) => {
    const viewName = typeof view.name === 'string' ? view.name : 'view';
    const prefersDrift =
      isCover &&
      (viewName.includes('right') || viewName.includes('front')) &&
      lateralCandidate &&
      lateralCandidate.candidateKey !== params.pickedCandidate.candidateKey;
    const insertSideAmbiguity =
      isInsert &&
      (viewName.includes('right') || viewName.includes('front')) &&
      lateralCandidate &&
      lateralCandidate.candidateKey !== params.pickedCandidate.candidateKey;
    const voteCandidate = prefersDrift || insertSideAmbiguity ? lateralCandidate : params.pickedCandidate;
    const confidence =
      prefersDrift
        ? 0.46
        : insertSideAmbiguity
        ? 0.49
        : viewName.includes('top')
        ? 0.88
        : viewName.includes('source_to_target') || viewName.includes('target_to_source')
        ? 0.84
        : 0.72;
    return {
      view_name: viewName,
      candidate_index:
        Number.isInteger(Number(voteCandidate?.candidateIndex)) ? Number(voteCandidate.candidateIndex) : undefined,
      candidate_key: typeof voteCandidate?.candidateKey === 'string' ? voteCandidate.candidateKey : undefined,
      confidence,
      reason: prefersDrift || insertSideAmbiguity ? 'side-view occlusion ambiguity' : 'view supports selected candidate',
    };
  });
};

export async function mockAnalyze(
  images: { name: string }[],
  parts: { name: string }[],
  options?: { mateContext?: unknown }
): Promise<VlmResult> {
  const steps =
    images.length > 1
      ? images.slice(0, -1).map((img, i) => {
          const next = images[i + 1] ?? img;
          return {
          from_image: img.name,
          to_image: next.name,
          changes: ['object moved'],
          inferred_action: 'align object',
        };
        })
      : [];

  const objects = parts.slice(0, 2).map((p: { name: string }) => ({
    label: p.name.toLowerCase().includes('cap') ? 'cap' : p.name,
    description: `Mock object for ${p.name}`,
    confidence: 0.6,
  }));

  const mapping_candidates = objects.map((o: { label: string }) => ({
    label: o.label,
    scene_part_names: parts.map((p: { name: string }) => p.name),
    chosen: parts[0]?.name ?? '',
    confidence: 0.5,
  }));

  const first = parts[0];
  const second = parts[1];
  const assembly_command =
    first && second
      ? {
          source_label: first.name,
          target_label: second.name,
          source_face: 'bottom',
          target_face: 'top',
          mcp_text_command: `move ${first.name} bottom to ${second.name} top`,
        }
      : undefined;

  const mateContext = asObj(options?.mateContext);
  const geometry = asObj(mateContext?.geometry);
  const rankingTop = asObj(geometry?.rankingTop);
  const expectedFromCenters = asObj(geometry?.expectedFromCenters);
  const instruction = typeof mateContext?.instruction === 'string' ? mateContext.instruction : '';
  const sourcePartName = typeof mateContext?.sourcePartName === 'string' ? mateContext.sourcePartName : first?.name;
  const targetPartName = typeof mateContext?.targetPartName === 'string' ? mateContext.targetPartName : second?.name;
  const pickedCandidate = pickCandidate(mateContext, instruction);
  const intent = inferIntentFromInstruction(instruction);
  const mode = inferModeFromInstruction(instruction, String(geometry?.suggestedMode || 'translate'));
  const source_face =
    (typeof pickedCandidate?.sourceFace === 'string' && pickedCandidate.sourceFace) ||
    (typeof rankingTop?.sourceFace === 'string' && rankingTop.sourceFace) ||
    (typeof expectedFromCenters?.sourceFace === 'string' && expectedFromCenters.sourceFace) ||
    'bottom';
  const target_face =
    (typeof pickedCandidate?.targetFace === 'string' && pickedCandidate.targetFace) ||
    (typeof rankingTop?.targetFace === 'string' && rankingTop.targetFace) ||
    (typeof expectedFromCenters?.targetFace === 'string' && expectedFromCenters.targetFace) ||
    'top';
  const source_method =
    (typeof pickedCandidate?.sourceMethod === 'string' && pickedCandidate.sourceMethod) ||
    (typeof rankingTop?.sourceMethod === 'string' && rankingTop.sourceMethod) || 'auto';
  const target_method =
    (typeof pickedCandidate?.targetMethod === 'string' && pickedCandidate.targetMethod) ||
    (typeof rankingTop?.targetMethod === 'string' && rankingTop.targetMethod) || 'auto';
  const mate_inference =
    sourcePartName && targetPartName
      ? {
          view_votes: buildViewVotes({ mateContext, instruction, pickedCandidate }),
          selected_candidate_index:
            Number.isInteger(Number(pickedCandidate?.candidateIndex)) ? Number(pickedCandidate.candidateIndex) : undefined,
          selected_candidate_key: typeof pickedCandidate?.candidateKey === 'string' ? pickedCandidate.candidateKey : undefined,
          source_part_ref: sourcePartName,
          target_part_ref: targetPartName,
          source_face,
          target_face,
          source_method,
          target_method,
          mode,
          intent,
          confidence: 0.74,
          reason: 'mock_vlm: multi-view + geometry candidate assisted guess',
          alternatives: [
            {
              candidate_index:
                Number.isInteger(Number(pickedCandidate?.candidateIndex)) ? Number(pickedCandidate.candidateIndex) : undefined,
              source_part_ref: sourcePartName,
              target_part_ref: targetPartName,
              source_face:
                (typeof expectedFromCenters?.sourceFace === 'string' && expectedFromCenters.sourceFace) || source_face,
              target_face:
                (typeof expectedFromCenters?.targetFace === 'string' && expectedFromCenters.targetFace) || target_face,
              mode: String(geometry?.suggestedMode || 'translate'),
              intent: String(geometry?.intent || 'default'),
              confidence: 0.58,
              reason: 'geometry-default fallback',
            },
          ],
        }
      : undefined;

  return { steps, objects, mapping_candidates, assembly_command, mate_inference };
}
