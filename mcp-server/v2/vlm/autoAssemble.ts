type VlmImage = { name: string; data: string; mime: string };
type VlmPart = { name: string };

export type AssemblyStep = {
  sourceName: string;
  targetName: string;
  instruction: string;
  stepIndex: number;
};

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.VLM_MATE_MODEL || process.env.OLLAMA_MODEL || 'qwen3.5:27b';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || process.env.VLM_MATE_MODEL || 'gemini-1.5-flash';
const TIMEOUT_MS = Number(process.env.VLM_MATE_TIMEOUT_MS || 8000);

function buildPrompt(parts: VlmPart[]): string {
  const partNames = parts.map((p) => p.name).join(', ');
  return [
    'You are an assembly planning assistant. Given a set of CAD parts, output a JSON assembly sequence.',
    `Parts: ${partNames}`,
    '',
    'Rules:',
    '- Choose one part as the base (typically the largest or most central).',
    '- List assembly steps in order, each mating one part to an already-placed part.',
    '- Output ONLY a JSON array, no explanation.',
    '',
    'Output format (JSON array):',
    '[',
    '  { "sourceName": "<part to move>", "targetName": "<already placed part>", "instruction": "<brief description>", "stepIndex": 0 },',
    '  ...',
    ']',
  ].join('\n');
}

async function inferWithOllama(images: VlmImage[], parts: VlmPart[]): Promise<AssemblyStep[]> {
  const prompt = buildPrompt(parts);
  const body: any = {
    model: OLLAMA_MODEL,
    prompt,
    stream: false,
    format: 'json',
  };
  if (images.length > 0) {
    body.images = images.slice(0, 2).map((img) => img.data);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const json: any = await res.json();
    const text = typeof json.response === 'string' ? json.response : JSON.stringify(json);
    return parseStepsFromText(text, parts);
  } finally {
    clearTimeout(timeout);
  }
}

async function inferWithGemini(images: VlmImage[], parts: VlmPart[]): Promise<AssemblyStep[]> {
  if (!GEMINI_API_KEY) throw new Error('No GEMINI_API_KEY');
  const prompt = buildPrompt(parts);
  const contents: any[] = [{ text: prompt }];
  if (images.length > 0) {
    contents.push({
      inlineData: { mimeType: images[0].mime, data: images[0].data },
    });
  }

  const body = {
    contents: [{ role: 'user', parts: contents }],
    generationConfig: { responseMimeType: 'application/json' },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const json: any = await res.json();
    const text =
      json?.candidates?.[0]?.content?.parts?.[0]?.text ||
      json?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data ||
      '';
    return parseStepsFromText(text, parts);
  } finally {
    clearTimeout(timeout);
  }
}

function parseStepsFromText(text: string, parts: VlmPart[]): AssemblyStep[] {
  const partNames = new Set(parts.map((p) => p.name.toLowerCase()));
  try {
    // Try direct parse
    const trimmed = text.trim();
    const match = trimmed.match(/\[[\s\S]*\]/);
    const jsonText = match ? match[0] : trimmed;
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) return linearFallback(parts);
    const steps: AssemblyStep[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const sourceName = typeof item.sourceName === 'string' ? item.sourceName : '';
      const targetName = typeof item.targetName === 'string' ? item.targetName : '';
      if (!sourceName || !targetName) continue;
      steps.push({
        sourceName,
        targetName,
        instruction: typeof item.instruction === 'string' ? item.instruction : `Mate ${sourceName} to ${targetName}`,
        stepIndex: steps.length,
      });
    }
    if (steps.length === 0) return linearFallback(parts);
    return steps;
  } catch {
    return linearFallback(parts);
  }
}

function linearFallback(parts: VlmPart[]): AssemblyStep[] {
  if (parts.length < 2) return [];
  const base = parts[0];
  return parts.slice(1).map((p, i) => ({
    sourceName: p.name,
    targetName: i === 0 ? base.name : parts[i].name,
    instruction: `Mate ${p.name} to ${i === 0 ? base.name : parts[i].name}`,
    stepIndex: i,
  }));
}

export async function inferAssemblySequence(
  images: VlmImage[],
  parts: VlmPart[],
): Promise<AssemblyStep[]> {
  if (parts.length < 2) return [];

  const provider = (process.env.V2_VLM_PROVIDER || process.env.VLM_PROVIDER || 'auto').toLowerCase();

  if (provider === 'gemini' || (provider === 'auto' && GEMINI_API_KEY)) {
    try {
      return await inferWithGemini(images, parts);
    } catch {
      // fall through
    }
  }

  if (provider === 'ollama' || provider === 'auto') {
    try {
      return await inferWithOllama(images, parts);
    } catch {
      // fall through
    }
  }

  return linearFallback(parts);
}
