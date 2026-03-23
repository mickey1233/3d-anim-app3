import React from 'react';
import { useV2Store } from '../../store/store';
import { ENVIRONMENT_PRESETS } from '../../three/backgrounds/backgrounds';
import { callMcpTool } from '../../network/mcpToolsClient';

function LightSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-[var(--text-secondary)] w-24 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-[var(--accent-color)] h-1"
      />
      <span className="text-[10px] text-white/60 w-8 text-right">{value.toFixed(step < 1 ? 2 : 0)}</span>
    </div>
  );
}

export function ViewPanel() {
  const view = useV2Store((s) => s.view);
  const setLighting = useV2Store((s) => s.setLighting);

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

      {/* ── Lighting ── */}
      <div className="mt-1 border-t border-white/10 pt-2 flex flex-col gap-1.5">
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">Lighting</div>
        <LightSlider
          label="Exposure"
          value={view.lighting.exposure}
          min={0.1} max={2.0} step={0.05}
          onChange={(v) => setLighting({ exposure: v })}
        />
        <LightSlider
          label="Ambient"
          value={view.lighting.ambientIntensity}
          min={0} max={2} step={0.05}
          onChange={(v) => setLighting({ ambientIntensity: v })}
        />
        <LightSlider
          label="Main Light"
          value={view.lighting.mainIntensity}
          min={0} max={3} step={0.05}
          onChange={(v) => setLighting({ mainIntensity: v })}
        />
        <LightSlider
          label="Azimuth °"
          value={view.lighting.azimuth}
          min={0} max={360} step={1}
          onChange={(v) => setLighting({ azimuth: v })}
        />
        <LightSlider
          label="Elevation °"
          value={view.lighting.elevation}
          min={0} max={90} step={1}
          onChange={(v) => setLighting({ elevation: v })}
        />
      </div>
    </div>
  );
}
