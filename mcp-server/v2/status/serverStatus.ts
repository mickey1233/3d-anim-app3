import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type ProviderName = 'gemini' | 'ollama' | 'mock' | 'none';
type RouterProviderName = 'agent' | 'mock' | 'codex' | 'openai' | 'smart';

export type ServerStatus = {
  ts: number;
  router: {
    providerEnv: string;
    providerResolved: RouterProviderName;
    llmEnabled: boolean;
  };
  codex: {
    loggedIn: boolean;
    authMode: string;
    apiKeyPresent: boolean;
    model: string;
    cliAvailable: boolean;
    authFile: string;
    smartCodexEnabled: boolean;
  };
  llm: {
    providerEnv: string;
    providerResolved: ProviderName;
    model: string;
    geminiKeyPresent: boolean;
    ollamaBaseUrl: string;
    ollamaReachable: boolean;
    ollamaModelsCount: number;
    ollamaModelRequested: string;
    ollamaModelAvailable: boolean;
  };
  vlm: {
    providerEnv: string;
    providerResolved: ProviderName;
    model: string;
    ollamaModelRequested: string;
    ollamaModelAvailable: boolean;
  };
  web: {
    enabled: boolean;
  };
};

const DEFAULT_TIMEOUT_MS = 900;
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');

let lastOllamaHealthCheckAt = 0;
let lastOllamaHealth = false;
let lastOllamaModelNames: string[] = [];

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

function withTimeout(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeout };
}

async function checkOllamaReachable() {
  const now = Date.now();
  if (now - lastOllamaHealthCheckAt < 15_000) return lastOllamaHealth;
  lastOllamaHealthCheckAt = now;
  const { controller, timeout } = withTimeout(DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: controller.signal });
    if (!res.ok) {
      lastOllamaHealth = false;
      lastOllamaModelNames = [];
      return false;
    }
    const payload = await res.json().catch(() => null);
    lastOllamaModelNames = Array.isArray(payload?.models)
      ? (payload.models as any[])
          .map((model: any) => (typeof model?.name === 'string' ? model.name : null))
          .filter(Boolean)
      : [];
    lastOllamaHealth = true;
    return lastOllamaHealth;
  } catch {
    lastOllamaHealth = false;
    lastOllamaModelNames = [];
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveRouterProvider(): RouterProviderName {
  const provider = String(process.env.ROUTER_PROVIDER || 'mock')
    .trim()
    .toLowerCase();
  if (provider === 'mock') return 'mock';
  if (provider === 'agent') return 'agent';
  if (provider === 'codex') return 'codex';
  if (provider === 'openai') return 'openai';
  if (provider === 'smart') return 'smart';
  return 'mock';
}

function checkCodexStatus(): ServerStatus['codex'] {
  const authFile = path.join(os.homedir(), '.codex', 'auth.json');
  let loggedIn = false;
  let authMode = 'none';
  try {
    const raw = fs.readFileSync(authFile, 'utf8');
    const data = JSON.parse(raw);
    authMode = String(data?.auth_mode || 'unknown');
    loggedIn = authMode === 'chatgpt'
      ? !!(data?.tokens)
      : !!(data?.OPENAI_API_KEY || data?.api_key || data?.tokens);
  } catch { /* auth.json missing or unreadable */ }

  // Also consider logged in if OPENAI_API_KEY env var is set (API key auth)
  const apiKeyPresent = !!(process.env.OPENAI_API_KEY || '').trim();
  if (apiKeyPresent && !loggedIn) {
    loggedIn = true;
    authMode = 'api_key';
  }

  // Check if codex CLI binary is available in PATH
  let cliAvailable = false;
  try {
    execSync('codex --version', { stdio: 'ignore', timeout: 2000 });
    cliAvailable = true;
  } catch { /* codex not in PATH */ }

  const smartCodexEnabled = process.env.SMART_CODEX_ENABLE === '1';
  const model = (process.env.CODEX_MODEL || 'codex-mini-latest').trim();

  return { loggedIn, authMode, apiKeyPresent, model, cliAvailable, authFile, smartCodexEnabled };
}

function resolveModelForProvider(params: {
  provider: ProviderName;
  ollamaModelEnv?: string;
  geminiModelEnv?: string;
  defaultOllamaModel: string;
  defaultGeminiModel: string;
}) {
  if (params.provider === 'ollama') return params.ollamaModelEnv || params.defaultOllamaModel;
  if (params.provider === 'gemini') return params.geminiModelEnv || params.defaultGeminiModel;
  if (params.provider === 'none') return 'none';
  return 'mock';
}

function resolveLlmProvider(llmEnabled: boolean, geminiKeyPresent: boolean, ollamaModelAvailable: boolean): ProviderName {
  if (!llmEnabled) return 'none';
  const envProvider = String(process.env.ROUTER_LLM_PROVIDER || 'auto')
    .trim()
    .toLowerCase();
  if (envProvider === 'gemini') return geminiKeyPresent ? 'gemini' : 'mock';
  if (envProvider === 'ollama') return ollamaModelAvailable ? 'ollama' : 'mock';
  if (envProvider === 'auto') {
    if (geminiKeyPresent) return 'gemini';
    if (ollamaModelAvailable) return 'ollama';
    return 'mock';
  }
  return 'mock';
}

function resolveVlmProvider(geminiKeyPresent: boolean, ollamaModelAvailable: boolean): ProviderName {
  const envProvider = String(process.env.V2_VLM_PROVIDER || process.env.VLM_PROVIDER || 'auto')
    .trim()
    .toLowerCase();
  if (envProvider === 'none' || envProvider === 'off') return 'none';
  if (envProvider === 'mock') return 'mock';
  if (envProvider === 'gemini') return geminiKeyPresent ? 'gemini' : 'mock';
  if (envProvider === 'ollama') return ollamaModelAvailable ? 'ollama' : 'mock';
  if (envProvider === 'auto') {
    if (geminiKeyPresent) return 'gemini';
    if (ollamaModelAvailable) return 'ollama';
    return 'mock';
  }
  return 'mock';
}

export async function getServerStatus(): Promise<ServerStatus> {
  const geminiKeyPresent = !!(process.env.GEMINI_API_KEY || '').trim();
  const llmEnabled = process.env.ROUTER_LLM_ENABLE !== '0';

  const routerProviderResolved = resolveRouterProvider();
  const llmOllamaModelRequested = process.env.ROUTER_LLM_MODEL || process.env.OLLAMA_MODEL || 'qwen3:30b';
  const vlmOllamaModelRequested = process.env.VLM_MATE_MODEL || process.env.OLLAMA_MODEL || 'qwen3.5:27b';

  const ollamaReachable = await checkOllamaReachable();
  const ollamaModelsCount = lastOllamaModelNames.length;
  const llmOllamaModelAvailable = ollamaReachable && isOllamaModelAvailable(llmOllamaModelRequested, lastOllamaModelNames);
  const vlmOllamaModelAvailable = ollamaReachable && isOllamaModelAvailable(vlmOllamaModelRequested, lastOllamaModelNames);

  const llmProviderResolved = resolveLlmProvider(llmEnabled, geminiKeyPresent, llmOllamaModelAvailable);
  const vlmProviderResolved = resolveVlmProvider(geminiKeyPresent, vlmOllamaModelAvailable);

  const routerLlmModelEnv = process.env.ROUTER_LLM_MODEL;
  const vlmMateModelEnv = process.env.VLM_MATE_MODEL;
  const geminiModelEnv = process.env.GEMINI_MODEL || routerLlmModelEnv || vlmMateModelEnv;

  const llmModel = resolveModelForProvider({
    provider: llmProviderResolved,
    ollamaModelEnv: llmOllamaModelRequested,
    geminiModelEnv,
    defaultOllamaModel: 'qwen3:30b',
    defaultGeminiModel: 'gemini-1.5-flash',
  });

  const vlmModel = resolveModelForProvider({
    provider: vlmProviderResolved,
    ollamaModelEnv: vlmOllamaModelRequested,
    geminiModelEnv: process.env.GEMINI_MODEL || vlmMateModelEnv,
    defaultOllamaModel: 'qwen3.5:27b',
    defaultGeminiModel: 'gemini-1.5-flash',
  });

  return {
    ts: Date.now(),
    router: {
      providerEnv: String(process.env.ROUTER_PROVIDER || 'mock'),
      providerResolved: routerProviderResolved,
      llmEnabled,
    },
    codex: checkCodexStatus(),
    llm: {
      providerEnv: String(process.env.ROUTER_LLM_PROVIDER || 'auto'),
      providerResolved: llmProviderResolved,
      model: llmModel,
      geminiKeyPresent,
      ollamaBaseUrl: OLLAMA_BASE_URL,
      ollamaReachable,
      ollamaModelsCount,
      ollamaModelRequested: llmOllamaModelRequested,
      ollamaModelAvailable: llmOllamaModelAvailable,
    },
    vlm: {
      providerEnv: String(process.env.V2_VLM_PROVIDER || process.env.VLM_PROVIDER || 'auto'),
      providerResolved: vlmProviderResolved,
      model: vlmModel,
      ollamaModelRequested: vlmOllamaModelRequested,
      ollamaModelAvailable: vlmOllamaModelAvailable,
    },
    web: {
      enabled: process.env.ROUTER_WEB_ENABLE === '1',
    },
  };
}
