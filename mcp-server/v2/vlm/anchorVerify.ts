import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Codex } from '@openai/codex-sdk';

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
// Use a vision-capable model for anchor verification.
// VLM_ANCHOR_MODEL overrides; falls back to OLLAMA_MODEL then llava (vision default).
// Do NOT inherit VLM_MATE_MODEL here — mate models (qwen3.5) are text-only.
const OLLAMA_MODEL = process.env.VLM_ANCHOR_MODEL || process.env.OLLAMA_MODEL || 'llava:latest';
const CODEX_MODEL = process.env.CODEX_MODEL || '';
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 90_000);
const VERIFY_TIMEOUT_MS = 8000;

const LOG_DIR = path.resolve(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'anchor-verify-failures.jsonl');

export type AnchorVerifyResult = {
  correct: boolean;
  confidence: number;
  reason: string;
  provider: string;
};

export type AnchorVerifyFailureEntry = {
  timestamp: string;
  partName: string;
  faceId: string;
  triedMethods: string[];
  vlmReasons: Record<string, string>;
};

function buildPrompt(faceId: string, partName: string): string {
  const faceDescriptions: Record<string, string> = {
    top:    'the topmost surface facing upward (+Y in local frame)',
    bottom: 'the bottommost surface facing downward (-Y in local frame)',
    left:   'the left side surface facing left (-X in local frame)',
    right:  'the right side surface facing right (+X in local frame)',
    front:  'the front surface facing forward (+Z in local frame)',
    back:   'the back surface facing backward (-Z in local frame)',
  };
  const desc = faceDescriptions[faceId] ?? `the "${faceId}" face`;
  return [
    `You are inspecting a 3D CAD part in a rendered scene screenshot.`,
    `A colored sphere (cyan or pink dot) marks the selected anchor point on the part named "${partName}".`,
    `Determine if the sphere is correctly placed on ${desc}.`,
    ``,
    `Reply with JSON only (no markdown):`,
    `{ "correct": true_or_false, "confidence": 0.0_to_1.0, "reason": "short explanation" }`,
  ].join('\n');
}

// Codex vision prompt: includes the screenshot for accurate anchor placement verification.
function buildCodexPrompt(faceId: string, partName: string): string {
  const faceDescriptions: Record<string, string> = {
    top:    'the topmost surface facing upward (+Y in local frame)',
    bottom: 'the bottommost surface facing downward (-Y in local frame)',
    left:   'the left side surface facing left (-X in local frame)',
    right:  'the right side surface facing right (+X in local frame)',
    front:  'the front surface facing forward (+Z in local frame)',
    back:   'the back surface facing backward (-Z in local frame)',
  };
  const desc = faceDescriptions[faceId] ?? `the "${faceId}" face`;
  return [
    `You are inspecting a 3D CAD part in a rendered scene screenshot.`,
    `A colored sphere (cyan or pink dot) marks the selected anchor point on the part named "${partName}".`,
    `Determine if the sphere is correctly placed on ${desc}.`,
    ``,
    `Reply with JSON only (no markdown, no code fences):`,
    `{ "correct": true_or_false, "confidence": 0.0_to_1.0, "reason": "short explanation" }`,
  ].join('\n');
}

function extractJson(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  try { return JSON.parse(text) as Record<string, unknown>; } catch { /* fall through */ }
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(text.slice(s, e + 1)) as Record<string, unknown>; } catch { /* fall through */ }
  }
  return null;
}

async function callOllama(prompt: string, imageBase64: string, mime: string): Promise<AnchorVerifyResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
            { type: 'text', text: prompt },
          ],
        }],
        options: { temperature: 0 },
      }),
    });
    if (!res.ok) return null;
    const json = await res.json() as Record<string, unknown>;
    const content = String((json as any)?.message?.content || (json as any)?.response || '');
    const parsed = extractJson(content);
    if (!parsed) return null;
    return {
      correct: Boolean(parsed.correct),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      reason: String(parsed.reason || '').slice(0, 200),
      provider: 'ollama',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let _codex: Codex | null = null;
function getCodex(): Codex {
  if (!_codex) _codex = new Codex();
  return _codex;
}

// Codex fallback: vision-capable (codex-mini-latest is fine-tuned o4-mini, multimodal).
// Writes image to a temp file so thread.run() can load it via local_image.
async function callCodex(faceId: string, partName: string, imageBase64: string, mime: string): Promise<AnchorVerifyResult | null> {
  const ext = mime.includes('png') ? 'png' : 'jpg';
  const tmpFile = path.join(os.tmpdir(), `anchor-verify-${Date.now()}.${ext}`);
  try {
    fs.writeFileSync(tmpFile, Buffer.from(imageBase64, 'base64'));
    const signal = AbortSignal.timeout(CODEX_TIMEOUT_MS);
    const thread = getCodex().startThread({
      ...(CODEX_MODEL ? { model: CODEX_MODEL } : {}),
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      skipGitRepoCheck: true,
    });
    const prompt = buildCodexPrompt(faceId, partName);
    const result = await thread.run(
      [{ type: 'local_image', path: tmpFile }, { type: 'text', text: prompt }],
      { signal },
    );
    const text = result.finalResponse?.trim();
    if (!text) return null;
    const parsed = extractJson(text);
    if (!parsed) return null;
    return {
      correct: Boolean(parsed.correct),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      reason: String(parsed.reason || '').slice(0, 200),
      provider: 'codex',
    };
  } catch (err) {
    console.warn('[anchor-verify/codex] call failed:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
  }
}

export async function verifyAnchorFace(
  imageBase64: string,
  mime: string,
  faceId: string,
  partName: string,
): Promise<AnchorVerifyResult> {
  const prompt = buildPrompt(faceId, partName);
  // 1. Try Ollama vision (primary — can see the screenshot)
  const ollama = await callOllama(prompt, imageBase64, mime);
  if (ollama) return ollama;
  // 2. Codex fallback (codex-mini-latest — multimodal vision, same prompt + image)
  const codex = await callCodex(faceId, partName, imageBase64, mime);
  if (codex) return codex;
  // 3. All unavailable — treat as correct so user is not blocked
  return { correct: true, confidence: 0, reason: 'vlm_unavailable', provider: 'none' };
}

export function logAnchorVerifyFailure(entry: Omit<AnchorVerifyFailureEntry, 'timestamp'>): void {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n';
    fs.appendFileSync(LOG_FILE, line, 'utf8');
    console.warn('[anchor-verify] All methods failed for', entry.partName, entry.faceId, '— logged to', LOG_FILE);
  } catch (err) {
    console.error('[anchor-verify] Failed to write failure log:', err);
  }
}
