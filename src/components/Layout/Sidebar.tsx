import React, { ReactNode } from 'react';

interface SidebarProps {
  children: ReactNode;
  title: string;
  side: 'left' | 'right';
  className?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({ children, title, side, className = '' }) => {
  return (
    <div className={`
      w-[500px] h-full p-4 flex flex-col gap-4 z-10 shrink-0
      bg-[rgba(30,30,35,0.6)] backdrop-blur-md border-${side === 'left' ? 'r' : 'l'} border-[rgba(255,255,255,0.1)]
      text-white shadow-xl
      ${className}
    `}
    style={{ 
      background: 'var(--panel-bg)', 
      backdropFilter: 'var(--glass-backdrop)',
      borderColor: 'var(--panel-border)'
    }}
    >
      <h2 className="text-xl font-bold mb-2 tracking-wide text-[var(--accent-color)] uppercase text-xs opacity-80">{title}</h2>
      <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-4">
        {children}
      </div>
    </div>
  );
};
