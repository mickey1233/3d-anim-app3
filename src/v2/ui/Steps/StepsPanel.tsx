import React from 'react';
import { useV2Store } from '../../store/store';
import { callMcpTool } from '../../network/mcpToolsClient';

export function StepsPanel() {
  const steps = useV2Store((s) => s.steps.list);
  const current = useV2Store((s) => s.steps.currentStepId);
  const selectedPartId = useV2Store((s) => s.selection.partId);
  const parts = useV2Store((s) => s.parts.byId);
  const [label, setLabel] = React.useState('');

  const defaultLabel = selectedPartId ? `Mate ${parts[selectedPartId]?.name || 'Part'}` : 'New Step';

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">SOP Steps</div>

      <div className="flex gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={defaultLabel}
          data-testid="step-input"
          className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1 text-xs outline-none"
        />
        <button
          type="button"
          className="px-2 py-1 rounded bg-[var(--accent-color)] text-[10px] font-bold"
          data-testid="step-add"
          onClick={() => {
            void callMcpTool('steps.add', { label: label || defaultLabel, select: true });
            setLabel('');
          }}
        >
          Add
        </button>
        <button
          type="button"
          className="px-2 py-1 rounded border border-white/10 text-[10px] font-semibold disabled:opacity-40"
          disabled={!current}
          onClick={() => {
            if (!current) return;
            void callMcpTool('steps.update_snapshot', { stepId: current });
          }}
          data-testid="step-update"
        >
          Update
        </button>
      </div>

      <div className="max-h-[32vh] overflow-y-auto custom-scrollbar pr-1 flex flex-col gap-1">
        {steps.map((step, idx) => (
          <div
            key={step.id}
            className={`w-full px-2 py-2 rounded border text-xs flex items-center gap-2 ${
              current === step.id
                ? 'bg-[var(--accent-color)]/15 border-[var(--accent-color)]'
                : 'bg-black/30 border-white/5 hover:bg-white/5'
            }`}
          >
            <button
              type="button"
              onClick={() => {
                void callMcpTool('steps.select', { stepId: step.id });
              }}
              className="flex-1 text-left"
            >
              <span className="font-semibold">Step {idx + 1}</span>
              {step.label && step.label !== `Step ${idx + 1}` && (
                <span className="ml-1 text-white/50">— {step.label}</span>
              )}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void callMcpTool('steps.playback_start_at', { stepId: step.id });
              }}
              className="text-[10px] text-green-300 hover:text-green-200 px-1"
              aria-label="Play step"
            >
              ▶
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void callMcpTool('steps.delete', { stepId: step.id });
              }}
              className="text-[10px] text-red-300 hover:text-red-200 px-1"
              aria-label="Delete step"
              data-testid="step-delete"
            >
              ✕
            </button>
          </div>
        ))}
        {steps.length === 0 ? (
          <div className="text-[10px] text-[var(--text-secondary)]">No steps yet.</div>
        ) : null}
      </div>
    </div>
  );
}
