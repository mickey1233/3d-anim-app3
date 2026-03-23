/**
 * codexProvider.ts
 *
 * RouterProvider using @openai/codex-sdk (ChatGPT subscription, no API key needed).
 *
 * SETUP (one-time):
 *   npm install -g @openai/codex
 *   codex login
 *
 * Env vars (all optional):
 *   CODEX_MODEL        — model override (e.g. "codex-mini-latest")
 *   CODEX_TIMEOUT_MS   — timeout per request in ms (default: 90000)
 *   ROUTER_AGENT_DIR   — directory containing agent markdown docs
 */

import { Codex } from '@openai/codex-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { MCPToolRequestSchema } from '../../../shared/schema/mcpToolsV3.js';
import type { ToolCall } from '../../../shared/schema/index.js';
import { MockRouterProvider } from './mockProvider.js';
import type { RouterContext, RouterProvider } from './types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CODEX_MODEL = process.env.CODEX_MODEL || '';
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 90_000);
const MAX_TOOL_CALLS = Math.max(1, Math.min(12, Number(process.env.ROUTER_AGENT_MAX_TOOL_CALLS || 6)));
const DEFAULT_AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'agent');

// ---------------------------------------------------------------------------
// Docs loader — loads only the key docs, skips model_routing (not needed for single-call)
// ---------------------------------------------------------------------------

type DocsCache = { dir: string; key: string; docs: string };
let cachedDocs: DocsCache | null = null;

// Docs to always include (in priority order), others skipped to keep prompt small
const KEY_DOC_PATTERNS = ['SYSTEM', 'WORKFLOWS', 'knowledge/assembly', 'skills/mate', 'qa/examples'];

function loadDocs(): string {
  const dir = process.env.ROUTER_AGENT_DIR || DEFAULT_AGENT_DIR;

  function walk(base: string, rel = ''): string[] {
    const full = path.join(base, rel);
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(full, { withFileTypes: true }); } catch { return []; }
    const out: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const next = path.join(rel, e.name);
      if (e.isDirectory()) out.push(...walk(base, next));
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(next);
    }
    return out;
  }

  const allFiles = walk(dir).sort((a, b) => a.localeCompare(b));
  // Only include key docs to minimise token usage
  const files = allFiles.filter((f) =>
    KEY_DOC_PATTERNS.some((p) => f.replace(/\\/g, '/').toLowerCase().includes(p.toLowerCase()))
  );
  // Fallback: include all if no key docs found
  const selected = files.length > 0 ? files : allFiles;

  const key = selected.map((f) => {
    try { return `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`; } catch { return `${f}:0`; }
  }).join('|');

  if (cachedDocs?.dir === dir && cachedDocs.key === key) return cachedDocs.docs;

  const blocks: string[] = [];
  for (const rel of selected) {
    try {
      const content = fs.readFileSync(path.join(dir, rel), 'utf8').trim();
      if (content) blocks.push(`## ${rel}\n${content}`);
    } catch { /* skip */ }
  }

  const docs = blocks.join('\n\n');
  cachedDocs = { dir, key, docs };
  return docs;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractJson(raw: string): unknown {
  const text = raw.replace(/^```[a-z]*\n?/im, '').replace(/\n?```$/m, '').trim();
  try { return JSON.parse(text); } catch { /* fall through */ }
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(text.slice(s, e + 1)); } catch { /* fall through */ }
  }
  return null;
}

function sanitizeToolCalls(calls: z.infer<typeof AgentToolCallSchema>[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (const call of calls) {
    const parsed = MCPToolRequestSchema.safeParse({ tool: call.tool, args: call.args ?? {} });
    if (!parsed.success) continue;
    out.push({
      tool: parsed.data.tool,
      args: parsed.data.args ?? {},
      ...(typeof call.confidence === 'number' ? { confidence: call.confidence } : {}),
      ...(typeof call.explain === 'string' && call.explain.trim()
        ? { explain: call.explain.trim().slice(0, 220) }
        : {}),
    });
    if (out.length >= MAX_TOOL_CALLS) break;
  }
  return out;
}

function summarizeContext(ctx: RouterContext) {
  return {
    parts: ctx.parts.slice(0, 20),
    cadFileName: ctx.cadFileName ?? null,
    stepCount: ctx.stepCount ?? null,
    currentStepId: ctx.currentStepId ?? null,
    selectionPartId: ctx.selectionPartId ?? null,
    interactionMode: ctx.interactionMode ?? null,
    iteration: ctx.iteration ?? 0,
    toolResults: Array.isArray(ctx.toolResults) ? ctx.toolResults.slice(-5) : [],
  };
}

// ---------------------------------------------------------------------------
// Codex client singleton
// ---------------------------------------------------------------------------

let _codex: Codex | null = null;
function getCodex(): Codex {
  if (!_codex) _codex = new Codex();
  return _codex;
}

// ---------------------------------------------------------------------------
// Single-shot call to Codex
// ---------------------------------------------------------------------------

async function callCodex(prompt: string): Promise<string | null> {
  const signal = AbortSignal.timeout(CODEX_TIMEOUT_MS);
  try {
    const thread = getCodex().startThread({
      ...(CODEX_MODEL ? { model: CODEX_MODEL } : {}),
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      skipGitRepoCheck: true,
    });
    const result = await thread.run(prompt, { signal });
    const text = result.finalResponse?.trim();
    if (text) console.log(`[codex] got response (${text.length} chars)`);
    return text ?? null;
  } catch (err) {
    console.warn('[codex] call failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const CodexRouterProvider: RouterProvider = {
  async route(text: string, ctx: RouterContext) {
    const docs = loadDocs();
    const ctxJson = JSON.stringify(summarizeContext(ctx), null, 2);

    const prompt = [
      docs,
      '---',
      'Runtime context (JSON):',
      ctxJson,
      '---',
      `User: ${text}`,
      '',
      'Output JSON ONLY (no markdown fences, no extra text):',
      '{"toolCalls":[{"tool":"<tool>","args":{}}],"replyText":"<reply>"}',
      'If no tool needed, use toolCalls:[] and put your reply in replyText.',
    ].filter(Boolean).join('\n');

    console.log(`[codex] routing: "${text.slice(0, 60)}"`);
    const raw = await callCodex(prompt);

    if (!raw) {
      console.warn('[codex] empty response — fallback to mock');
      return MockRouterProvider.route(text, ctx);
    }

    const parsed = AgentRouteSchema.safeParse(extractJson(raw));
    if (!parsed.success) {
      console.warn('[codex] parse failed, raw:', raw.slice(0, 300));
      // If it looks like a plain text reply, wrap it
      if (raw.length > 0 && !raw.startsWith('{')) {
        return { toolCalls: [], replyText: raw.slice(0, 500) };
      }
      return MockRouterProvider.route(text, ctx);
    }

    const replyText = parsed.data.replyText?.trim() || undefined;
    let toolCalls = sanitizeToolCalls(parsed.data.toolCalls);

    // Enforce planning/action separation
    const isPlanningCall = (c: ToolCall) =>
      c.tool === 'view.capture_image' || c.tool.startsWith('query.');
    const hasPlan = toolCalls.some(isPlanningCall);
    const hasAction = toolCalls.some((c) => !isPlanningCall(c));
    if (hasPlan && hasAction) toolCalls = toolCalls.filter(isPlanningCall);

    if (toolCalls.length === 0 && !replyText) {
      return MockRouterProvider.route(text, ctx);
    }

    return { toolCalls, ...(replyText ? { replyText } : {}) };
  },
};
