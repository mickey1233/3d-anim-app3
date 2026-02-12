import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export function PanelSection({
  title,
  icon: Icon,
  defaultOpen = true,
  rightSlot,
  contentClassName,
  children,
}: {
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  defaultOpen?: boolean;
  rightSlot?: React.ReactNode;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <div className="rounded-lg border border-white/10 bg-black/25 backdrop-blur-md shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {open ? (
            <ChevronDown className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
          )}
          {Icon ? <Icon className="w-4 h-4 text-[var(--accent-color)] shrink-0" /> : null}
          <span className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] truncate">
            {title}
          </span>
        </div>
        {rightSlot ? <div className="shrink-0">{rightSlot}</div> : null}
      </button>

      {open ? <div className={`p-3 pt-2 ${contentClassName || ''}`}>{children}</div> : null}
    </div>
  );
}
