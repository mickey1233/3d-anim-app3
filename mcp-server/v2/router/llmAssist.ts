import type { RouterContext } from './types.js';

type LlmProvider = 'auto' | 'ollama' | 'gemini';
type FaceId = 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back';
type MateMode = 'translate' | 'twist' | 'both';
type AnchorMethodId =
  | 'planar_cluster'
  | 'geometry_aabb'
  | 'object_aabb'
  | 'obb_pca'
  | 'picked';

type MateInference = {
  sourcePartId: string;
  targetPartId: string;
  sourceFace?: FaceId;
  targetFace?: FaceId;
  sourceMethod?: AnchorMethodId;
  targetMethod?: AnchorMethodId;
  mode?: MateMode;
  confidence?: number;
  reason?: string;
};

const FACE_IDS: FaceId[] = ['top', 'bottom', 'left', 'right', 'front', 'back'];
const METHOD_IDS: AnchorMethodId[] = [
  'planar_cluster',
  'geometry_aabb',
  'object_aabb',
  'obb_pca',
  'picked',
];
const MODE_IDS: MateMode[] = ['translate', 'twist', 'both'];

const DEFAULT_TIMEOUT_MS = Number(process.env.ROUTER_LLM_TIMEOUT_MS || 2200);
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.ROUTER_LLM_MODEL || process.env.OLLAMA_MODEL || 'qwen3:30b';
const GEMINI_MODEL = process.env.GEMINI_MODEL || process.env.ROUTER_LLM_MODEL || 'gemini-1.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

let lastOllamaHealthCheckAt = 0;
let lastOllamaHealth = false;

function normalizeOllamaModelName(name: unknown) {
  if (typeof name !== 'string') return '';
  return name.trim().toLowerCase();
}

function isOllamaModelAvailable(model: string, tags: string[]) {
  const requested = normalizeOllamaModelName(model);
  if (!requested) return false;
  const normalizedTags = tags.map(normalizeOllamaModelName).filter(Boolean);
  if (requested.includes(':')) return normalizedTags.includes(requested);
  return normalizedTags.some((name) => name === requested || name.startsWith(`${requested}:`));
}

const normalizeText = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeToken = (text: string) =>
  normalizeText(text).replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');

function withTimeout(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeout };
}

async function checkOllamaReachable() {
  const now = Date.now();
  if (now - lastOllamaHealthCheckAt < 30_000) return lastOllamaHealth;
  lastOllamaHealthCheckAt = now;
  const { controller, timeout } = withTimeout(Math.min(DEFAULT_TIMEOUT_MS, 900));
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: controller.signal });
    if (!res.ok) {
      lastOllamaHealth = false;
      return false;
    }
    const payload = await res.json().catch(() => null);
    const names = Array.isArray(payload?.models)
      ? (payload.models as any[])
          .map((model: any) => (typeof model?.name === 'string' ? model.name : null))
          .filter(Boolean)
      : [];
    lastOllamaHealth = isOllamaModelAvailable(OLLAMA_MODEL, names);
    return lastOllamaHealth;
  } catch {
    lastOllamaHealth = false;
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function extractJsonObject(raw: string) {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const slice = text.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function callOllamaJson(prompt: string) {
  if (!(await checkOllamaReachable())) return null;
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
        options: { temperature: 0.15 },
        messages: [
          { role: 'system', content: 'You are a strict JSON routing assistant. Output JSON only.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const content = String(payload?.message?.content || '').trim();
    if (!content) return null;
    return extractJsonObject(content);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function callGeminiJson(prompt: string) {
  if (!GEMINI_API_KEY) return null;
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const client = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = client.getGenerativeModel({ model: GEMINI_MODEL });
  const { controller, timeout } = withTimeout(DEFAULT_TIMEOUT_MS);
  try {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.15,
        responseMimeType: 'application/json',
      },
      signal: controller.signal as any,
    });
    const text = result.response.text();
    if (!text) return null;
    return extractJsonObject(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function callLlmJson(prompt: string) {
  const provider = (process.env.ROUTER_LLM_PROVIDER || 'auto') as LlmProvider;
  if (provider === 'ollama') return callOllamaJson(prompt);
  if (provider === 'gemini') return callGeminiJson(prompt);
  if (GEMINI_API_KEY) {
    const gemini = await callGeminiJson(prompt);
    if (gemini) return gemini;
  }
  return callOllamaJson(prompt);
}

function mapPartReferenceToId(ref: string | undefined, ctx: RouterContext) {
  if (!ref) return null;
  const normalizedRef = normalizeToken(ref);
  if (!normalizedRef) return null;

  const direct = ctx.parts.find((part) => part.id === ref || part.name === ref);
  if (direct) return direct.id;

  let bestId: string | null = null;
  let bestScore = -1;
  for (const part of ctx.parts) {
    const nameToken = normalizeToken(part.name);
    const idToken = normalizeToken(part.id);
    let score = 0;
    if (normalizedRef === nameToken || normalizedRef === idToken) score = 100;
    else if (nameToken.includes(normalizedRef) || idToken.includes(normalizedRef)) score = 70 + normalizedRef.length;
    else if (normalizedRef.includes(nameToken) || normalizedRef.includes(idToken)) score = 40 + Math.max(nameToken.length, idToken.length);
    if (score > bestScore) {
      bestScore = score;
      bestId = part.id;
    }
  }
  return bestScore >= 45 ? bestId : null;
}

const sanitizeFace = (face: unknown): FaceId | undefined => {
  if (typeof face !== 'string') return undefined;
  const value = face.toLowerCase() as FaceId;
  return FACE_IDS.includes(value) ? value : undefined;
};

const sanitizeMethod = (method: unknown): AnchorMethodId | undefined => {
  if (typeof method !== 'string') return undefined;
  const normalized = method.toLowerCase();
  if (normalized === 'auto' || normalized === 'extreme_vertices') return 'planar_cluster';
  const value = normalized as AnchorMethodId;
  return METHOD_IDS.includes(value) ? value : undefined;
};

const sanitizeMode = (mode: unknown): MateMode | undefined => {
  if (typeof mode !== 'string') return undefined;
  const value = mode.toLowerCase() as MateMode;
  return MODE_IDS.includes(value) ? value : undefined;
};

export async function inferMateWithLlm(text: string, ctx: RouterContext): Promise<MateInference | null> {
  if (process.env.ROUTER_LLM_ENABLE === '0') return null;
  if (ctx.parts.length < 2) return null;
  const partContextLines = ctx.parts.slice(0, 24).map((part) => {
    const position = part.position ? `[${part.position.map((value) => Number(value).toFixed(4)).join(', ')}]` : 'n/a';
    const bbox = part.bboxSize ? `[${part.bboxSize.map((value) => Number(value).toFixed(4)).join(', ')}]` : 'n/a';
    return `- ${part.id}:${part.name} pos=${position} bbox=${bbox}`;
  });

  const prompt = [
    'Task: infer mate arguments from user text.',
    'Goal: choose source/target + face/method/mode that best match assembly intent (flush / insert / cover / side attach).',
    'Prefer geometric/semantic consistency over fixed defaults. Do not always output bottom/top.',
    'Return JSON only with keys:',
    '{',
    '  "sourcePartRef": string,',
    '  "targetPartRef": string,',
    '  "sourceFace": "top|bottom|left|right|front|back",',
    '  "targetFace": "top|bottom|left|right|front|back",',
    '  "sourceMethod": "planar_cluster|geometry_aabb|object_aabb|obb_pca|picked",',
    '  "targetMethod": "planar_cluster|geometry_aabb|object_aabb|obb_pca|picked",',
    '  "mode": "translate|twist|both",',
    '  "confidence": number(0..1),',
    '  "reason": string',
    '}',
    '',
    `User text: ${text}`,
    'Parts (id:name + pose + bbox):',
    ...partContextLines,
    `Current selection: ${ctx.selectionPartId || 'none'}`,
    `Current interaction mode: ${ctx.interactionMode || 'unknown'}`,
    'If uncertainty is high, keep confidence low (<0.8) and avoid forcing source/target swap.',
  ].join('\n');

  const raw = await callLlmJson(prompt);
  if (!raw || typeof raw !== 'object') return null;

  const sourcePartId = mapPartReferenceToId((raw as any).sourcePartRef, ctx);
  const targetPartId = mapPartReferenceToId((raw as any).targetPartRef, ctx);
  if (!sourcePartId || !targetPartId || sourcePartId === targetPartId) return null;

  return {
    sourcePartId,
    targetPartId,
    sourceFace: sanitizeFace((raw as any).sourceFace),
    targetFace: sanitizeFace((raw as any).targetFace),
    sourceMethod: sanitizeMethod((raw as any).sourceMethod),
    targetMethod: sanitizeMethod((raw as any).targetMethod),
    mode: sanitizeMode((raw as any).mode),
    confidence: typeof (raw as any).confidence === 'number' ? Number((raw as any).confidence) : undefined,
    reason: typeof (raw as any).reason === 'string' ? (raw as any).reason.slice(0, 180) : undefined,
  };
}

export async function answerGeneralQuestionWithLlm(text: string, ctx: RouterContext): Promise<string | null> {
  if (process.env.ROUTER_LLM_ENABLE === '0') return null;
  const prompt = [
    'You are a CAD assistant in a browser-based assembly studio.',
    'Reply in Traditional Chinese, concise and practical.',
    'Do not invent unavailable features.',
    `User question: ${text}`,
    `Model file: ${ctx.cadFileName || 'unknown'}`,
    `Part count: ${ctx.parts.length}`,
    `Step count: ${ctx.stepCount ?? 0}`,
    `Current mode: ${ctx.interactionMode || 'unknown'}`,
    'Return JSON: {"replyText":"..."}',
  ].join('\n');
  const raw = await callLlmJson(prompt);
  if (!raw || typeof raw !== 'object') return null;
  const replyText = typeof (raw as any).replyText === 'string' ? (raw as any).replyText.trim() : '';
  return replyText || null;
}
