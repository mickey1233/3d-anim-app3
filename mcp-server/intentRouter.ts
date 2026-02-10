/**
 * Intent Router — two-phase classification for user natural-language input.
 *
 * Phase 1: Fast heuristic pre-filter (regex patterns, no LLM call)
 * Phase 2: LLM classification (Gemini / Ollama) — only if Phase 1 is ambiguous
 *
 * Returns structured tool calls ready for execution by the MCP server.
 */

import type { GoogleGenerativeAI } from "@google/generative-ai";

// ── Types ──

export type IntentClass = 'CHAT' | 'TOOL_CALL' | 'MIXED' | 'CLARIFY';

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface IntentResult {
  class: IntentClass;
  confidence: number;
  tool_calls: ToolCall[];
  chat_response?: string | undefined;
  clarification?: string | undefined;
  reasoning?: string | undefined;
}

// ── System Prompt (for LLM classification) ──

const SYSTEM_PROMPT = `You are an AI assistant controlling a 3D CAD assembly studio.
You help users manipulate 3D parts, create assembly animations, and answer questions.

## How You Work
1. Analyze user intent: conversation, tool operation, or both
2. For tool operations, output structured tool calls
3. For conversation, output a natural response

## Available Tools

### Selection
- select_part({ part: "name_or_uuid" }) — Select a part (fuzzy name match)

### Query
- get_scene_state({}) — List all parts and transforms
- get_ui_state({}) — Get UI mode, preview, animation state

### Transform
- move_part({ part, position: [x,y,z], absolute?: bool, preview?: bool }) — Move a part
- rotate_part({ part, axis: "x"|"y"|"z"|[x,y,z], angle: degrees, absolute?: bool, preview?: bool }) — Rotate

### Mate (Face-to-Face Alignment)
- align_faces({ source_part, source_face, target_part, target_face, mode, offset?, flip?, twist_angle?, preview?: bool })
  - mode: "flush" | "insert" | "edge_to_edge" | "axis_to_axis" | "point_to_point" | "planar_slide"
  - faces: "top" | "bottom" | "left" | "right" | "front" | "back" | "center"
  - Use for: "put X on Y", "attach X to Y", "insert X into Y", "mate X to Y"

### Compute (math only, no side effects)
- compute_mate({ source_part, source_face, target_part, target_face, mode, offset?, flip?, twist_angle? })
- compute_twist({ part, axis?, angle?, reference_face?, snap_increment? })

### Preview & Commit
- preview_transform({ part, position?, quaternion?, path?, duration? }) — Show ghost preview
- commit_transform({ part, position?, quaternion?, add_to_sequence?, step_description? }) — Apply
- cancel_preview({}) — Discard preview

### History
- undo({}) — Undo last transform
- redo({}) — Redo

### Mode
- set_interaction_mode({ mode: "move"|"rotate"|"mate" }) — Switch 3D interaction mode

### Animation
- add_animation_step({ part, target_position?, target_quaternion?, duration?, easing?, description })
- play_animation({ mode?: "sequence"|"single_step", step_index? })
- stop_animation({})

### Scene
- reset_scene({}) — Reset all parts
- reset_part({ part }) — Reset one part
- load_model({ url, filename? }) — Load 3D model

### UI
- set_environment({ preset?: string, floor?: "grid"|"reflective"|"none" })

## Face Inference Rules
When user doesn't specify faces, infer from context:
- "put X on Y" / "X 放到 Y 上" → source_face=bottom, target_face=top, mode=flush
- "attach X to side of Y" → source_face=right, target_face=left, mode=flush
- "insert X into Y" / "X 插入 Y" → source_face=bottom, target_face=top, mode=insert
- "mate X bottom to Y top" → explicit faces
- "twist X 45 degrees" → compute_twist then preview+commit

## Error Recovery
- If a part name is ambiguous, ask for clarification
- Auto-infer faces when not specified
- For mate operations, try flush mode first

## Response Format
Output ONLY valid JSON (no markdown fences):
{
  "class": "CHAT" | "TOOL_CALL" | "MIXED",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation",
  "tool_calls": [{ "tool": "tool_name", "args": {...} }, ...],
  "chat_response": "natural language reply (if CHAT or MIXED)"
}`;

// ── Phase 1: Heuristic Pre-Filter ──

const TOOL_PATTERNS: Array<{ pattern: RegExp; buildCalls: (input: string, lower: string) => ToolCall[] | null }> = [
  // Undo / Redo
  { pattern: /^(undo|復原|撤銷|撤消)\b/i, buildCalls: () => [{ tool: 'undo', args: {} }] },
  { pattern: /^(redo|重做)\b/i, buildCalls: () => [{ tool: 'redo', args: {} }] },

  // Reset
  { pattern: /^(reset|clear|wipe|restart|重設|重置|清除)\s*(scene|all|everything|全部)?$/i,
    buildCalls: () => [{ tool: 'reset_scene', args: {} }] },
  { pattern: /^reset\s+(.+)/i,
    buildCalls: (_input, lower) => {
      const m = lower.match(/^reset\s+(.+)/);
      return m ? [{ tool: 'reset_part', args: { part: m[1]!.trim() } }] : null;
    }},

  // Play / Stop
  { pattern: /^(play|start|run|播放)\s*(animation|sequence|動畫)?$/i,
    buildCalls: () => [{ tool: 'play_animation', args: {} }] },
  { pattern: /^(stop|pause|停止)\s*(animation|sequence|動畫)?$/i,
    buildCalls: () => [{ tool: 'stop_animation', args: {} }] },

  // Load
  { pattern: /^(load|open|import|載入)\s*(demo|example|範例)?/i,
    buildCalls: () => [{ tool: 'load_model', args: { url: '/test_model.glb', filename: 'demo_model.glb' } }] },

  // Mode switching
  { pattern: /^(mode|switch|切換)\s*(move|rotate|mate|移動|旋轉|配對)/i,
    buildCalls: (_input, lower) => {
      let mode = 'move';
      if (/rotate|旋轉/.test(lower)) mode = 'rotate';
      else if (/mate|配對/.test(lower)) mode = 'mate';
      return [{ tool: 'set_interaction_mode', args: { mode } }];
    }},

  // Select
  { pattern: /^(select|pick|choose|選擇|選取)\s+(.+)/i,
    buildCalls: (input) => {
      const m = input.match(/^(?:select|pick|choose|選擇|選取)\s+(.+)/i);
      return m ? [{ tool: 'select_part', args: { part: m[1]!.trim() } }] : null;
    }},

  // Environment
  { pattern: /^(set\s+)?environment\s+(warehouse|city|sunset|studio|night|apartment|forest|dawn|lobby|park)/i,
    buildCalls: (input) => {
      const m = input.match(/(warehouse|city|sunset|studio|night|apartment|forest|dawn|lobby|park)/i);
      return m ? [{ tool: 'set_environment', args: { preset: m[1]!.toLowerCase() } }] : null;
    }},
];

// Patterns that indicate CHAT (no tool call)
const CHAT_PATTERNS = [
  /^(hi|hello|hey|thanks|thank you|你好|謝謝)\b/i,
  /^(what is|how does|explain|why|can you|help|tell me|describe|what are)\b/i,
  /^(who|where|when)\b/i,
];

// Patterns that definitely need LLM classification (complex tool operations)
const COMPLEX_TOOL_PATTERNS = [
  /\b(move|put|place|align|mate|attach|insert|裝|放|貼|對齊)\b.*\b(to|on|onto|into|上|下|裡)\b/i,
  /\b(twist|rotate|turn|旋轉|扭轉)\b.*\b(part|Part_|\d+\s*deg)/i,
  /\b(add|record|save|新增|記錄)\s*(step|animation|步驟|動畫)/i,
];

/**
 * Phase 1: Fast heuristic classification.
 * Returns IntentResult if confident, null if ambiguous (needs LLM).
 */
export function quickClassify(input: string): IntentResult | null {
  const lower = input.toLowerCase().trim();

  // Check simple tool patterns first
  for (const { pattern, buildCalls } of TOOL_PATTERNS) {
    if (pattern.test(lower)) {
      const calls = buildCalls(input, lower);
      if (calls) {
        return {
          class: 'TOOL_CALL',
          confidence: 0.95,
          tool_calls: calls,
          reasoning: `Matched heuristic pattern: ${pattern.source}`,
        };
      }
    }
  }

  // Check definite chat patterns
  for (const pattern of CHAT_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        class: 'CHAT',
        confidence: 0.85,
        tool_calls: [],
        reasoning: `Matched chat pattern: ${pattern.source}`,
      };
    }
  }

  // Check complex tool patterns (need LLM for argument extraction)
  for (const pattern of COMPLEX_TOOL_PATTERNS) {
    if (pattern.test(lower)) {
      return null; // Send to LLM
    }
  }

  // Very short input with a question mark → probably chat
  if (lower.endsWith('?') && lower.length < 80) {
    return {
      class: 'CHAT',
      confidence: 0.7,
      tool_calls: [],
      reasoning: 'Short question, likely conversational',
    };
  }

  // Default: ambiguous, needs LLM
  return null;
}

// ── Phase 2: LLM Classification ──

/**
 * Call LLM to classify intent and extract tool calls.
 * Uses Gemini if available, falls back to Ollama, then heuristic.
 */
export async function llmClassify(
  input: string,
  partNames: string[],
  genAI: GoogleGenerativeAI | null,
): Promise<IntentResult> {
  const contextBlock = `Current Parts in Scene: ${JSON.stringify(partNames)}`;
  const userBlock = `User Input: "${input}"`;

  // Try Gemini first
  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-pro" });
      const prompt = `${SYSTEM_PROMPT}\n\n${contextBlock}\n\n${userBlock}`;
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(text) as Record<string, unknown>;

      return {
        class: (parsed['class'] as IntentClass) || 'TOOL_CALL',
        confidence: (parsed['confidence'] as number) || 0.8,
        tool_calls: (parsed['tool_calls'] as ToolCall[]) || [],
        chat_response: parsed['chat_response'] as string | undefined,
        reasoning: parsed['reasoning'] as string | undefined,
      };
    } catch (e) {
      console.error("[IntentRouter] Gemini LLM failed:", e);
    }
  }

  // Try Ollama
  try {
    const host = process.env['OLLAMA_HOST'] || 'http://localhost:11434';
    const ollamaModel = process.env['OLLAMA_CHAT_MODEL'] || process.env['OLLAMA_MODEL'] || 'qwen3:8b';

    const prompt = `${SYSTEM_PROMPT}\n\n${contextBlock}\n\n${userBlock}`;
    const res = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        prompt,
        stream: false,
        options: { temperature: 0, num_predict: 500 },
      }),
    });

    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      const rawText = (data['response'] as string || '').trim();
      // Extract JSON from possible markdown wrapping
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        return {
          class: (parsed['class'] as IntentClass) || 'TOOL_CALL',
          confidence: (parsed['confidence'] as number) || 0.7,
          tool_calls: (parsed['tool_calls'] as ToolCall[]) || [],
          chat_response: parsed['chat_response'] as string | undefined,
          reasoning: parsed['reasoning'] as string | undefined,
        };
      }
    }
  } catch (e) {
    console.error("[IntentRouter] Ollama LLM failed:", e);
  }

  // Final fallback: return CHAT with apology
  return {
    class: 'CHAT',
    confidence: 0.3,
    tool_calls: [],
    chat_response: "I'm not sure what you'd like to do. Try commands like 'move Part1 to Part2', 'undo', 'reset', or ask me about the scene.",
    reasoning: 'Both LLM providers failed, returning generic help',
  };
}

// ── Combined Router ──

/**
 * Full two-phase intent routing.
 * Returns IntentResult with tool_calls ready for execution.
 */
export async function routeIntent(
  input: string,
  partNames: string[],
  genAI: GoogleGenerativeAI | null,
): Promise<IntentResult> {
  // Phase 1: Fast heuristic
  const quick = quickClassify(input);
  if (quick) {
    console.log(`[IntentRouter] Phase 1 match: ${quick.class} (${quick.confidence}) — ${quick.reasoning}`);
    return quick;
  }

  // Phase 2: LLM classification
  console.log("[IntentRouter] Phase 1 ambiguous, calling LLM...");
  const llmResult = await llmClassify(input, partNames, genAI);
  console.log(`[IntentRouter] Phase 2 result: ${llmResult.class} (${llmResult.confidence}) — ${llmResult.reasoning}`);
  return llmResult;
}
