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
  const messages = useV2Store((s) => s.chat.messages);
  const appendChatMessage = useV2Store((s) => s.appendChatMessage);
  const parts = useV2Store((s) => s.parts);
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
    };
    try {
      const startedAt = performance.now();
      setSending(true);
      setPendingTick(0);
      setPendingSince(Date.now());
      const res: any = await v2Client.request('router_execute', { text, context: ctx }, { timeoutMs: 18_000 });
      const reportedMs = Number(res?.meta?.timings?.totalMs);
      const measuredMs = Math.round(performance.now() - startedAt);
      setLastLatencyMs(Number.isFinite(reportedMs) ? Math.max(0, Math.floor(reportedMs)) : measuredMs);
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

  const modelBadge = React.useMemo(() => {
    if (!serverStatus) return null;
    const provider = serverStatus.llm?.providerResolved;
    const model = serverStatus.llm?.model;
    if (!provider) return null;
    if (provider === 'mock') return 'LLM: mock';
    if (provider === 'none') return 'LLM: off';
    return model ? `LLM: ${provider}/${model}` : `LLM: ${provider}`;
  }, [serverStatus]);

  const modelBadgeTitle = React.useMemo(() => {
    if (!serverStatus) return undefined;
    const lines = [
      `Router: ${serverStatus.router?.providerResolved || 'unknown'} (env=${serverStatus.router?.providerEnv || 'n/a'})`,
      `LLM: ${serverStatus.llm?.providerResolved || 'unknown'} (env=${serverStatus.llm?.providerEnv || 'n/a'}, model=${serverStatus.llm?.model || 'n/a'})`,
      `VLM: ${serverStatus.vlm?.providerResolved || 'unknown'} (env=${serverStatus.vlm?.providerEnv || 'n/a'}, model=${serverStatus.vlm?.model || 'n/a'})`,
      `Ollama: ${serverStatus.llm?.ollamaReachable ? 'reachable' : 'not reachable'} (models=${serverStatus.llm?.ollamaModelsCount ?? 'n/a'}, url=${serverStatus.llm?.ollamaBaseUrl || 'n/a'})`,
      `Ollama LLM model: ${serverStatus.llm?.ollamaModelRequested || 'n/a'} (${serverStatus.llm?.ollamaModelAvailable ? 'available' : 'missing'})`,
      `Ollama VLM model: ${serverStatus.vlm?.ollamaModelRequested || 'n/a'} (${serverStatus.vlm?.ollamaModelAvailable ? 'available' : 'missing'})`,
    ];
    if (serverStatus.web?.enabled) lines.push('Web tools: enabled');
    lines.push('Click badge to refresh');
    return lines.join('\n');
  }, [serverStatus]);

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] flex items-center gap-2">
        <Sparkles className="w-3.5 h-3.5 text-[var(--accent-color)]" />
        AI Chat
        {modelBadge ? (
          <button
            type="button"
            className="ml-1 px-1.5 py-0.5 rounded border border-white/10 bg-black/30 text-[9px] normal-case tracking-normal text-[var(--text-secondary)]"
            title={modelBadgeTitle}
            onClick={() => void refreshServerStatus()}
            disabled={statusLoading}
          >
            {statusLoading ? 'Refreshing…' : modelBadge}
          </button>
        ) : null}
      </div>
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
        <div className="text-[10px] text-[var(--text-secondary)]" data-testid="chat-last-latency">
          Last reply latency: {lastLatencyMs} ms
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
