import React from 'react';
import { Send, Terminal } from 'lucide-react';
import { v2Client } from '../../network/client';
import { useV2Store } from '../../store/store';
import { useCommandRunner } from './useCommandRunner';

export function CommandBar() {
  const [value, setValue] = React.useState('');
  const [lastResult, setLastResult] = React.useState<string>('Ready.');
  const parts = useV2Store((s) => s.parts);
  const { runLocalCommand } = useCommandRunner();

  const sendCommand = React.useCallback(async () => {
    if (!value.trim()) return;
    const local = await runLocalCommand(value);
    if (local !== null) {
      setLastResult(local);
      setValue('');
      return;
    }
    const ctx = { parts: parts.order.map((id) => ({ id, name: parts.byId[id]?.name || id })) };
    try {
      const res: any = await v2Client.request('router_execute', { text: value, context: ctx });
      const reply = res?.replyText || `Tool calls: ${(res?.trace?.toolCalls?.length ?? 0)}`;
      setLastResult(reply);
    } catch (e: any) {
      setLastResult(`Router error: ${e?.message || 'unknown'}`);
    }
    setValue('');
  }, [parts, runLocalCommand, value]);

  return (
    <div className="flex items-center gap-2 bg-black/40 border border-white/10 rounded px-2 py-1.5">
      <Terminal className="w-4 h-4 text-[var(--text-secondary)]" />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Type a command… (try /help)"
        className="flex-1 bg-transparent text-xs outline-none"
        data-testid="command-input"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            sendCommand();
          }
        }}
      />
      <button
        type="button"
        className="p-1 rounded bg-[var(--accent-color)] text-white hover:brightness-110"
        data-testid="command-send"
        onClick={sendCommand}
        title="Send"
      >
        <Send className="w-3.5 h-3.5" />
      </button>
      <div
        className="ml-2 text-[10px] text-[var(--text-secondary)] truncate max-w-[200px]"
        title={lastResult}
      >
        {lastResult}
      </div>
    </div>
  );
}
