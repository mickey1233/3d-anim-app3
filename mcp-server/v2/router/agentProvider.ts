import type { ToolCall } from '../../../shared/schema/index.js';
import { MCPToolRequestSchema } from '../../../shared/schema/mcpToolsV3.js';
import { z } from 'zod';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MockRouterProvider } from './mockProvider.js';
import type { RouterContext, RouterProvider } from './types.js';

type LlmProvider = 'auto' | 'ollama' | 'gemini';

const DEFAULT_TIMEOUT_MS = Number(process.env.ROUTER_LLM_TIMEOUT_MS || 3200);
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.ROUTER_LLM_MODEL || process.env.OLLAMA_MODEL || 'qwen3:30b';
const GEMINI_MODEL = process.env.GEMINI_MODEL || process.env.ROUTER_LLM_MODEL || 'gemini-1.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const DEFAULT_AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'agent');
const MAX_TOOL_CALLS = Math.max(1, Math.min(12, Number(process.env.ROUTER_AGENT_MAX_TOOL_CALLS || 6)));

const AgentToolCallSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  explain: z.string().optional(),
});

const AgentRouteSchema = z.object({
  toolCalls: z.array(AgentToolCallSchema).default([]),
  replyText: z.string().optional(),
});

function withTimeout(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeout };
}

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
          { role: 'system', content: 'You are a strict JSON routing agent. Output JSON only.' },
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

function listMarkdownFiles(rootDir: string, relativeDir = ''): string[] {
  const dir = path.join(rootDir, relativeDir);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const nextRel = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMarkdownFiles(rootDir, nextRel));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(nextRel);
    }
  }
  return out;
}

let cachedAgentDocs: { dir: string; key: string; content: string } | null = null;

function loadAgentDocs() {
  const dir = process.env.ROUTER_AGENT_DIR || DEFAULT_AGENT_DIR;
  const files = listMarkdownFiles(dir).sort((a, b) => a.localeCompare(b));
  const keyParts: string[] = [];
  for (const rel of files) {
    try {
      const stat = fs.statSync(path.join(dir, rel));
      keyParts.push(`${rel}:${stat.mtimeMs}`);
    } catch {
      keyParts.push(`${rel}:0`);
    }
  }
  const key = keyParts.join('|');
  if (cachedAgentDocs && cachedAgentDocs.dir === dir && cachedAgentDocs.key === key) return cachedAgentDocs.content;

  const blocks: string[] = [];
  for (const rel of files) {
    try {
      const full = path.join(dir, rel);
      const content = fs.readFileSync(full, 'utf8').trim();
      if (!content) continue;
      blocks.push(`## ${rel}\n${content}`);
    } catch {
      // ignore individual file errors
    }
  }
  const combined = blocks.join('\n\n').trim();
  cachedAgentDocs = { dir, key, content: combined };
  return combined;
}

const summarizeContext = (ctx: RouterContext) => {
  const summary: RouterContext = {
    parts: ctx.parts.slice(0, 32),
    cadFileName: ctx.cadFileName ?? null,
    stepCount: ctx.stepCount,
    currentStepId: ctx.currentStepId ?? null,
    selectionPartId: ctx.selectionPartId ?? null,
    interactionMode: ctx.interactionMode,
    iteration: ctx.iteration ?? 0,
    toolResults: Array.isArray(ctx.toolResults) ? ctx.toolResults.slice(-10) : [],
  };
  return summary;
};

function buildPrompt(text: string, ctx: RouterContext) {
  const docs = loadAgentDocs();
  const ctxJson = JSON.stringify(summarizeContext(ctx), null, 2);
  return [
    docs ? `${docs}\n` : '',
    '---',
    'Runtime context (JSON):',
    ctxJson,
    '---',
    `User text: ${text}`,
    '',
    'Return JSON only, with this shape:',
    '{"toolCalls":[{"tool":"<mcp tool name>","args":{...}}],"replyText":"<optional user-facing reply>"}',
  ]
    .filter(Boolean)
    .join('\n');
}

function sanitizeToolCalls(calls: Array<z.infer<typeof AgentToolCallSchema>>): ToolCall[] {
  const out: ToolCall[] = [];
  for (const call of calls) {
    const parsed = MCPToolRequestSchema.safeParse({
      tool: call.tool,
      args: call.args ?? {},
    });
    if (!parsed.success) continue;
    out.push({
      tool: parsed.data.tool,
      args: parsed.data.args ?? {},
      ...(typeof call.confidence === 'number' ? { confidence: call.confidence } : {}),
      ...(typeof call.explain === 'string' && call.explain.trim() ? { explain: call.explain.trim().slice(0, 220) } : {}),
    });
    if (out.length >= MAX_TOOL_CALLS) break;
  }
  return out;
}

const isPlanningToolCall = (call: ToolCall) => call.tool === 'view.capture_image' || call.tool.startsWith('query.');

export const AgentRouterProvider: RouterProvider = {
  async route(text: string, ctx: RouterContext) {
    if (process.env.ROUTER_LLM_ENABLE === '0') return MockRouterProvider.route(text, ctx);

    const prompt = buildPrompt(text, ctx);
    const raw = await callLlmJson(prompt);
    if (!raw || typeof raw !== 'object') return MockRouterProvider.route(text, ctx);

    const parsed = AgentRouteSchema.safeParse(raw);
    if (!parsed.success) return MockRouterProvider.route(text, ctx);

    const replyText = parsed.data.replyText?.trim() || undefined;
    let toolCalls = sanitizeToolCalls(parsed.data.toolCalls);

    const hasPlanningCalls = toolCalls.some((call) => isPlanningToolCall(call));
    const hasNonPlanningCalls = toolCalls.some((call) => !isPlanningToolCall(call));
    if (hasPlanningCalls && hasNonPlanningCalls) {
      toolCalls = toolCalls.filter((call) => isPlanningToolCall(call));
    }

    if (toolCalls.length === 0 && !replyText) return MockRouterProvider.route(text, ctx);

    return { toolCalls, replyText };
  },
};
