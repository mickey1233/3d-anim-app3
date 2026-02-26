/**
 * promptLoader.ts — Loads and caches agent-prompts/ markdown files.
 *
 * Resolves the agent-prompts/ directory relative to this file:
 *   mcp-server/v2/router/ → ../../../../agent-prompts/
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, '../../../../agent-prompts');

let cachedSystemPrompt: string | null = null;

async function readPromptFile(relPath: string): Promise<string> {
  const absPath = path.join(PROMPTS_DIR, relPath);
  try {
    return await readFile(absPath, 'utf-8');
  } catch {
    console.warn(`[promptLoader] Could not read prompt file: ${absPath}`);
    return '';
  }
}

export async function buildSystemPrompt(): Promise<string> {
  if (cachedSystemPrompt !== null) return cachedSystemPrompt;

  const [
    system,
    toolsRef,
    skillMate,
    skillSelection,
    skillGrid,
    skillSteps,
    skillMode,
    skillView,
    skillConversation,
    qaExamples,
  ] = await Promise.all([
    readPromptFile('system.md'),
    readPromptFile('tools/reference.md'),
    readPromptFile('skills/mate.md'),
    readPromptFile('skills/selection.md'),
    readPromptFile('skills/grid.md'),
    readPromptFile('skills/steps.md'),
    readPromptFile('skills/mode.md'),
    readPromptFile('skills/view.md'),
    readPromptFile('skills/conversation.md'),
    readPromptFile('qa/examples.md'),
  ]);

  cachedSystemPrompt = [
    system,
    '---',
    toolsRef,
    '---',
    skillMate,
    '---',
    skillSelection,
    '---',
    skillGrid,
    '---',
    skillSteps,
    '---',
    skillMode,
    '---',
    skillView,
    '---',
    skillConversation,
    '---',
    qaExamples,
  ]
    .filter(Boolean)
    .join('\n\n');

  return cachedSystemPrompt;
}

/** Clear the cache (useful for testing / hot-reload). */
export function clearPromptCache(): void {
  cachedSystemPrompt = null;
}
