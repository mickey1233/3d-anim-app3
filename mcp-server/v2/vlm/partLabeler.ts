/**
 * partLabeler.ts — VLM-based part semantic labeling (server-side).
 *
 * Given a part name, geometry summary, and optional render views,
 * produces a structured semantic label for the part.
 *
 * Used to populate PartSemanticCard.vlmCategory, vlmAliases, etc.
 * Results are intended to be cached by the frontend registry.
 *
 * Failure-safe: returns null on any error.
 */
import type { PartSemanticCard } from '../../../shared/schema/groundingTypes.js';
import { callAgentLlm } from '../router/agentLlm.js';

const TIMEOUT_MS = Number(process.env.PART_LABELER_TIMEOUT_MS || 8000);

const VALID_CATEGORIES = [
  'fan', 'board', 'pcb', 'bracket', 'cover', 'lid', 'screw', 'bolt',
  'chassis', 'housing', 'connector', 'module', 'panel', 'tray',
  'heatsink', 'cable', 'button', 'sensor', 'mount', 'frame', 'unknown',
] as const;

type PartLabelResult = {
  category: string;
  roles: string[];
  aliases: string[];
  description: string;
  confidence: number;
};

const SYSTEM_PROMPT = `# Part Semantic Labeling Agent

You are a mechanical engineering expert. Given a CAD part name and geometry summary, produce a structured semantic label.

Output ONLY a single valid JSON object — no markdown, no explanation.

## Output schema:
{
  "category": "fan|board|pcb|bracket|cover|lid|screw|bolt|chassis|housing|connector|module|panel|tray|heatsink|cable|button|sensor|mount|frame|unknown",
  "roles": ["cooling", "structural", "mounting_target"],
  "aliases": ["fan", "cooling fan", "blower", "風扇", "冷卻風扇"],
  "description": "A square cooling fan module with 4 corner mounting holes",
  "confidence": 0.85
}

Rules:
- category: single best category
- roles: 1-4 functional roles
- aliases: 3-8 terms a user might call this part (include Chinese if relevant)
- description: 1 sentence, 10-20 words, visual + functional
- confidence: 0.0-1.0 (lower if part name is cryptic or geometry is minimal)
- Do NOT make up specific details you cannot infer
- If part name is like "mesh_001" or random, category = "unknown", confidence < 0.4`;

function parseJsonSafe(text: string): unknown {
  if (!text) return null;
  try { return JSON.parse(text.trim()); } catch { /* */ }
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(text.slice(s, e + 1)); } catch { /* */ }
  }
  return null;
}

function sanitize(raw: unknown): PartLabelResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const category = typeof o.category === 'string' && (VALID_CATEGORIES as readonly string[]).includes(o.category)
    ? o.category : 'unknown';
  const roles = Array.isArray(o.roles) ? (o.roles as unknown[]).filter(r => typeof r === 'string').slice(0, 6) as string[] : [];
  const aliases = Array.isArray(o.aliases) ? (o.aliases as unknown[]).filter(a => typeof a === 'string').slice(0, 10) as string[] : [];
  const description = typeof o.description === 'string' ? o.description.slice(0, 200) : '';
  const confidence = typeof o.confidence === 'number' ? Math.max(0, Math.min(1, o.confidence)) : 0.5;
  return { category, roles, aliases, description, confidence };
}

export async function labelPart(params: {
  partName: string;
  geometrySummary?: { bboxSize?: [number, number, number]; featureTypes?: string[]; featureCount?: number };
}): Promise<Pick<PartSemanticCard, 'vlmCategory' | 'vlmAliases' | 'vlmDescription' | 'vlmRoles' | 'confidence'> | null> {
  const PROVIDER = (process.env.AGENT_LLM_PROVIDER || 'gemini').toLowerCase();
  if (PROVIDER === 'none') return null;

  const geoStr = params.geometrySummary
    ? `Bounding box: ${params.geometrySummary.bboxSize?.map(v => v.toFixed(1)).join(' × ') ?? 'unknown'} units. Features: ${params.geometrySummary.featureTypes?.join(', ') ?? 'none detected'}.`
    : 'No geometry info available.';

  const userMsg = [
    `Part name: "${params.partName}"`,
    `Geometry: ${geoStr}`,
    '',
    'Classify this part. Output JSON only.',
  ].join('\n');

  const timer = setTimeout(() => { /* signal used externally */ }, TIMEOUT_MS);
  try {
    const result = await callAgentLlm(SYSTEM_PROMPT, userMsg);
    if (!result?.replyText) return null;
    const parsed = sanitize(parseJsonSafe(result.replyText));
    if (!parsed) return null;
    return {
      vlmCategory: parsed.category,
      vlmAliases: parsed.aliases,
      vlmDescription: parsed.description,
      vlmRoles: parsed.roles,
      confidence: parsed.confidence,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
