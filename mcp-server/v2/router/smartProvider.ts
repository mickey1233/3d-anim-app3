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
import {
  resolveEntityPair,
  resolveEntityPairFromContext,
  buildMateArgsFromResolution,
  buildMateArgsFromContext,
} from './entityResolutionScorer.js';
import { decideRoute, type RouteMeta } from './routeDecision.js';
import type { RouterContext, RouterProvider, RouterRoute } from './types.js';

const DOCS_TOPK = Math.max(1, Math.min(10, Number(process.env.SMART_DOCS_TOPK || 3)));
const CODEX_ENABLED = process.env.SMART_CODEX_ENABLE !== '0';
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.ROUTER_LLM_MODEL || process.env.OLLAMA_MODEL || 'qwen3:30b';
const CALL_TIMEOUT_MS = Number(process.env.SMART_CHITCHAT_TIMEOUT_MS || 20_000);
/**
 * If the slow agent exceeds this threshold for a mate command, we abort and
 * return an error instead of hanging the UI. Set via MATE_FAST_TIMEOUT_MS env var.
 * Default: 8 s — enough for fast local LLMs but short enough to avoid demo timeouts.
 */
const MATE_AGENT_TIMEOUT_MS = Number(process.env.MATE_FAST_TIMEOUT_MS || 8_000);

// ---------------------------------------------------------------------------
// Assembly intent classification — server-side, no LLM
// ---------------------------------------------------------------------------

// Explicit external-target syntax: "裝到X上" / "mount to" / "attach onto"
// Presence of this pattern separates mount_to_target from assemble_together.
const EXPLICIT_TARGET_RE = [
  /裝(?:到|上).{0,30}上|固定到|安裝到|鎖到|鎖上.{0,20}上|接到|掛到/,
  /(?:mount|attach|install|fix|connect)\b.{0,40}?\b(?:to|on|onto|into)\b/i,
];
function hasExplicitTarget(text: string): boolean {
  return EXPLICIT_TARGET_RE.some((p) => p.test(text));
}

// Peer-grouping / assemble-together patterns (fires only when no explicit target)
const ASSEMBLE_TOGETHER_RE = [
  /[組裝]起來/,
  /[組裝]在一起/,
  /組成(?:一組|模組|群組|子組合|一個)?(?:模組|群組|組合|單元)?/,
  /先[組裝].{0,8}起來/,
  /assemble\s+(?:these|them|together)|group\s+(?:these|them|into|together)/i,
  /form\s+(?:a\s+)?(?:module|group|subassembly|unit)/i,
  /put\s+(?:these|them)\s+together/i,
];

/**
 * Returns the normalized top-level assembly intent.
 *   'assemble_together' — peer grouping, no external target
 *   'mount_to_target'   — source → external structural target
 *   'other'             — everything else (handled by existing mate fast-path / agent)
 */
function classifyAssemblyIntent(text: string): 'assemble_together' | 'mount_to_target' | 'other' {
  const hasGrouping = ASSEMBLE_TOGETHER_RE.some((p) => p.test(text));
  const hasTarget   = hasExplicitTarget(text);
  if (hasGrouping && !hasTarget) return 'assemble_together';
  if (hasTarget) return 'mount_to_target';
  return 'other';
}

// ---------------------------------------------------------------------------
// Mate/assembly command detection
// ---------------------------------------------------------------------------

const ASSEMBLY_KEYWORDS = [
  'mate', 'assemble', 'attach', 'connect', 'join', 'install', 'mount',
  '組裝', '裝配', '對齊', '安裝', '配合', '接合', '組合',
  '組起來', '裝起來', '合在一起', '裝在一起', '組在一起', '拼在一起', '結合', '固定',
];

function isMateCommand(text: string): boolean {
  const lower = text.toLowerCase();
  return ASSEMBLY_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

function detectGeometryIntent(text: string): 'insert' | 'cover' | 'default' {
  const lower = text.toLowerCase();
  if (/insert|plug|插入|嵌入/.test(lower)) return 'insert';
  if (/cover|cap|lid|蓋上|覆蓋/.test(lower)) return 'cover';
  return 'default';
}

// ---------------------------------------------------------------------------
// Peer-part resolution for assemble_together
// ---------------------------------------------------------------------------

/**
 * Find candidate peer parts to group from context.
 * Priority:
 *   1. multiSelectIds (2+ parts selected — most explicit)
 *   2. Named parts found in text (2+ part names)
 *   3. Selected part + its "peers" (parts with the same prefix/category in text context)
 *
 * Returns at least 2 parts, or null if insufficient context.
 */
function resolvePeerParts(
  text: string,
  ctx: RouterContext,
): { id: string; name: string }[] | null {
  const multiIds = ctx.multiSelectIds ?? [];

  // 1. Multi-select (most reliable)
  if (multiIds.length >= 2) {
    const parts = multiIds.map((id) => ctx.parts.find((p) => p.id === id)).filter(Boolean) as { id: string; name: string }[];
    if (parts.length >= 2) return parts;
  }

  // 2. All part names found in text (2+)
  const lowerText = text.toLowerCase();
  const namedParts = ctx.parts
    .filter((p) => lowerText.includes(p.name.toLowerCase()))
    .sort((a, b) => lowerText.indexOf(a.name.toLowerCase()) - lowerText.indexOf(b.name.toLowerCase()));
  if (namedParts.length >= 2) return namedParts;

  // 3. Selected part + semantic peers (same name prefix or already grouped peer)
  if (ctx.selectionPartId) {
    const selected = ctx.parts.find((p) => p.id === ctx.selectionPartId);
    if (selected) {
      // Find parts with same prefix (e.g. HOR_FAN_LEFT and HOR_FAN_RIGHT share HOR_FAN)
      const prefix = selected.name.replace(/[_\-]?(LEFT|RIGHT|TOP|BOTTOM|A|B|1|2|3|4)$/i, '');
      const peers = ctx.parts.filter(
        (p) => p.id !== selected.id && p.name.toUpperCase().startsWith(prefix.toUpperCase())
      );
      if (peers.length >= 1) return [selected, ...peers];
    }
  }

  return null;
}

function extractMatePartRefs(
  text: string,
  parts: RouterContext['parts'],
): { source: { id: string; name: string }; target: { id: string; name: string } } | null {
  const lower = text.toLowerCase();
  const found: { id: string; name: string; idx: number }[] = [];
  for (const part of parts) {
    const idx = lower.indexOf(part.name.toLowerCase());
    if (idx >= 0) found.push({ id: part.id, name: part.name, idx });
  }
  if (found.length < 2) return null;
  found.sort((a, b) => a.idx - b.idx);
  return { source: found[0], target: found[1] };
}

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

    // ── Assemble-together fast path ───────────────────────────────────────────
    //
    // Handles utterances where the user wants to GROUP peer parts into a movable
    // subassembly WITHOUT mounting onto an external target.
    //
    // Fires BEFORE the mate fast-path to prevent misclassification.
    {
      const assemblyIntent = classifyAssemblyIntent(text);
      if (assemblyIntent === 'assemble_together') {
        const peerParts = resolvePeerParts(text, ctx);
        if (peerParts && peerParts.length >= 2) {
          const partIds = peerParts.map((p) => p.id);
          const partNames = peerParts.map((p) => p.name).join(' + ');
          console.log(`[smart] assemble_together fast-path: peers=[${partNames}] count=${partIds.length}`);
          return withMeta(
            {
              toolCalls: [{
                tool: 'action.group_as_module',
                args: {
                  partIds,
                  addStep: true,
                  stepLabel: `Group: ${partNames}`,
                },
              }],
              replyText: `正在將 ${partNames} 組成模組...`,
            },
            {
              ...baseMeta,
              route: 'fast-model',
              fastMs: 0,
              model: 'grouping-fast-path',
              reason: `assemble_together: peers=[${partNames}] normalizedIntent=assemble_together usedFastPath=true usedGroupingPath=true candidatePeerPartIds=${partIds.join(',')}`,
            }
          );
        }
        // Not enough context for deterministic grouping — fall through to agent
        console.warn(`[smart] assemble_together detected but insufficient peer context — delegating to agent`);
      }
    }

    // ── Mate fast-path: deterministic, zero-LLM, instant ─────────────────────
    //
    // Priority order (highest first):
    //   Case 0 — context-aware: group/part selected + target found in text  ← NEW
    //   Case 1 — both names in text (original)
    //   Case 2 — deictic + multi-select
    //   Case 3 — exactly 2 multi-selected parts
    //
    // All cases produce action.demo_mate_and_apply with full diagnostics.
    // If the text is clearly a mate command and all fast paths miss, we still
    // run the agent but cap it at MATE_AGENT_TIMEOUT_MS to prevent hangs.

    // Shared emit helper — fires action.demo_mate_and_apply with diagnostics
    const emitMate = (
      mateArgs: Record<string, unknown>,
      displaySrc: string,
      displayTgt: string,
      fastPathKind: string,
      diagFields: Record<string, unknown>,
    ): RouterRoute => {
      const allDiag = {
        normalizedIntent: classifyAssemblyIntent(text) === 'mount_to_target' ? 'mount_to_target' : 'mount',
        usedFastPath: true,
        usedGroupingPath: false,
        mountedRelationRecorded: true,
        ...diagFields,
      };
      const diagStr = Object.entries(allDiag).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`[smart] mate fast-path(${fastPathKind}): ${displaySrc} → ${displayTgt} ${diagStr}`);
      return withMeta(
        {
          toolCalls: [{ tool: 'action.demo_mate_and_apply', args: mateArgs }],
          replyText: `正在組裝 ${displaySrc} → ${displayTgt}...`,
        },
        {
          ...baseMeta,
          route: 'fast-model',
          fastMs: 0,
          model: 'mate-fast-path',
          reason: diagStr,
        }
      );
    };

    if (isMateCommand(text)) {
      const multiIds = ctx.multiSelectIds ?? [];

      // ── Case 0: Context-aware — selected group/part + target from text ──────
      // Handles "把風扇模組裝到 THERMAL 上" even when the source name is not
      // a part name (it's a group name or implicit from selection).
      // This is the PRIMARY fast path for group-based assembly commands.
      {
        const ctxResolution = resolveEntityPairFromContext(text, ctx);
        if (ctxResolution) {
          const mateArgs = buildMateArgsFromContext(ctxResolution);
          const srcDisplay = ctxResolution.source.displayName;
          return emitMate(mateArgs, srcDisplay, ctxResolution.targetName, 'context-aware', {
            usedFastPath: true,
            sourceResolvedAs: ctxResolution.source.kind,
            sourceEntityId: ctxResolution.source.kind === 'group'
              ? ctxResolution.source.groupId
              : ctxResolution.source.partId,
            sourceGroupId: ctxResolution.sourceGroupId ?? 'none',
            targetPartId: ctxResolution.targetPartId,
            sourceResolvedBy: ctxResolution.sourceResolvedBy,
            diag: ctxResolution.diagnostics.join(' | '),
          });
        }
      }

      // ── Case 1: Both part names explicitly in text ───────────────────────────
      const mateRefs = extractMatePartRefs(text, ctx.parts);
      if (mateRefs) {
        const { source, target } = mateRefs;
        const resolution = resolveEntityPair(source.id, target.id, text, ctx);

        if (resolution.needsClarification && resolution.clarificationQuestion) {
          console.log(`[smart] mate fast-path(names) → clarification needed`);
          return withMeta(
            { toolCalls: [], replyText: resolution.clarificationQuestion },
            { ...baseMeta, route: 'fast-model', fastMs: 0, model: 'entity-resolution' }
          );
        }

        const top = resolution.sourceEntityCandidates[0];
        const displaySrc = top?.displayName ?? source.name;
        const mateArgs = buildMateArgsFromResolution(source.id, target.id, resolution);
        return emitMate(mateArgs, displaySrc, target.name, 'names', {
          usedFastPath: true,
          sourceResolvedAs: resolution.sourceResolvedAs ?? 'part',
          sourceEntityId: top?.entityId ?? source.id,
          sourceGroupId: top?.entityType === 'group' ? top.entityId : 'none',
          targetPartId: target.id,
        });
      }

      // ── Case 2: Deictic + multi-select ───────────────────────────────────────
      const isDeictic = /這兩個|這2個|those|these|them|它們|兩個零件/.test(text);
      if (isDeictic && multiIds.length >= 2) {
        const srcPart = ctx.parts.find((p) => p.id === multiIds[0]);
        const tgtPart = ctx.parts.find((p) => p.id === multiIds[1]);
        if (srcPart && tgtPart) {
          const resolution = resolveEntityPair(srcPart.id, tgtPart.id, text, ctx);
          if (resolution.needsClarification && resolution.clarificationQuestion) {
            return withMeta(
              { toolCalls: [], replyText: resolution.clarificationQuestion },
              { ...baseMeta, route: 'fast-model', fastMs: 0, model: 'entity-resolution' }
            );
          }
          const top = resolution.sourceEntityCandidates[0];
          return emitMate(
            buildMateArgsFromResolution(srcPart.id, tgtPart.id, resolution),
            top?.displayName ?? srcPart.name,
            tgtPart.name,
            'deictic',
            {
              usedFastPath: true,
              sourceResolvedAs: resolution.sourceResolvedAs ?? 'part',
              sourceEntityId: top?.entityId ?? srcPart.id,
              sourceGroupId: top?.entityType === 'group' ? top.entityId : 'none',
              targetPartId: tgtPart.id,
            }
          );
        }
      }

      // ── Case 3: Exactly 2 multi-selected parts ───────────────────────────────
      if (multiIds.length === 2 && !isDeictic) {
        const srcPart = ctx.parts.find((p) => p.id === multiIds[0]);
        const tgtPart = ctx.parts.find((p) => p.id === multiIds[1]);
        if (srcPart && tgtPart) {
          const resolution = resolveEntityPair(srcPart.id, tgtPart.id, text, ctx);
          if (resolution.needsClarification && resolution.clarificationQuestion) {
            return withMeta(
              { toolCalls: [], replyText: resolution.clarificationQuestion },
              { ...baseMeta, route: 'fast-model', fastMs: 0, model: 'entity-resolution' }
            );
          }
          const top = resolution.sourceEntityCandidates[0];
          return emitMate(
            buildMateArgsFromResolution(srcPart.id, tgtPart.id, resolution),
            top?.displayName ?? srcPart.name,
            tgtPart.name,
            'multi-select',
            {
              usedFastPath: true,
              sourceResolvedAs: resolution.sourceResolvedAs ?? 'part',
              sourceEntityId: top?.entityId ?? srcPart.id,
              sourceGroupId: top?.entityType === 'group' ? top.entityId : 'none',
              targetPartId: tgtPart.id,
            }
          );
        }
      }

      // ── Mate fail-fast: all fast paths missed — run agent with timeout ────────
      // Prevents hangs on commands like "幫我裝風扇" where no target name is known.
      console.warn(`[smart] mate fast-path: all cases missed — falling through to agent (cap=${MATE_AGENT_TIMEOUT_MS}ms) text="${text.slice(0, 60)}"`);
    }

    // ── Layer 2: Agent (CAD docs + tool routing) ──────────────────────────────
    // For mate commands: enforce a short timeout to prevent demo hangs.
    const isMate = isMateCommand(text);
    try {
      const fastStart = Date.now();
      const agentPromise = AgentRouterProvider.route(text, ctx);
      const timeoutMs = isMate ? MATE_AGENT_TIMEOUT_MS : CALL_TIMEOUT_MS;
      const result = await Promise.race([
        agentPromise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`stage=router_agent timeout after ${timeoutMs}ms (isMate=${isMate})`)),
            timeoutMs
          )
        ),
      ]);
      const fastMs = Date.now() - fastStart;
      console.log(`[smart] agent ok (${fastMs}ms)`);
      return withMeta(result as RouterRoute, { ...baseMeta, route: 'fast-model', fastMs, model: resolvedModelName('fast-model') });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg.includes('timeout');
      console.warn(`[smart] agent failed${isTimeout ? ' (TIMEOUT)' : ''}: ${msg}`);
      if (isMate) {
        return withMeta(
          {
            toolCalls: [],
            replyText: isTimeout
              ? `組裝指令路由超時（>${MATE_AGENT_TIMEOUT_MS}ms），請明確指定來源和目標零件名稱（例如：「把風扇裝到 THERMAL 上」）。`
              : '無法解析組裝指令，請明確指定來源和目標零件名稱（例如：「把風扇裝到 THERMAL 上」）。',
          },
          { ...baseMeta, route: 'fast-model', reason: `mate_agent_failed: ${msg}` }
        );
      }
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
