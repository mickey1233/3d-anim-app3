import React from 'react';
import { Search, ArrowDownAZ, ArrowUpAZ } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

type SortMode = 'name_asc' | 'name_desc';

export function PartsList() {
  const { parts, selectedPartId, selectPart } = useAppStore();
  const [query, setQuery] = React.useState('');
  const [sortMode, setSortMode] = React.useState<SortMode>('name_asc');

  const items = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = Object.values(parts);

    if (q) {
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }

    list.sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      if (aName === bName) return 0;
      const cmp = aName < bName ? -1 : 1;
      return sortMode === 'name_asc' ? cmp : -cmp;
    });

    return list;
  }, [parts, query, sortMode]);

  if (Object.keys(parts).length === 0) {
    return (
      <div className="text-xs text-[var(--text-secondary)]">
        No parts yet. Load a model to populate the parts list.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)]" />
          <input
            data-testid="parts-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search parts…"
            className="
              w-full bg-black/40 border border-white/10 rounded pl-7 pr-2 py-1.5
              text-xs text-white outline-none focus:border-[var(--accent-color)] transition-colors
            "
          />
        </div>

        <button
          type="button"
          onClick={() => setSortMode((m) => (m === 'name_asc' ? 'name_desc' : 'name_asc'))}
          data-testid="parts-sort-toggle"
          className="p-2 rounded border border-white/10 bg-black/30 hover:bg-white/5 transition-colors"
          title={sortMode === 'name_asc' ? 'Sort: A → Z' : 'Sort: Z → A'}
        >
          {sortMode === 'name_asc' ? (
            <ArrowDownAZ className="w-4 h-4 text-[var(--text-secondary)]" />
          ) : (
            <ArrowUpAZ className="w-4 h-4 text-[var(--text-secondary)]" />
          )}
        </button>
      </div>

      <div
        className="max-h-[420px] overflow-y-auto custom-scrollbar pr-1 flex flex-col gap-1"
        data-testid="parts-list"
      >
        {items.map((part) => {
          const isSelected = selectedPartId === part.uuid;
          return (
            <button
              key={part.uuid}
              type="button"
              onClick={() => selectPart(part.uuid)}
              data-testid="parts-list-item"
              data-part-uuid={part.uuid}
              className={`
                w-full flex items-center justify-between gap-2 px-2 py-2 rounded border text-xs
                transition-colors text-left
                ${isSelected ? 'bg-[var(--accent-color)]/15 border-[var(--accent-color)]' : 'bg-black/30 border-white/5 hover:bg-white/5'}
              `}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="w-2 h-2 rounded-full border border-white/10 shrink-0"
                  style={{ backgroundColor: part.color || '#ffffff' }}
                />
                <span className="truncate">{part.name}</span>
              </div>
              <span className="text-[10px] font-mono text-[var(--text-secondary)] shrink-0">
                {part.uuid.slice(0, 6)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
