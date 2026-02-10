import React from 'react';
import { Move, RotateCcw, Link } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { InteractionMode } from '../../../shared/types';

const modes: { mode: InteractionMode; icon: React.ElementType; label: string; shortcut: string }[] = [
  { mode: 'move', icon: Move, label: 'Move', shortcut: 'W' },
  { mode: 'rotate', icon: RotateCcw, label: 'Rotate', shortcut: 'E' },
  { mode: 'mate', icon: Link, label: 'Mate', shortcut: 'R' },
];

export const InteractionModeToggle: React.FC = () => {
  const interactionMode = useAppStore((s) => s.interactionMode);
  const setInteractionMode = useAppStore((s) => s.setInteractionMode);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key.toLowerCase();
      if (key === 'w') setInteractionMode('move');
      else if (key === 'e') setInteractionMode('rotate');
      else if (key === 'r') setInteractionMode('mate');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setInteractionMode]);

  return (
    <div
      className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex gap-1 bg-black/60 backdrop-blur-md rounded-lg p-1 border border-white/10 shadow-lg"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {modes.map(({ mode, icon: Icon, label, shortcut }) => {
        const active = interactionMode === mode;
        return (
          <button
            key={mode}
            onClick={() => setInteractionMode(mode)}
            title={`${label} (${shortcut})`}
            className={`
              flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
              transition-all select-none
              ${active
                ? 'bg-[var(--accent-color)] text-white shadow-[0_0_12px_rgba(59,130,246,0.4)]'
                : 'text-[var(--text-secondary)] hover:text-white hover:bg-white/10'
              }
            `}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
};
