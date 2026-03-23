import React from 'react';
import { useV2Store } from '../../store/store';
import { callMcpTool } from '../../network/mcpToolsClient';

export function TimelineBar() {
  const steps = useV2Store((s) => s.steps.list);
  const current = useV2Store((s) => s.steps.currentStepId);
  const playback = useV2Store((s) => s.playback);
  const [dragId, setDragId] = React.useState<string | null>(null);

  return (
    <div className="h-12 border-t border-white/10 bg-black/40 backdrop-blur-md flex items-center gap-2 px-3">
      <div className="text-[10px] uppercase text-[var(--text-secondary)]">Timeline</div>
      <div className="flex-1 min-w-0 flex gap-1 overflow-x-auto custom-scrollbar">
        {steps.map((s, idx) => (
          <button
            key={s.id}
            type="button"
            draggable
            onDragStart={(e) => {
              setDragId(s.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId && dragId !== s.id) {
                void callMcpTool('steps.move', { stepId: dragId, targetStepId: s.id, position: 'before' });
              }
              setDragId(null);
            }}
            onClick={() => {
              void callMcpTool('steps.playback_start_at', { stepId: s.id });
            }}
            className={`px-2 py-1 rounded text-[10px] whitespace-nowrap border ${
              current === s.id
                ? 'bg-[var(--accent-color)]/20 border-[var(--accent-color)]'
                : 'bg-black/30 border-white/10'
            }`}
          >
            Step {idx + 1}
          </button>
        ))}
        {steps.length === 0 ? (
          <div className="text-[10px] text-[var(--text-secondary)]">No steps</div>
        ) : null}
      </div>
      <button
        type="button"
        data-testid="timeline-run"
        onClick={() => {
          if (playback.running) {
            void callMcpTool('steps.playback_stop', {});
          } else {
            void callMcpTool('steps.playback_start', { durationMs: playback.durationMs });
          }
        }}
        className="px-2 py-1 text-[10px] uppercase font-bold border border-white/10 rounded hover:bg-white/10"
      >
        {playback.running ? 'Stop' : 'Run'}
      </button>
    </div>
  );
}
