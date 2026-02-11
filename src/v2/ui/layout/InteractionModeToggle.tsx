import React from 'react';
import { callMcpTool } from '../../network/mcpToolsClient';
import { useV2Store } from '../../store/store';

const MODES = [
  { id: 'move', label: 'Move' },
  { id: 'rotate', label: 'Rotate' },
  { id: 'mate', label: 'Mate' },
] as const;

export function InteractionModeToggle() {
  const mode = useV2Store((s) => s.interaction.mode);
  const [pending, setPending] = React.useState<string | null>(null);

  const setMode = async (nextMode: (typeof MODES)[number]['id']) => {
    if (nextMode === mode) return;
    setPending(nextMode);
    try {
      await callMcpTool('mode.set_interaction_mode', {
        mode: nextMode,
        reason: 'canvas_toggle',
      });
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="inline-flex items-center gap-1 border border-white/10 rounded px-1 py-1 bg-black/30">
      {MODES.map((entry) => {
        const active = mode === entry.id;
        const disabled = pending !== null;
        return (
          <button
            key={entry.id}
            type="button"
            disabled={disabled}
            onClick={() => setMode(entry.id)}
            className={`px-2 py-1 text-[10px] uppercase rounded border transition-colors ${
              active
                ? 'bg-[var(--accent-color)]/20 border-[var(--accent-color)] text-white'
                : 'border-white/10 text-[var(--text-secondary)] hover:text-white hover:bg-white/10'
            } ${disabled ? 'opacity-70 cursor-not-allowed' : ''}`}
          >
            {entry.label}
          </button>
        );
      })}
    </div>
  );
}
