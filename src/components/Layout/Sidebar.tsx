import React, { ReactNode } from 'react';

interface SidebarProps {
  children: ReactNode;
  title: string;
  side: 'left' | 'right';
  className?: string;
  scrollable?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({ children, title, side, className = '', scrollable = true }) => {
  const sideBorder = side === 'left' ? 'border-r' : 'border-l';

  return (
    <div className={`
      w-[clamp(260px,24vw,420px)] h-full p-3 sm:p-4 flex flex-col gap-3 sm:gap-4 z-10 shrink-0 min-h-0
      bg-[rgba(30,30,35,0.6)] backdrop-blur-md ${sideBorder} border-[rgba(255,255,255,0.1)]
      text-white shadow-xl
      ${className}
    `}
    style={{ 
      background: 'var(--panel-bg)', 
      backdropFilter: 'var(--glass-backdrop)',
      borderColor: 'var(--panel-border)'
    }}
    >
      <h2 className="text-xs font-bold tracking-wider text-[var(--accent-color)] uppercase opacity-80">{title}</h2>
      <div className={`flex-1 min-h-0 flex flex-col gap-4 ${scrollable ? 'overflow-y-auto custom-scrollbar' : 'overflow-hidden'}`}>
        {children}
      </div>
    </div>
  );
};
