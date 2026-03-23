/**
 * docsRetrieval.ts
 *
 * BM25-lite keyword search over the agent knowledge docs.
 * Chunks each .md file by headings and scores chunks against a query.
 * Used by smartProvider (Layer 1) to answer doc-lookup queries without LLM.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'agent');

export type DocChunk = {
  file: string;
  heading: string;
  text: string;
  score: number;
};

// ---------------------------------------------------------------------------
// Doc loading + chunking
// ---------------------------------------------------------------------------

function loadAllDocs(dir: string): { file: string; content: string }[] {
  const out: { file: string; content: string }[] = [];

  function walk(base: string, rel = '') {
    const full = path.join(base, rel);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(full, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const next = path.join(rel, e.name);
      if (e.isDirectory()) {
        walk(base, next);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        try {
          out.push({ file: next.replace(/\\/g, '/'), content: fs.readFileSync(path.join(base, next), 'utf8') });
        } catch { /* skip */ }
      }
    }
  }

  walk(dir);
  return out;
}

function chunkDoc(file: string, content: string): Omit<DocChunk, 'score'>[] {
  const chunks: Omit<DocChunk, 'score'>[] = [];
  const lines = content.split('\n');
  let heading = path.basename(file, '.md');
  let buffer: string[] = [];

  function flush() {
    const text = buffer.join('\n').trim();
    if (text.length > 30) chunks.push({ file, heading, text });
    buffer = [];
  }

  for (const line of lines) {
    const m = /^#{1,4}\s+(.+)/.exec(line);
    if (m) {
      flush();
      heading = m[1].trim();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return chunks;
}

// ---------------------------------------------------------------------------
// BM25-lite scoring
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  // Handle both CJK characters (each is a token) and ASCII words
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  while (i < lower.length) {
    const cp = lower.codePointAt(i) ?? 0;
    if (cp >= 0x4e00 && cp <= 0x9fff) {
      // CJK character — single token
      tokens.push(lower[i]);
      i += 1;
    } else if (/\w/.test(lower[i])) {
      let j = i;
      while (j < lower.length && /\w/.test(lower[j])) j++;
      const word = lower.slice(i, j);
      if (word.length >= 2) tokens.push(word);
      i = j;
    } else {
      i += 1;
    }
  }
  return tokens;
}

function bm25(queryTokens: string[], docTokens: string[], avgDocLen: number): number {
  const k1 = 1.5, b = 0.75;
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  let score = 0;
  const dl = docTokens.length || 1;
  for (const qt of queryTokens) {
    const f = tf.get(qt) ?? 0;
    if (f === 0) continue;
    score += (f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgDocLen)));
  }
  return score;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type ChunkCache = { dir: string; chunks: Omit<DocChunk, 'score'>[] };
let _cache: ChunkCache | null = null;

function getChunks(): Omit<DocChunk, 'score'>[] {
  const dir = process.env.ROUTER_AGENT_DIR || DEFAULT_AGENT_DIR;
  if (_cache?.dir === dir) return _cache.chunks;
  const docs = loadAllDocs(dir);
  const chunks = docs.flatMap((d) => chunkDoc(d.file, d.content));
  _cache = { dir, chunks };
  return chunks;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function retrieveDocs(query: string, topK = 3): DocChunk[] {
  const chunks = getChunks();
  if (chunks.length === 0) return [];
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const avgLen = chunks.reduce((s, c) => s + tokenize(c.text).length, 0) / chunks.length || 1;
  const scored: DocChunk[] = chunks.map((c) => ({
    ...c,
    score: bm25(qTokens, tokenize(c.heading + ' ' + c.text), avgLen),
  }));
  return scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** Checks whether docs contain a high-confidence answer for the query. */
export function docsConfidence(query: string): number {
  const chunks = retrieveDocs(query, 1);
  return chunks[0]?.score ?? 0;
}
