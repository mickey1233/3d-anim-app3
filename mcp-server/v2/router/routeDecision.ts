/**
 * routeDecision.ts
 *
 * Rule-based query classifier + route decision matrix.
 * Determines which layer (docs / fast-model / codex) should handle a query.
 *
 * Classification logic (priority order):
 *   1. deep_analysis  — code/repo/debug keywords → codex
 *   2. doc_lookup     — CAD-specific feature name keywords → docs layer
 *   3. tool_command   — scene action keywords → fast-model
 *   4. chitchat       — DEFAULT for anything else (LLM answers naturally)
 */

export type QueryCategory =
  | 'tool_command'  // user wants to trigger a scene action
  | 'doc_lookup'    // question about how a CAD feature works
  | 'deep_analysis' // complex reasoning / code analysis
  | 'chitchat'      // resolved by LLM classifier in smartProvider
  | 'simple_qa';    // default — sent to LLM classifier to decide project vs chitchat

export type RouteLayer = 'docs' | 'fast-model' | 'codex';

export type RouteMeta = {
  route: RouteLayer;
  category: QueryCategory;
  confidence: number;
  reason: string;
  docsScore: number;
  docsMs: number;
  model?: string;
  fastMs?: number;
  codexMs?: number;
};

// ---------------------------------------------------------------------------
// Keyword sets — only for things specific to this CAD project
// ---------------------------------------------------------------------------

// Scene action keywords — indicate the user wants to operate the 3D scene
const TOOL_KEYWORDS = [
  // Chinese
  '選取', '切換', '設定', '刪除', '移動', '旋轉', '縮放',
  '顯示', '隱藏', '格線', '步驟', '復原', '重做', '重置',
  '組裝', '配合', '對齊', '插入', '移除', '儲存', '載入',
  // English
  'select', 'move', 'rotate', 'mate', 'add step', 'remove', 'delete',
  'hide', 'show', 'grid', 'undo', 'redo', 'reset',
  'zoom', 'fit', 'play', 'stop', 'capture', 'assemble', 'preview',
];

// CAD-specific feature names — only match docs when these appear
const DOC_KEYWORDS = [
  'face_projection', 'planar_cluster', 'geometry_aabb', 'object_aabb',
  'extreme_vertices', 'obb_pca',
  'face_flush', 'face_insert', 'edge_to_edge', 'axis_to_axis',
  'anchor method', 'mate mode', 'mate workflow',
  '組裝流程', 'anchor怎麼', 'method怎麼',
];

// Code / repo / debug — needs deep reasoning
const DEEP_KEYWORDS = [
  'debug', 'analyze', 'analyse', 'refactor', 'implement', 'architecture',
  'review', 'git', 'repository', 'codebase', 'source code',
  '分析', '除錯', '重構', '程式碼', '架構', '實作',
];

function containsAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Classifier — anything not matching CAD categories defaults to chitchat
// ---------------------------------------------------------------------------

export function classifyQuery(text: string): QueryCategory {
  if (containsAny(text, DEEP_KEYWORDS)) return 'deep_analysis';
  if (containsAny(text, DOC_KEYWORDS)) return 'doc_lookup';
  if (containsAny(text, TOOL_KEYWORDS)) return 'tool_command';
  // Default: ambiguous — smartProvider will ask LLM classifier to decide
  return 'simple_qa';
}

// ---------------------------------------------------------------------------
// Route decision
// ---------------------------------------------------------------------------

const DOCS_THRESHOLD_DOC_LOOKUP = 2.0;
const CODEX_ENABLED = process.env.SMART_CODEX_ENABLE !== '0';

export function decideRoute(text: string, docsScore: number): Omit<RouteMeta, 'docsMs'> {
  const category = classifyQuery(text);

  if (category === 'deep_analysis') {
    if (CODEX_ENABLED) {
      return { route: 'codex', category, confidence: 0.8, reason: 'deep analysis → codex', docsScore };
    }
    return { route: 'fast-model', category, confidence: 0.65, reason: 'deep analysis (codex disabled) → fast-model', docsScore };
  }

  if (category === 'doc_lookup' && docsScore >= DOCS_THRESHOLD_DOC_LOOKUP) {
    return { route: 'docs', category, confidence: 0.75, reason: `doc_lookup score=${docsScore.toFixed(1)}`, docsScore };
  }

  if (category === 'tool_command') {
    return { route: 'fast-model', category, confidence: 0.9, reason: 'tool command → fast-model', docsScore };
  }

  // simple_qa (default) — smartProvider will run LLM classifier to decide project vs chitchat
  return { route: 'fast-model', category: 'simple_qa', confidence: 0.6, reason: 'ambiguous → LLM classify', docsScore };
}
