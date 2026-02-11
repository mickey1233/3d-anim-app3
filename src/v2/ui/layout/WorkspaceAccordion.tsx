import React from 'react';

type Item = {
  id: string;
  label: string;
  content: React.ReactNode;
};

export function WorkspaceAccordion({
  items,
  activeId,
  onChange,
}: {
  items: Item[];
  activeId: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => {
        const open = item.id === activeId;
        return (
          <div key={item.id} className="border border-white/10 rounded bg-black/20">
            <button
              type="button"
              className="w-full px-3 py-2 text-left text-[11px] uppercase tracking-wider text-[var(--text-secondary)] flex items-center justify-between"
              onClick={() => onChange(item.id)}
              data-testid={`workspace-accordion-${item.id}`}
            >
              {item.label}
              <span className="text-[10px]">{open ? '−' : '+'}</span>
            </button>
            {open ? <div className="px-3 pb-3">{item.content}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
