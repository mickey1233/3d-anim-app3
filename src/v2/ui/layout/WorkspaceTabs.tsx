import React from 'react';

type Item = {
  id: string;
  label: string;
  content: React.ReactNode;
};

export function WorkspaceTabs({
  items,
  activeId,
  onChange,
}: {
  items: Item[];
  activeId: string;
  onChange: (id: string) => void;
}) {
  const active = items.find((item) => item.id === activeId) || items[0];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {items.map((item) => {
          const isActive = item.id === active.id;
          return (
            <button
              key={item.id}
              type="button"
              className={`px-3 py-1.5 text-[10px] uppercase tracking-wider rounded border ${
                isActive
                  ? 'border-[var(--accent-color)] text-white bg-[var(--accent-color)]/20'
                  : 'border-white/10 text-[var(--text-secondary)] hover:bg-white/10'
              }`}
              onClick={() => onChange(item.id)}
              data-testid={`workspace-tab-${item.id}`}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div className="border border-white/10 rounded bg-black/20 p-3">{active?.content}</div>
    </div>
  );
}
