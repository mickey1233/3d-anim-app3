/**
 * agentLlm.ts — Multi-model LLM client for the agent router.
 *
 * Env vars:
 *   AGENT_LLM_PROVIDER   = 'gemini' | 'ollama' | 'claude' | 'openai'  (default: 'gemini')
 *   AGENT_LLM_MODEL      = model name override
 *   AGENT_LLM_TIMEOUT_MS = request timeout in ms  (default: 8000)
 *   GEMINI_API_KEY       = Gemini API key
 *   OLLAMA_BASE_URL      = Ollama base URL  (default: http://127.0.0.1:11434)
 *   ANTHROPIC_API_KEY    = Claude API key
 *   OPENAI_API_KEY       = OpenAI API key
 */

type RawToolCall = {
  tool: string;
  args: Record<string, unknown>;
};

type AgentLlmResponse = {
  replyText: string;
  toolCalls: RawToolCall[];
};

const TIMEOUT_MS = Number(process.env.AGENT_LLM_TIMEOUT_MS || 8000);
const PROVIDER = (process.env.AGENT_LLM_PROVIDER || 'gemini').toLowerCase();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.AGENT_LLM_MODEL || 'gemini-1.5-flash';

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.AGENT_LLM_MODEL || 'qwen2.5:7b-instruct';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_MODEL = process.env.AGENT_LLM_MODEL || 'claude-haiku-4-5-20251001';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.AGENT_LLM_MODEL || 'gpt-4o-mini';

function withTimeout(ms: number) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { controller, clear: () => clearTimeout(id) };
}

function extractJsonObject(raw: string): unknown {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function callGemini(systemPrompt: string, userMessage: string): Promise<AgentLlmResponse | null> {
  if (!GEMINI_API_KEY) return null;
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const client = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = client.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: systemPrompt,
  });
  const { controller, clear } = withTimeout(TIMEOUT_MS);
  try {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
    } as any);
    const text = result.response.text();
    if (!text) return null;
    return extractJsonObject(text) as AgentLlmResponse | null;
  } catch {
    return null;
  } finally {
    clear();
  }
}

let lastOllamaHealthAt = 0;
let lastOllamaHealthOk = false;

async function checkOllama(): Promise<boolean> {
  const now = Date.now();
  if (now - lastOllamaHealthAt < 30_000) return lastOllamaHealthOk;
  lastOllamaHealthAt = now;
  const { controller, clear } = withTimeout(900);
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: controller.signal });
    lastOllamaHealthOk = res.ok;
    return lastOllamaHealthOk;
  } catch {
    lastOllamaHealthOk = false;
    return false;
  } finally {
    clear();
  }
}

async function callOllama(systemPrompt: string, userMessage: string): Promise<AgentLlmResponse | null> {
  if (!(await checkOllama())) return null;
  const { controller, clear } = withTimeout(TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        format: 'json',
        options: { temperature: 0.1 },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
    });
    if (!res.ok) return null;
    const payload = await res.json();
    const content = String(payload?.message?.content || '').trim();
    if (!content) return null;
    return extractJsonObject(content) as AgentLlmResponse | null;
  } catch {
    return null;
  } finally {
    clear();
  }
}

async function callClaude(systemPrompt: string, userMessage: string): Promise<AgentLlmResponse | null> {
  if (!ANTHROPIC_API_KEY) return null;
  // @ts-ignore — optional peer dependency, only loaded when provider=claude
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const { controller, clear } = withTimeout(TIMEOUT_MS);
  try {
    const message = await client.messages.create(
      {
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      },
      { signal: controller.signal }
    );
    const block = message.content[0];
    if (!block || block.type !== 'text') return null;
    return extractJsonObject(block.text) as AgentLlmResponse | null;
  } catch {
    return null;
  } finally {
    clear();
  }
}

async function callOpenAI(systemPrompt: string, userMessage: string): Promise<AgentLlmResponse | null> {
  if (!OPENAI_API_KEY) return null;
  // @ts-ignore — optional peer dependency, only loaded when provider=openai
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });
  const { controller, clear } = withTimeout(TIMEOUT_MS);
  try {
    const completion = await client.chat.completions.create(
      {
        model: OPENAI_MODEL,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      },
      { signal: controller.signal }
    );
    const text = completion.choices[0]?.message?.content;
    if (!text) return null;
    return extractJsonObject(text) as AgentLlmResponse | null;
  } catch {
    return null;
  } finally {
    clear();
  }
}

export async function callAgentLlm(
  systemPrompt: string,
  userMessage: string
): Promise<AgentLlmResponse | null> {
  switch (PROVIDER) {
    case 'ollama':
      return callOllama(systemPrompt, userMessage);
    case 'claude':
      return callClaude(systemPrompt, userMessage);
    case 'openai':
      return callOpenAI(systemPrompt, userMessage);
    case 'gemini':
    default:
      return callGemini(systemPrompt, userMessage);
  }
}
