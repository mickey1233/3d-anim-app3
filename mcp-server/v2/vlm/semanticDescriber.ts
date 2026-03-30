/**
 * semanticDescriber.ts — VLM semantic description layer (Layer 1 of 3).
 *
 * Produces AssemblySemanticDescription from part names + geometry hints.
 * This is a DESCRIPTION layer only — it does NOT produce transforms.
 *
 * Failure-safe: returns null when VLM is unavailable or times out.
 * Runs BEFORE solver selection.
 */
import type { AssemblySemanticDescription, SolverFamily } from '../../../shared/schema/assemblySemanticTypes.js';
import { callAgentLlm } from '../router/agentLlm.js';

const TIMEOUT_MS = Number(process.env.SEMANTIC_DESCRIBER_TIMEOUT_MS || 6000);

const VALID_ROLES = [
  'cap','lid','cover','plug','connector',
  'body','housing','base','chassis','frame','rack','socket',
  'bracket','panel','tray','mount','unknown',
] as const;
const VALID_INTENTS = ['insert','cover','mount','slide','screw','snap','default'] as const;
const VALID_SOLVERS: SolverFamily[] = ['plane_align','peg_hole','pattern_align','slot_insert','rim_align','rail_slide'];

const SYSTEM_PROMPT = `# Assembly Semantic Description Agent

You are a mechanical assembly expert. Given part names and optional geometry context,
produce a structured semantic description of the assembly situation.

Output ONLY a single valid JSON object — no markdown, no explanation outside JSON.

## Output schema:
{
  "sourceRole": "cap|lid|cover|plug|connector|body|housing|base|chassis|frame|rack|socket|bracket|panel|tray|mount|unknown",
  "targetRole": "same options as sourceRole",
  "assemblyIntent": "insert|cover|mount|slide|screw|snap|default",
  "relationship": "one sentence, e.g. fan mounts onto side panel",
  "likelyContactRegions": ["bottom", "top"],
  "likelyApproachDirection": "top",
  "preferredSolverHints": ["plane_align", "pattern_align"],
  "reasoning": "step-by-step reasoning in 2-3 sentences",
  "confidence": 0.75
}

Valid preferredSolverHints: plane_align, peg_hole, pattern_align, slot_insert, rim_align, rail_slide`;

function parseJsonSafe(text: string): unknown {
  if (!text) return null;
  try { return JSON.parse(text.trim()); } catch { /* */ }
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(text.slice(s, e + 1)); } catch { /* */ }
  }
  return null;
}

function sanitize(raw: unknown): AssemblySemanticDescription | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const sourceRole = (VALID_ROLES as readonly string[]).includes(o.sourceRole as string)
    ? o.sourceRole as AssemblySemanticDescription['sourceRole'] : 'unknown';
  const targetRole = (VALID_ROLES as readonly string[]).includes(o.targetRole as string)
    ? o.targetRole as AssemblySemanticDescription['targetRole'] : 'unknown';
  const assemblyIntent = (VALID_INTENTS as readonly string[]).includes(o.assemblyIntent as string)
    ? o.assemblyIntent as AssemblySemanticDescription['assemblyIntent'] : 'default';
  const relationship = typeof o.relationship === 'string' ? o.relationship.slice(0, 200) : `${sourceRole} assembles with ${targetRole}`;
  const likelyContactRegions = Array.isArray(o.likelyContactRegions)
    ? (o.likelyContactRegions as unknown[]).filter(r => typeof r === 'string').slice(0, 4) as string[]
    : [];
  const likelyApproachDirection = typeof o.likelyApproachDirection === 'string' ? o.likelyApproachDirection.slice(0, 50) : 'top';
  const preferredSolverHints = Array.isArray(o.preferredSolverHints)
    ? (o.preferredSolverHints as unknown[]).filter(s => VALID_SOLVERS.includes(s as SolverFamily)) as SolverFamily[]
    : [];
  const reasoning = typeof o.reasoning === 'string' ? o.reasoning.slice(0, 600) : '';
  const confidence = typeof o.confidence === 'number' ? Math.max(0, Math.min(1, o.confidence)) : 0.5;
  return { sourceRole, targetRole, assemblyIntent, relationship, likelyContactRegions, likelyApproachDirection, preferredSolverHints, reasoning, confidence };
}

export async function describeAssemblySemantics(params: {
  sourceName: string;
  targetName: string;
  geometryHint?: object;
}): Promise<AssemblySemanticDescription | null> {
  const PROVIDER = (process.env.AGENT_LLM_PROVIDER || 'gemini').toLowerCase();
  if (PROVIDER === 'none') return null;

  const userMsg = [
    `Source part (moves): ${params.sourceName}`,
    `Target part (stays): ${params.targetName}`,
    ...(params.geometryHint ? ['', 'Geometry context:', JSON.stringify(params.geometryHint, null, 2)] : []),
    '',
    'Describe the assembly semantics. Output JSON only.',
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const result = await callAgentLlm(SYSTEM_PROMPT, userMsg);
    if (!result?.replyText) return null;
    return sanitize(parseJsonSafe(result.replyText));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
