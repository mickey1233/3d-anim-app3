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
  const messages = useV2Store((s) => s.chat.messages);
  const appendChatMessage = useV2Store((s) => s.appendChatMessage);
  const parts = useV2Store((s) => s.parts);
  const wsConnected = useV2Store((s) => s.connection.wsConnected);
  const wsError = useV2Store((s) => s.connection.wsError);
  const { runLocalCommand, helpText } = useCommandRunner();

  const appendMessage = React.useCallback(
    (role: ChatMessage['role'], text: string) => {
      appendChatMessage({ role, text });
    },
    [appendChatMessage]
  );

  const send = React.useCallback(async () => {
    if (!value.trim()) return;
    const text = value.trim();
    setValue('');
    appendMessage('user', text);

    if (text === '/help' || text === 'help') {
      appendMessage('assistant', helpText);
      return;
    }

    const local = await runLocalCommand(text);
    if (local !== null) {
      appendMessage('assistant', local);
      return;
    }

    if (!wsConnected) {
      appendMessage('assistant', 'Router error: WS not connected');
      return;
    }

    const ctx = { parts: parts.order.map((id) => ({ id, name: parts.byId[id]?.name || id })) };
    try {
      const res: any = await v2Client.request('router_execute', { text, context: ctx });
      const reply = res?.replyText || `已執行 ${res?.trace?.toolCalls?.length ?? 0} 個工具`;
      appendMessage('assistant', reply);
    } catch (e: any) {
      appendMessage('assistant', `Router error: ${e?.message || 'unknown'}`);
    }
  }, [appendMessage, helpText, parts, runLocalCommand, value, wsConnected]);

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] flex items-center gap-2">
        <Sparkles className="w-3.5 h-3.5 text-[var(--accent-color)]" />
        AI Chat
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
      </div>
      <div className="flex items-center gap-2 bg-black/40 border border-white/10 rounded px-2 py-1.5">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Ask something… (try /help)"
          className="flex-1 bg-transparent text-xs outline-none"
          data-testid="chat-input"
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
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
