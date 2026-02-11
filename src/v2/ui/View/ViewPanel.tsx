import React from 'react';
import { useV2Store } from '../../store/store';
import { ENVIRONMENT_PRESETS } from '../../three/backgrounds/backgrounds';
import { callMcpTool } from '../../network/mcpToolsClient';

export function ViewPanel() {
  const view = useV2Store((s) => s.view);

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">View</div>

      <label className="text-[10px] text-[var(--text-secondary)]">Environment</label>
      <select
        value={view.environment}
        onChange={(e) => {
          void callMcpTool('view.set_environment', { environment: e.target.value });
        }}
        className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs"
      >
        {ENVIRONMENT_PRESETS.map((env) => (
          <option key={env} value={env}>
            {env}
          </option>
        ))}
      </select>

      <label className="flex items-center gap-2 text-[10px] text-[var(--text-secondary)]">
        <input
          type="checkbox"
          checked={view.showGrid}
          onChange={(e) => {
            void callMcpTool('view.set_grid_visible', { visible: e.target.checked });
          }}
        />
        Show Grid
      </label>

      <label className="flex items-center gap-2 text-[10px] text-[var(--text-secondary)]">
        <input
          type="checkbox"
          checked={view.showAnchors}
          onChange={(e) => {
            void callMcpTool('view.set_anchors_visible', { visible: e.target.checked });
          }}
        />
        Show Anchor Markers
      </label>
    </div>
  );
}
