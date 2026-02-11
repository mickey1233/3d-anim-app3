import React from 'react';
import { Search } from 'lucide-react';
import { useV2Store } from '../../store/store';
import { callMcpTool } from '../../network/mcpToolsClient';

export function PartsListV2() {
  const parts = useV2Store((s) => s.parts);
  const selectedPartId = useV2Store((s) => s.selection.partId);
  const [query, setQuery] = React.useState('');

  const items = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = parts.order.map((id) => parts.byId[id]).filter(Boolean);
    if (!q) return list;
    return list.filter((p) => p.name.toLowerCase().includes(q));
  }, [parts, query]);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search parts…"
          className="w-full bg-black/40 border border-white/10 rounded pl-7 pr-2 py-1.5 text-xs outline-none focus:border-[var(--accent-color)]"
        />
      </div>
      <div className="flex-1 min-h-0 max-h-[60vh] overflow-y-auto custom-scrollbar pr-1 flex flex-col gap-1">
        {items.map((part) => {
          const active = part.id === selectedPartId;
          return (
            <button
              key={part.id}
              type="button"
              onClick={() => {
                void callMcpTool('selection.set', {
                  selection: { kind: 'part', part: { partId: part.id } },
                  replace: true,
                  autoResolve: true,
                });
              }}
              data-testid="v2-part-item"
              className={`w-full flex items-center justify-between gap-2 px-2 py-2 rounded border text-xs ${
                active
                  ? 'bg-[var(--accent-color)]/15 border-[var(--accent-color)]'
                  : 'bg-black/30 border-white/5 hover:bg-white/5'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="w-2 h-2 rounded-full border border-white/10 shrink-0"
                  style={{ backgroundColor: part.color || '#ffffff' }}
                />
                <span className="truncate">{part.name}</span>
              </div>
              <span className="text-[10px] font-mono text-[var(--text-secondary)]">
                {part.id.slice(0, 6)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
