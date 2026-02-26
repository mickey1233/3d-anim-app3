/**
 * mateParamsInfer.ts — LLM-based mate parameter inference.
 *
 * Reads skill docs from agent-prompts/skills/ (mate-intent.md, mate-geometry.md,
 * mate-anchor-methods.md) and asks the LLM to decide:
 *   intent / mode / sourceFace / targetFace / sourceMethod / targetMethod / confidence
 *
 * Called from wsGateway.ts when frontend sends command='agent.infer_mate_params'.
 *
 * Env vars:
 *   AGENT_LLM_PROVIDER / AGENT_LLM_MODEL / GEMINI_API_KEY / etc. — same as agentLlm.ts
 *   MATE_PARAMS_MOCK_RESPONSE — JSON string, skips LLM call (for testing)
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { callAgentLlm } from './agentLlm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, '../../../../agent-prompts');

type FaceId = 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back';
type MateExecMode = 'translate' | 'twist' | 'both';
type AnchorMethodId =
  | 'auto'
  | 'planar_cluster'
  | 'geometry_aabb'
  | 'object_aabb'
  | 'extreme_vertices'
  | 'obb_pca'
  | 'picked';
type MateIntentKind = 'default' | 'cover' | 'insert' | 'twist_insert' | 'arc_cover';

export type MateParamsInferenceInput = {
  userText: string;
  sourcePart: { id: string; name: string };
  targetPart: { id: string; name: string };
  /** Optional geometry context computed by the frontend. */
  geometryHint?: {
    expectedFacePair?: { sourceFace: string; targetFace: string };
    sourceBboxSize?: [number, number, number];
    targetBboxSize?: [number, number, number];
    relativePosition?: { dx: number; dy: number; dz: number };
    topRankingPairs?: Array<{
      sourceFace: string;
      targetFace: string;
      sourceMethod: string;
      targetMethod: string;
      score: number;
      facingScore: number;
      approachScore: number;
      distanceScore: number;
    }>;
  };
};

export type MateParamsInferenceResult = {
  intent: MateIntentKind;
  mode: MateExecMode;
  sourceFace: FaceId;
  targetFace: FaceId;
  sourceMethod: AnchorMethodId;
  targetMethod: AnchorMethodId;
  confidence: number;
  reasoning?: string;
};

const VALID_FACES: FaceId[] = ['top', 'bottom', 'left', 'right', 'front', 'back'];
const VALID_MODES: MateExecMode[] = ['translate', 'twist', 'both'];
const VALID_METHODS: AnchorMethodId[] = [
  'auto', 'planar_cluster', 'geometry_aabb', 'object_aabb',
  'extreme_vertices', 'obb_pca', 'picked',
];
const VALID_INTENTS: MateIntentKind[] = ['default', 'cover', 'insert', 'twist_insert', 'arc_cover'];

let cachedSkillPrompt: string | null = null;

async function loadSkillPrompt(): Promise<string> {
  if (cachedSkillPrompt !== null) return cachedSkillPrompt;

  const readSkill = async (name: string) => {
    try {
      return await readFile(path.join(PROMPTS_DIR, 'skills', name), 'utf-8');
    } catch {
      console.warn(`[mateParamsInfer] Could not read skill: ${name}`);
      return '';
    }
  };

  const [mateIntentDoc, mateGeometryDoc, mateAnchorDoc] = await Promise.all([
    readSkill('mate-intent.md'),
    readSkill('mate-geometry.md'),
    readSkill('mate-anchor-methods.md'),
  ]);

  cachedSkillPrompt = [
    '# Mate Parameter Inference Agent\n',
    'You are a 3D CAD assembly expert. Given a user command, part names, and geometry context,',
    'determine the optimal assembly parameters.',
    '',
    'Output ONLY a single valid JSON object — no markdown, no extra text.',
    '',
    '## Required output schema',
    '```json',
    '{',
    '  "reasoning": "step-by-step reasoning in Traditional Chinese",',
    '  "intent": "insert | cover | default | twist_insert | arc_cover",',
    '  "mode": "translate | twist | both",',
    '  "sourceFace": "top | bottom | left | right | front | back",',
    '  "targetFace": "top | bottom | left | right | front | back",',
    '  "sourceMethod": "auto | planar_cluster | geometry_aabb | object_aabb | extreme_vertices | obb_pca | picked",',
    '  "targetMethod": "auto | planar_cluster | geometry_aabb | object_aabb | extreme_vertices | obb_pca | picked",',
    '  "confidence": 0.0',
    '}',
    '```',
    '',
    '---',
    mateIntentDoc,
    '---',
    mateGeometryDoc,
    '---',
    mateAnchorDoc,
  ]
    .filter(Boolean)
    .join('\n');

  return cachedSkillPrompt;
}

function buildUserMessage(input: MateParamsInferenceInput): string {
  const lines: string[] = [
    `User command: "${input.userText}"`,
    `Source part (moves): ${input.sourcePart.name} (id: ${input.sourcePart.id})`,
    `Target part (fixed): ${input.targetPart.name} (id: ${input.targetPart.id})`,
  ];

  if (input.geometryHint) {
    lines.push('', 'Geometry context (computed from live 3D scene):', JSON.stringify(input.geometryHint, null, 2));
  }

  lines.push(
    '',
    'Based on the user command, part names, and geometry above, determine the best assembly parameters.',
    'Output only the JSON object.'
  );

  return lines.join('\n');
}

function sanitizeResult(raw: unknown): MateParamsInferenceResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const intent = VALID_INTENTS.includes(obj.intent as MateIntentKind)
    ? (obj.intent as MateIntentKind)
    : 'default';
  const mode = VALID_MODES.includes(obj.mode as MateExecMode)
    ? (obj.mode as MateExecMode)
    : 'translate';
  const sourceFace = VALID_FACES.includes(obj.sourceFace as FaceId)
    ? (obj.sourceFace as FaceId)
    : 'bottom';
  const targetFace = VALID_FACES.includes(obj.targetFace as FaceId)
    ? (obj.targetFace as FaceId)
    : 'top';
  const sourceMethod = VALID_METHODS.includes(obj.sourceMethod as AnchorMethodId)
    ? (obj.sourceMethod as AnchorMethodId)
    : 'auto';
  const targetMethod = VALID_METHODS.includes(obj.targetMethod as AnchorMethodId)
    ? (obj.targetMethod as AnchorMethodId)
    : 'auto';
  const confidence =
    typeof obj.confidence === 'number' ? Math.min(1, Math.max(0, obj.confidence)) : 0.5;

  return {
    intent,
    mode,
    sourceFace,
    targetFace,
    sourceMethod,
    targetMethod,
    confidence,
    ...(typeof obj.reasoning === 'string' ? { reasoning: obj.reasoning.slice(0, 800) } : {}),
  };
}

export async function inferMateParams(
  input: MateParamsInferenceInput
): Promise<MateParamsInferenceResult | null> {
  // Mock mode for testing.
  const mockEnv = process.env.MATE_PARAMS_MOCK_RESPONSE;
  if (mockEnv) {
    try {
      return sanitizeResult(JSON.parse(mockEnv));
    } catch {
      return null;
    }
  }

  const systemPrompt = await loadSkillPrompt();
  const userMessage = buildUserMessage(input);

  // callAgentLlm expects { replyText, toolCalls } output — we hijack this by embedding
  // the JSON in replyText and ignoring toolCalls. To avoid schema mismatch, we parse
  // the raw LLM response ourselves via a thin wrapper.
  const raw = await callAgentLlmRaw(systemPrompt, userMessage);
  if (!raw) return null;

  return sanitizeResult(raw);
}

/** Calls the LLM for raw JSON output (not the agent router schema). */
async function callAgentLlmRaw(systemPrompt: string, userMessage: string): Promise<unknown> {
  // Re-use callAgentLlm but extract the first tool call args or parse replyText as JSON.
  const PROVIDER = (process.env.AGENT_LLM_PROVIDER || 'gemini').toLowerCase();
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
  const GEMINI_MODEL = process.env.AGENT_LLM_MODEL || 'gemini-1.5-flash';
  const TIMEOUT_MS = Number(process.env.AGENT_LLM_TIMEOUT_MS || 8000);
  const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const OLLAMA_MODEL = process.env.AGENT_LLM_MODEL || 'llama3.2';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    if (PROVIDER === 'gemini') {
      if (!GEMINI_API_KEY) return null;
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const client = new GoogleGenerativeAI(GEMINI_API_KEY);
      const model = client.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: systemPrompt });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
      } as any);
      const text = result.response.text().trim();
      return parseJsonSafe(text);
    }

    if (PROVIDER === 'ollama') {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          system: systemPrompt,
          prompt: userMessage,
          stream: false,
          format: 'json',
          options: { temperature: 0.1 },
        }),
        signal: controller.signal as any,
      });
      if (!response.ok) return null;
      const data = await response.json();
      return parseJsonSafe(typeof data.response === 'string' ? data.response : JSON.stringify(data));
    }

    if (PROVIDER === 'claude') {
      const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
      if (!ANTHROPIC_API_KEY) return null;
      // @ts-ignore — optional peer dependency
      const { Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
      const msg = await client.messages.create({
        model: process.env.AGENT_LLM_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });
      const text = msg.content?.[0]?.type === 'text' ? msg.content[0].text : '';
      return parseJsonSafe(text);
    }

    if (PROVIDER === 'openai') {
      const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
      if (!OPENAI_API_KEY) return null;
      // @ts-ignore — optional peer dependency
      const { OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: OPENAI_API_KEY });
      const completion = await client.chat.completions.create({
        model: process.env.AGENT_LLM_MODEL || 'gpt-4o-mini',
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      });
      const text = completion.choices?.[0]?.message?.content || '';
      return parseJsonSafe(text);
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonSafe(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text.trim());
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { /* */ }
    }
    return null;
  }
}

/** Clear cache (for hot-reload / testing). */
export function clearMateParamsCache(): void {
  cachedSkillPrompt = null;
}
