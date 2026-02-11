import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export function PanelDock({
  side,
  title,
  isOpen,
  onToggle,
  children,
  footer,
}: {
  side: 'left' | 'right';
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const isLeft = side === 'left';

  return (
    <div
      data-testid={`panel-${side}`}
      className={`
        ${isOpen ? 'block' : 'hidden'} lg:block
        ${isLeft ? 'border-r' : 'border-l'} border-white/10
        bg-[rgba(30,30,35,0.6)] backdrop-blur-md
        w-[clamp(260px,24vw,420px)] min-h-0 h-full
        flex flex-col overflow-hidden
      `}
    >
      <div className="h-10 px-3 sm:px-4 flex items-center justify-between border-b border-white/10">
        <span className="text-xs font-bold tracking-wider text-[var(--accent-color)] uppercase">
          {title}
        </span>
        <button
          type="button"
          className="lg:hidden p-1 rounded hover:bg-white/10"
          onClick={onToggle}
          aria-label="Toggle panel"
        >
          {isLeft ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
      </div>
      <div
        data-testid={`panel-${side}-scroll`}
        className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3 sm:p-4"
      >
        {children}
      </div>
      {footer ? <div className="shrink-0">{footer}</div> : null}
    </div>
  );
}
