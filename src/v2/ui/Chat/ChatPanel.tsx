import React from 'react';
import { Send, Sparkles } from 'lucide-react';
import { connectV2Client, v2Client } from '../../network/client';
import { useV2Store } from '../../store/store';
import { useCommandRunner } from '../CommandBar/useCommandRunner';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

export function ChatPanel() {
  const [value, setValue] = React.useState('');
  const [statusLoading, setStatusLoading] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [pendingSince, setPendingSince] = React.useState<number | null>(null);
  const [pendingTick, setPendingTick] = React.useState(0);
  const [lastLatencyMs, setLastLatencyMs] = React.useState<number | null>(null);
  const [lastRouteMeta, setLastRouteMeta] = React.useState<{
    route: string; category: string; model?: string; docsMs: number; fastMs?: number; codexMs?: number;
  } | null>(null);
  const messages = useV2Store((s) => s.chat.messages);
  const appendChatMessage = useV2Store((s) => s.appendChatMessage);
  const parts = useV2Store((s) => s.parts);
  const assemblyGroups = useV2Store((s) => s.assemblyGroups);
  const cadFileName = useV2Store((s) => s.cadFileName);
  const steps = useV2Store((s) => s.steps);
  const selectionPartId = useV2Store((s) => s.selection.partId);
  const interactionMode = useV2Store((s) => s.interaction.mode);
  const getPartTransform = useV2Store((s) => s.getPartTransform);
  const wsConnected = useV2Store((s) => s.connection.wsConnected);
  const wsError = useV2Store((s) => s.connection.wsError);
  const serverStatus = useV2Store((s) => s.connection.serverStatus);
  const setServerStatus = useV2Store((s) => s.setServerStatus);
  const { helpText } = useCommandRunner();

  const refreshServerStatus = React.useCallback(async () => {
    if (!wsConnected) return;
    setStatusLoading(true);
    try {
      const status: any = await v2Client.request('server_status');
      setServerStatus(status);
    } catch {
      setServerStatus(undefined);
    } finally {
      setStatusLoading(false);
    }
  }, [setServerStatus, wsConnected]);

  const appendMessage = React.useCallback(
    (role: ChatMessage['role'], text: string) => {
      appendChatMessage({ role, text });
    },
    [appendChatMessage]
  );

  const send = React.useCallback(async () => {
    if (sending || !value.trim()) return;
    const text = value.trim();
    setValue('');
    appendMessage('user', text);

    if (text === '/help' || text === 'help') {
      appendMessage('assistant', helpText);
      return;
    }

    if (!wsConnected) {
      appendMessage('assistant', 'Router error: WS not connected');
      return;
    }

    const ctx = {
      cadFileName: cadFileName || null,
      stepCount: steps.list.length,
      currentStepId: steps.currentStepId,
      selectionPartId,
      interactionMode,
      parts: parts.order.map((id) => {
        const transform = getPartTransform(id);
        const scale = transform?.scale || [1, 1, 1];
        return {
          id,
          name: parts.byId[id]?.name || id,
          position: transform?.position,
          bboxSize: [Math.abs(scale[0]), Math.abs(scale[1]), Math.abs(scale[2])] as [number, number, number],
        };
      }),
      groups: assemblyGroups.order
        .map((id) => assemblyGroups.byId[id])
        .filter(Boolean)
        .map((g) => ({ id: g.id, name: g.name, partIds: g.partIds })),
      steps: steps.list.map((s, i) => ({ id: s.id, index: i, label: s.label })),
    };
    try {
      const startedAt = performance.now();
      setSending(true);
      setPendingTick(0);
      setPendingSince(Date.now());
      const res: any = await v2Client.request('router_execute', { text, context: ctx }, { timeoutMs: 120_000 });
      const reportedMs = Number(res?.meta?.timings?.totalMs);
      const measuredMs = Math.round(performance.now() - startedAt);
      setLastLatencyMs(Number.isFinite(reportedMs) ? Math.max(0, Math.floor(reportedMs)) : measuredMs);
      const rm = res?.meta?.routeMeta;
      if (rm) {
        setLastRouteMeta({
          route: String(rm.route ?? ''),
          category: String(rm.category ?? ''),
          ...(rm.model ? { model: String(rm.model) } : {}),
          docsMs: Number(rm.docsMs ?? 0),
          ...(rm.fastMs != null ? { fastMs: Number(rm.fastMs) } : {}),
          ...(rm.codexMs != null ? { codexMs: Number(rm.codexMs) } : {}),
        });
      } else {
        setLastRouteMeta(null);
      }
      const toolCount = res?.trace?.toolCalls?.length ?? 0;
      const reply =
        res?.replyText ||
        (toolCount > 0
          ? `已執行 ${toolCount} 個工具。`
          : '我聽到了。你可以直接用自然句子說你想操作的功能，我會嘗試自動執行。');
      appendMessage('assistant', reply);
    } catch (e: any) {
      const rawMessage = String(e?.message || 'unknown');
      const timeoutLike = rawMessage.includes('timeout');
      const message = timeoutLike
        ? 'Router 回應逾時，請重試（可先問簡短問題，避免第一次載入過慢）。'
        : `Router error: ${rawMessage}`;
      appendMessage('assistant', message);
    } finally {
      setSending(false);
      setPendingSince(null);
    }
  }, [
    appendMessage,
    cadFileName,
    getPartTransform,
    helpText,
    interactionMode,
    parts,
    selectionPartId,
    steps.currentStepId,
    steps.list.length,
    value,
    wsConnected,
    sending,
  ]);

  const pendingElapsedSec = React.useMemo(() => {
    if (pendingSince == null) return null;
    return Math.max(0, Math.floor((Date.now() - pendingSince) / 1000));
  }, [pendingSince, pendingTick]);

  React.useEffect(() => {
    if (!sending) return () => {};
    const interval = window.setInterval(() => setPendingTick((value) => value + 1), 1000);
    return () => window.clearInterval(interval);
  }, [sending]);

  React.useEffect(() => {
    if (!wsConnected) return () => {};
    void refreshServerStatus();
    const interval = window.setInterval(() => void refreshServerStatus(), 30_000);
    return () => window.clearInterval(interval);
  }, [refreshServerStatus, wsConnected]);

  const [statusExpanded, setStatusExpanded] = React.useState(false);

  const modelBadgeLabel = React.useMemo(() => {
    if (!serverStatus) return null;
    const router = serverStatus.router?.providerResolved;
    const codex = serverStatus.codex;
    if (router === 'codex' || router === 'openai') {
      if (codex?.loggedIn) return { text: 'Codex ✓', ok: true };
      if (codex?.cliAvailable) return { text: 'Codex (not logged in)', ok: false };
      return { text: 'Codex (not set up)', ok: false };
    }
    const provider = serverStatus.llm?.providerResolved;
    const model = serverStatus.llm?.model;
    if (!provider) return null;
    if (provider === 'mock') return { text: 'LLM: mock', ok: false };
    if (provider === 'none') return { text: 'LLM: off', ok: false };
    return { text: model ? `LLM: ${provider}/${model}` : `LLM: ${provider}`, ok: true };
  }, [serverStatus]);

  const codexBadge = React.useMemo(() => {
    const codex = serverStatus?.codex;
    if (!codex) return null;
    if (codex.loggedIn) return { text: `Codex SDK ✓ (${codex.authMode})`, ok: true };
    if (codex.apiKeyPresent) return { text: 'Codex SDK ✓ (api_key)', ok: true };
    return { text: 'Codex SDK ✗', ok: false };
  }, [serverStatus]);

  const statusLines = React.useMemo(() => {
    if (!serverStatus) return [];
    const codex = serverStatus.codex;
    const lines: { label: string; value: string; warn?: boolean }[] = [];
    lines.push({ label: 'Router', value: `${serverStatus.router?.providerResolved || '?'} (env=${serverStatus.router?.providerEnv || 'n/a'})` });
    if (codex) {
      const loggedIn = codex.loggedIn || codex.apiKeyPresent;
      lines.push({ label: 'Codex SDK', value: loggedIn ? `✓ logged in (${codex.authMode})` : '✗ not logged in', warn: !loggedIn });
      lines.push({ label: 'Codex model', value: codex.model || 'codex-mini-latest' });
      lines.push({ label: 'Codex anchor verify', value: 'enabled (fallback after Ollama)' });
      lines.push({ label: 'Smart Codex', value: codex.smartCodexEnabled ? 'enabled (Layer 3)' : 'disabled', warn: !codex.smartCodexEnabled });
      lines.push({ label: 'Codex CLI', value: codex.cliAvailable ? 'available' : 'not found in PATH', warn: !codex.cliAvailable });
      if (!loggedIn) lines.push({ label: '→', value: 'set OPENAI_API_KEY or run: codex login', warn: true });
    }
    lines.push({ label: 'LLM', value: `${serverStatus.llm?.providerResolved || '?'} / ${serverStatus.llm?.model || 'n/a'}` });
    lines.push({ label: 'VLM', value: `${serverStatus.vlm?.providerResolved || '?'} / ${serverStatus.vlm?.model || 'n/a'}` });
    lines.push({
      label: 'Ollama',
      value: serverStatus.llm?.ollamaReachable
        ? `reachable (${serverStatus.llm.ollamaModelsCount} models)`
        : 'not reachable',
      warn: !serverStatus.llm?.ollamaReachable,
    });
    lines.push({ label: 'LLM model', value: `${serverStatus.llm?.ollamaModelRequested || 'n/a'} (${serverStatus.llm?.ollamaModelAvailable ? 'available' : 'missing'})`, warn: !serverStatus.llm?.ollamaModelAvailable });
    lines.push({ label: 'VLM model', value: `${serverStatus.vlm?.ollamaModelRequested || 'n/a'} (${serverStatus.vlm?.ollamaModelAvailable ? 'available' : 'missing'})`, warn: !serverStatus.vlm?.ollamaModelAvailable });
    if (serverStatus.web?.enabled) lines.push({ label: 'Web tools', value: 'enabled' });
    return lines;
  }, [serverStatus]);

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] flex items-center gap-2">
        <Sparkles className="w-3.5 h-3.5 text-[var(--accent-color)]" />
        AI Chat
        {modelBadgeLabel ? (
          <button
            type="button"
            className={`ml-1 px-1.5 py-0.5 rounded border text-[9px] normal-case tracking-normal transition-colors ${
              modelBadgeLabel.ok
                ? 'border-green-500/30 bg-green-500/10 text-green-400'
                : 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400'
            }`}
            onClick={() => setStatusExpanded((v) => !v)}
          >
            {modelBadgeLabel.text} {statusExpanded ? '▲' : '▼'}
          </button>
        ) : null}
        {codexBadge && (
          <button
            type="button"
            className={`px-1.5 py-0.5 rounded border text-[9px] normal-case tracking-normal transition-colors ${
              codexBadge.ok
                ? 'border-purple-500/30 bg-purple-500/10 text-purple-400'
                : 'border-red-500/30 bg-red-500/10 text-red-400'
            }`}
            onClick={() => setStatusExpanded((v) => !v)}
            title="Codex SDK status"
          >
            {codexBadge.text}
          </button>
        )}
        {modelBadgeLabel && (
          <button
            type="button"
            className="text-[9px] text-[var(--text-secondary)] hover:text-white transition-colors"
            onClick={() => void refreshServerStatus()}
            disabled={statusLoading}
            title="Refresh server status"
          >
            {statusLoading ? '⟳…' : '⟳'}
          </button>
        )}
      </div>
      {statusExpanded && statusLines.length > 0 && (
        <div className="bg-black/50 border border-white/10 rounded px-2 py-1.5 flex flex-col gap-0.5">
          {statusLines.map((line, i) => (
            <div key={i} className="flex gap-2 text-[10px] leading-4">
              <span className="text-[var(--text-secondary)] shrink-0 w-20 text-right">{line.label}</span>
              <span className={line.warn ? 'text-yellow-400' : 'text-[var(--text-primary)]'}>{line.value}</span>
            </div>
          ))}
        </div>
      )}
      {!wsConnected ? (
        <div className="text-[10px] text-yellow-200 flex items-center justify-between gap-2 bg-yellow-500/10 border border-yellow-500/30 rounded px-2 py-1">
          <span>{wsError ? `WS error: ${wsError}` : 'WS not connected'}</span>
          <button
            type="button"
            className="px-2 py-0.5 rounded border border-yellow-500/40 hover:bg-yellow-500/20"
            onClick={() => connectV2Client()}
          >
            Retry
          </button>
        </div>
      ) : null}
      <div
        className="max-h-[28vh] overflow-y-auto custom-scrollbar pr-1 flex flex-col gap-2 text-xs"
        data-testid="chat-messages"
      >
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`rounded px-2 py-1 border ${
              msg.role === 'assistant'
                ? 'bg-black/40 border-white/10 text-[var(--text-primary)]'
                : 'bg-[var(--accent-color)]/10 border-[var(--accent-color)]/30 text-white'
            }`}
          >
            {msg.text}
          </div>
        ))}
        {sending ? (
          <div className="rounded px-2 py-1 border bg-white/5 border-white/10 text-[var(--text-secondary)]" data-testid="chat-pending">
            正在處理中…{pendingElapsedSec != null ? ` ${pendingElapsedSec}s` : ''}
          </div>
        ) : null}
      </div>
      {lastLatencyMs != null ? (
        <div className="text-[10px] text-[var(--text-secondary)] flex items-center gap-2 flex-wrap" data-testid="chat-last-latency">
          <span>Latency: {lastLatencyMs} ms</span>
          {lastRouteMeta ? (
            <>
              <span className={`px-1 rounded text-[9px] ${
                lastRouteMeta.route === 'docs' ? 'bg-green-500/20 text-green-400' :
                lastRouteMeta.route === 'codex' ? 'bg-purple-500/20 text-purple-400' :
                'bg-blue-500/20 text-blue-400'
              }`}>
                {lastRouteMeta.route}
              </span>
              {lastRouteMeta.model && (
                <span className="text-[var(--text-secondary)]">{lastRouteMeta.model}</span>
              )}
              <span className="text-[var(--text-secondary)] opacity-60">{lastRouteMeta.category}</span>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-center gap-2 bg-black/40 border border-white/10 rounded px-2 py-1.5">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Ask something… (try /help)"
          className="flex-1 bg-transparent text-xs outline-none"
          data-testid="chat-input"
          disabled={sending}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="button"
          className="p-1 rounded bg-[var(--accent-color)] text-white hover:brightness-110"
          data-testid="chat-send"
          onClick={send}
          title="Send"
          disabled={sending}
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
