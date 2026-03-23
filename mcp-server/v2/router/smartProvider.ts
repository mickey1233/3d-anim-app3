/**
 * smartProvider.ts
 *
 * 3-layer router orchestrator:
 *   Layer 1 — Docs-first (zero-LLM): BM25 keyword match against knowledge docs.
 *   Layer 2 — Fast model (Ollama / agent): tool commands, project questions.
 *   Layer 3 — Codex SDK: Only for deep_analysis queries.
 *
 * For queries that don't match clear tool keywords, an LLM intent classifier
 * decides whether to route to the CAD agent (project question) or a lightweight
 * conversational path (chitchat). This avoids hardcoded keyword lists for
 * every possible phrasing.
 *
 * Env vars:
 *   SMART_CODEX_ENABLE=0        — disable Codex Layer 3 (default: enabled)
 *   SMART_DOCS_TOPK=3           — doc chunks for Layer 1
 *   SMART_CHITCHAT_TIMEOUT_MS   — timeout for chitchat/classify calls (default: 20000)
 */

import { AgentRouterProvider } from './agentProvider.js';
import { CodexRouterProvider } from './codexProvider.js';
import { type DocChunk, retrieveDocs } from './docsRetrieval.js';
import { decideRoute, type RouteMeta } from './routeDecision.js';
import type { RouterContext, RouterProvider, RouterRoute } from './types.js';

const DOCS_TOPK = Math.max(1, Math.min(10, Number(process.env.SMART_DOCS_TOPK || 3)));
const CODEX_ENABLED = process.env.SMART_CODEX_ENABLE !== '0';
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.ROUTER_LLM_MODEL || process.env.OLLAMA_MODEL || 'qwen3:30b';
const CALL_TIMEOUT_MS = Number(process.env.SMART_CHITCHAT_TIMEOUT_MS || 20_000);

function resolvedModelName(layer: 'fast-model' | 'codex' | 'docs'): string {
  if (layer === 'docs') return 'docs (no LLM)';
  if (layer === 'codex') return process.env.CODEX_MODEL || 'codex';
  const provider = (process.env.ROUTER_LLM_PROVIDER || 'ollama').toLowerCase();
  return `${provider}/${OLLAMA_MODEL}`;
}

// ---------------------------------------------------------------------------
// Shared Ollama helper
// ---------------------------------------------------------------------------

async function ollamaChat(messages: { role: string; content: string }[], opts?: {
  format?: 'json';
  temperature?: number;
}): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        ...(opts?.format ? { format: opts.format } : {}),
        options: { temperature: opts?.temperature ?? 0.7 },
        messages,
      }),
    });
    if (!res.ok) return null;
    const payload = await res.json();
    return String(payload?.message?.content || '').trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// LLM intent classifier — decides "project" vs "chitchat" for ambiguous queries
// ---------------------------------------------------------------------------

const CLASSIFY_SYSTEM = `你是一個意圖分類器。這個應用是一個瀏覽器 3D CAD 組裝工具。
使用者可以操作 3D 場景（選取零件、mate 組裝、新增步驟、切換模式等）。

判斷使用者輸入是否與這個工具有關：
- "project"：詢問工具功能、工具能做什麼、如何操作、3D 相關問題
- "chitchat"：與這個工具完全無關的一般對話（心情、天氣、生活、個人問題等）

只輸出 JSON，不要其他文字：{"intent":"project"} 或 {"intent":"chitchat"}`;

async function classifyIntent(text: string): Promise<'project' | 'chitchat'> {
  const raw = await ollamaChat(
    [
      { role: 'system', content: CLASSIFY_SYSTEM },
      { role: 'user', content: text },
    ],
    { format: 'json', temperature: 0 }
  );
  if (!raw) return 'project'; // default: assume project on failure
  try {
    const parsed = JSON.parse(raw);
    return parsed?.intent === 'chitchat' ? 'chitchat' : 'project';
  } catch {
    return 'project';
  }
}

// ---------------------------------------------------------------------------
// Chitchat — lightweight call, no CAD docs, responds in Traditional Chinese
// ---------------------------------------------------------------------------

const CHITCHAT_SYSTEM =
  '你是一個友善的繁體中文助理。用自然、簡短的繁體中文語氣直接回覆使用者，不需要提及任何 3D CAD 工具或功能。';

async function callChitchat(text: string): Promise<string | null> {
  return ollamaChat([
    { role: 'system', content: CHITCHAT_SYSTEM },
    { role: 'user', content: text },
  ]);
}

// ---------------------------------------------------------------------------
// Layer 1 — Docs
// ---------------------------------------------------------------------------

function buildDocsReply(chunks: DocChunk[]): string {
  return chunks
    .slice(0, 3)
    .map((c) => {
      const excerpt = c.text.length > 500 ? `${c.text.slice(0, 500)}…` : c.text;
      return `**${c.heading}**\n${excerpt}`;
    })
    .join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// SmartRouterProvider
// ---------------------------------------------------------------------------

export const SmartRouterProvider: RouterProvider = {
  async route(text: string, ctx: RouterContext): Promise<RouterRoute> {
    // ── Step 1: Retrieve docs (always, fast) ──────────────────────────────────
    const docsStart = Date.now();
    const docChunks = retrieveDocs(text, DOCS_TOPK);
    const docsMs = Date.now() - docsStart;
    const docsScore = docChunks[0]?.score ?? 0;

    // ── Step 2: Keyword-based route decision ──────────────────────────────────
    const decision = decideRoute(text, docsScore);
    const baseMeta: RouteMeta = { ...decision, docsMs };

    console.log(
      `[smart] query="${text.slice(0, 50)}" cat=${decision.category} route=${decision.route} docsScore=${docsScore.toFixed(2)}`
    );

    // ── Layer 1: Docs (high-confidence CAD doc lookup) ────────────────────────
    if (decision.route === 'docs' && docChunks.length > 0) {
      console.log(`[smart] served from docs (${docChunks.length} chunks)`);
      return withMeta(
        { toolCalls: [], replyText: buildDocsReply(docChunks) },
        { ...baseMeta, route: 'docs', model: resolvedModelName('docs') }
      );
    }

    // ── Layer 3: Codex for deep_analysis ─────────────────────────────────────
    if (decision.route === 'codex' && CODEX_ENABLED) {
      try {
        const codexStart = Date.now();
        const result = await CodexRouterProvider.route(text, ctx);
        const codexMs = Date.now() - codexStart;
        console.log(`[smart] codex ok (${codexMs}ms)`);
        return withMeta(result, { ...baseMeta, route: 'codex', codexMs, model: resolvedModelName('codex') });
      } catch (err) {
        console.warn('[smart] codex failed:', err instanceof Error ? err.message : err);
        // fall through to fast-model
      }
    }

    // ── LLM intent classification for ambiguous queries ───────────────────────
    // Only classify when category is NOT a clear tool_command or doc_lookup.
    // tool_command always goes to agent; only "simple_qa" / unknown is ambiguous.
    let effectiveCategory = decision.category;
    if (decision.category === 'simple_qa') {
      const classifyStart = Date.now();
      const intent = await classifyIntent(text);
      const classifyMs = Date.now() - classifyStart;
      effectiveCategory = intent === 'chitchat' ? 'chitchat' : 'simple_qa';
      console.log(`[smart] classify="${intent}" (${classifyMs}ms)`);
    }

    // ── Chitchat path — no CAD docs, natural conversation ────────────────────
    if (effectiveCategory === 'chitchat') {
      const fastStart = Date.now();
      const reply = await callChitchat(text);
      const fastMs = Date.now() - fastStart;
      if (reply) {
        console.log(`[smart] chitchat ok (${fastMs}ms)`);
        return withMeta(
          { toolCalls: [], replyText: reply },
          { ...baseMeta, route: 'fast-model', fastMs, model: resolvedModelName('fast-model'), category: 'chitchat' }
        );
      }
      return withMeta(
        { toolCalls: [], replyText: '你好！有什麼我可以幫你的嗎？' },
        { ...baseMeta, route: 'fast-model', model: 'fallback', category: 'chitchat' }
      );
    }

    // ── Layer 2: Agent (CAD docs + tool routing) ──────────────────────────────
    try {
      const fastStart = Date.now();
      const result = await AgentRouterProvider.route(text, ctx);
      const fastMs = Date.now() - fastStart;
      console.log(`[smart] agent ok (${fastMs}ms)`);
      return withMeta(result, { ...baseMeta, route: 'fast-model', fastMs, model: resolvedModelName('fast-model') });
    } catch (err) {
      console.warn('[smart] agent failed:', err instanceof Error ? err.message : err);
    }

    return withMeta(
      { toolCalls: [], replyText: '抱歉，目前無法處理你的請求，請稍後再試。' },
      { ...baseMeta, route: 'fast-model', reason: 'all layers failed' }
    );
  },
};

// ---------------------------------------------------------------------------
// Helper: attach routeMeta to result
// ---------------------------------------------------------------------------

function withMeta(result: RouterRoute, meta: RouteMeta): RouterRoute {
  return Object.assign({}, result, { routeMeta: meta });
}
