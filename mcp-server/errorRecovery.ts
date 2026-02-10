/**
 * Error Recovery — wraps tool execution with auto-recovery strategies.
 *
 * - NORMALS_SAME_DIRECTION → auto-retry with flip=true
 * - PART_NOT_FOUND → fuzzy match suggestion
 * - ANIMATION_PLAYING → warn user
 * - Generic errors → retry up to MAX_RETRIES with modified args
 */

import levenshtein from "fast-levenshtein";
import type { ToolCall } from "./intentRouter.js";

const MAX_RETRIES = 2;

export interface ExecutionResult {
  ok: boolean;
  tool: string;
  result?: unknown;
  error?: string | undefined;
  recovery?: string | undefined;
  retries: number;
}

type SendToAppFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * Fuzzy-match a part name against known parts.
 * Returns the best match if within threshold, null otherwise.
 */
export function fuzzyMatchPart(query: string, partNames: string[], thresholdRatio = 0.4): string | null {
  if (!query) return null;
  let bestMatch: string | null = null;
  let minDist = Infinity;

  for (const cand of partNames) {
    const dist = levenshtein.get(query.toLowerCase(), cand.toLowerCase());
    const maxEdits = Math.max(1, Math.ceil(cand.length * thresholdRatio));
    if (dist < minDist && dist <= maxEdits) {
      minDist = dist;
      bestMatch = cand;
    }
  }

  // Also try substring match
  if (!bestMatch) {
    const lower = query.toLowerCase();
    for (const cand of partNames) {
      if (cand.toLowerCase().includes(lower) || lower.includes(cand.toLowerCase())) {
        return cand;
      }
    }
  }

  return bestMatch;
}

/**
 * Execute a single tool call with error recovery.
 */
async function executeWithRecovery(
  call: ToolCall,
  sendToApp: SendToAppFn,
  partNames: string[],
  attempt: number = 0,
): Promise<ExecutionResult> {
  try {
    // Pre-execution: fuzzy-match part names in args
    const fixedArgs = resolvePartNames(call.args, partNames);
    const result = await sendToApp(call.tool, fixedArgs);
    return { ok: true, tool: call.tool, result, retries: attempt };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    const msg = error.message;
    const code = (error as any).code as string | undefined;

    console.warn(`[ErrorRecovery] Tool "${call.tool}" failed (attempt ${attempt + 1}): ${msg}`);

    if (attempt >= MAX_RETRIES) {
      return { ok: false, tool: call.tool, error: msg, retries: attempt };
    }

    // ── Auto-recovery strategies ──

    // 1. NORMALS_SAME_DIRECTION → retry with flip=true
    if (code === 'NORMALS_SAME_DIRECTION' || msg.includes('same direction') || msg.includes('NORMALS_SAME_DIRECTION')) {
      console.log("[ErrorRecovery] Auto-flipping normals...");
      const newArgs = { ...call.args, flip: true };
      return executeWithRecovery(
        { tool: call.tool, args: newArgs },
        sendToApp, partNames, attempt + 1,
      );
    }

    // 2. PART_NOT_FOUND → try fuzzy match
    if (code === 'PART_NOT_FOUND' || msg.includes('Part not found') || msg.includes('not found')) {
      const partArg = findPartArgInError(msg, call.args);
      if (partArg) {
        const match = fuzzyMatchPart(partArg.value, partNames);
        if (match && match !== partArg.value) {
          console.log(`[ErrorRecovery] Fuzzy-matched "${partArg.value}" → "${match}"`);
          const newArgs = { ...call.args, [partArg.key]: match };
          return executeWithRecovery(
            { tool: call.tool, args: newArgs },
            sendToApp, partNames, attempt + 1,
          );
        }
      }
    }

    // 3. NO_PREVIEW → silently skip cancel_preview
    if ((code === 'NO_PREVIEW' || msg.includes('No active preview')) && call.tool === 'cancel_preview') {
      return { ok: true, tool: call.tool, result: { cancelled: false }, retries: attempt, recovery: 'No preview active, skipped' };
    }

    // 4. ANIMATION_PLAYING → inform user
    if (code === 'ANIMATION_PLAYING' || msg.includes('animation is playing')) {
      return {
        ok: false,
        tool: call.tool,
        error: 'Animation is currently playing. Stop it first with "stop animation".',
        recovery: 'ANIMATION_PLAYING',
        retries: attempt,
      };
    }

    // No recovery strategy available
    return { ok: false, tool: call.tool, error: msg, retries: attempt };
  }
}

/**
 * Execute a sequence of tool calls with error recovery.
 */
export async function executeToolCalls(
  calls: ToolCall[],
  sendToApp: SendToAppFn,
  partNames: string[],
): Promise<{ results: ExecutionResult[]; summary: string }> {
  const results: ExecutionResult[] = [];
  const summaryParts: string[] = [];

  for (const call of calls) {
    const result = await executeWithRecovery(call, sendToApp, partNames);
    results.push(result);

    if (result.ok) {
      if (result.recovery) {
        summaryParts.push(`${call.tool}: ${result.recovery}`);
      } else if (result.retries > 0) {
        summaryParts.push(`${call.tool}: succeeded after auto-recovery`);
      } else {
        summaryParts.push(`${call.tool}: done`);
      }
    } else {
      summaryParts.push(`${call.tool}: failed — ${result.error}`);
      // Stop executing remaining calls if one fails critically
      if (!isRecoverable(result)) break;
    }
  }

  const allOk = results.every((r) => r.ok);
  const summary = allOk
    ? `Completed ${results.length} action(s). ${summaryParts.join('. ')}`
    : `Partially completed. ${summaryParts.join('. ')}`;

  return { results, summary };
}

// ── Helpers ──

/** Try to resolve part names in args to exact matches using fuzzy matching. */
function resolvePartNames(args: Record<string, unknown>, partNames: string[]): Record<string, unknown> {
  const partKeys = ['part', 'source_part', 'target_part', 'source', 'target'];
  const fixed = { ...args };

  for (const key of partKeys) {
    const val = fixed[key];
    if (typeof val === 'string' && partNames.length > 0) {
      // Check if it's already an exact match
      if (partNames.some((p) => p.toLowerCase() === val.toLowerCase())) continue;

      const match = fuzzyMatchPart(val, partNames);
      if (match) {
        console.log(`[ErrorRecovery] Pre-resolved "${val}" → "${match}" for arg "${key}"`);
        fixed[key] = match;
      }
    }
  }

  return fixed;
}

/** Extract part name from error message and find matching arg key. */
function findPartArgInError(
  errorMsg: string,
  args: Record<string, unknown>,
): { key: string; value: string } | null {
  const partKeys = ['part', 'source_part', 'target_part', 'source', 'target'];
  const quotedMatch = errorMsg.match(/"([^"]+)"/);
  const errorPart = quotedMatch ? quotedMatch[1] : null;

  for (const key of partKeys) {
    const val = args[key];
    if (typeof val === 'string') {
      if (errorPart && val.toLowerCase() === errorPart.toLowerCase()) {
        return { key, value: val };
      }
    }
  }

  // Return first string part arg if no match found
  for (const key of partKeys) {
    const val = args[key];
    if (typeof val === 'string') return { key, value: val };
  }

  return null;
}

/** Check if a failed result is recoverable (non-critical). */
function isRecoverable(result: ExecutionResult): boolean {
  return result.recovery === 'ANIMATION_PLAYING' || result.error?.includes('No active preview') === true;
}
