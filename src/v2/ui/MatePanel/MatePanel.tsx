import React from 'react';
import { useV2Store } from '../../store/store';
import { ANCHOR_METHOD_OPTIONS } from '../../three/mating/anchorMethods';
import { ScrubbableNumber } from '../controls/ScrubbableNumber';
import { callMcpTool, extractToolErrorMessage } from '../../network/mcpToolsClient';

export function MatePanel() {
  const partOrder = useV2Store((s) => s.parts.order);
  const partById = useV2Store((s) => s.parts.byId);
  const setPickMode = useV2Store((s) => s.setPickFaceMode);
  const clearMatePick = useV2Store((s) => s.clearMatePick);
  const clearMarkers = useV2Store((s) => s.clearMarkers);
  const clearPartOverride = useV2Store((s) => s.clearPartOverride);
  const mateDraft = useV2Store((s) => s.mateDraft);
  const setMateDraft = useV2Store((s) => s.setMateDraft);
  const matePreview = useV2Store((s) => s.matePreview);
  const partList = React.useMemo(
    () => partOrder.map((id) => partById[id]).filter(Boolean),
    [partOrder, partById]
  );
  const [isApplying, setIsApplying] = React.useState(false);
  const [applyError, setApplyError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setPickMode('idle');
    clearMatePick();
    clearMarkers();
  }, [setPickMode, clearMatePick, clearMarkers]);

  const applyMate = async () => {
    if (!mateDraft.sourceId || !mateDraft.targetId) return;
    if (isApplying) return;

    const sourceName = partById[mateDraft.sourceId]?.name || 'source';
    const targetName = partById[mateDraft.targetId]?.name || 'target';

    setIsApplying(true);
    setApplyError(null);
    try {
      const result = await callMcpTool('action.mate_execute', {
        sourcePart: { partId: mateDraft.sourceId },
        targetPart: { partId: mateDraft.targetId },
        sourceFace: mateDraft.sourceFace,
        targetFace: mateDraft.targetFace,
        sourceMethod: mateDraft.sourceMethod,
        targetMethod: mateDraft.targetMethod,
        sourceOffset: mateDraft.sourceOffset,
        targetOffset: mateDraft.targetOffset,
        mode: mateDraft.mode,
        mateMode: mateDraft.mode === 'both' ? 'face_insert_arc' : 'face_flush',
        pathPreference: 'auto',
        twist: {
          angleDeg: mateDraft.twistAngleDeg,
          axis: mateDraft.twistAxis,
          axisSpace: mateDraft.twistAxisSpace,
          constraint: 'free',
        },
        commit: true,
        pushHistory: true,
        stepLabel: `Mate ${sourceName} to ${targetName}`,
      });

      const error = extractToolErrorMessage(result);
      if (error) {
        setApplyError(error);
        return;
      }

      setPickMode('idle');
      clearMatePick();
      clearMarkers();
    } catch (err: any) {
      setApplyError(String(err?.message || err || 'mate failed'));
    } finally {
      setIsApplying(false);
    }
  };

  const setSourceOffsetAxis = (axis: number, value: number) => {
    const next = [...mateDraft.sourceOffset] as [number, number, number];
    next[axis] = value;
    setMateDraft({ sourceOffset: next });
  };

  const setTargetOffsetAxis = (axis: number, value: number) => {
    const next = [...mateDraft.targetOffset] as [number, number, number];
    next[axis] = value;
    setMateDraft({ targetOffset: next });
  };

  return (
    <div className="flex flex-col gap-2 pb-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">Mate (Face)</div>

      <label className="text-[10px] text-[var(--text-secondary)]">Source Part</label>
      <select
        value={mateDraft.sourceId}
        onChange={(e) => {
          const next = e.target.value;
          setMateDraft({ sourceId: next }, 'source');
        }}
        data-testid="mate-source"
        className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs"
      >
        <option value="">-- Select Source --</option>
        {partList.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      <label className="text-[10px] text-[var(--text-secondary)]">Target Part</label>
      <select
        value={mateDraft.targetId}
        onChange={(e) => {
          const next = e.target.value;
          setMateDraft({ targetId: next }, 'target');
        }}
        data-testid="mate-target"
        className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs"
      >
        <option value="">-- Select Target --</option>
        {partList.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      <div className="grid grid-cols-2 gap-2 mt-1">
        <div>
          <label className="text-[10px] text-[var(--text-secondary)]">Source Face</label>
          <select
            value={mateDraft.sourceFace}
            onChange={(e) => {
              setMateDraft({ sourceFace: e.target.value as any }, 'source');
            }}
            data-testid="mate-source-face"
            className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs w-full"
          >
            <option value="top">Top</option>
            <option value="bottom">Bottom</option>
            <option value="left">Left</option>
            <option value="right">Right</option>
            <option value="front">Front</option>
            <option value="back">Back</option>
          </select>
        </div>
        <div>
          <label className="text-[10px] text-[var(--text-secondary)]">Target Face</label>
          <select
            value={mateDraft.targetFace}
            onChange={(e) => {
              setMateDraft({ targetFace: e.target.value as any }, 'target');
            }}
            data-testid="mate-target-face"
            className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs w-full"
          >
            <option value="top">Top</option>
            <option value="bottom">Bottom</option>
            <option value="left">Left</option>
            <option value="right">Right</option>
            <option value="front">Front</option>
            <option value="back">Back</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-1">
        <div>
          <label className="text-[10px] text-[var(--text-secondary)]">Source Method</label>
          <select
            value={mateDraft.sourceMethod}
            onChange={(e) => {
              setMateDraft({ sourceMethod: e.target.value as any }, 'source');
            }}
            data-testid="mate-source-method"
            className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs w-full"
          >
            {ANCHOR_METHOD_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
          <div className="text-[9px] text-[var(--text-secondary)] mt-1">
            Resolved: {matePreview.source?.methodUsed || '—'}
            {matePreview.source?.fallbackUsed ? ' (fallback)' : ''}
          </div>
        </div>
        <div>
          <label className="text-[10px] text-[var(--text-secondary)]">Target Method</label>
          <select
            value={mateDraft.targetMethod}
            onChange={(e) => {
              setMateDraft({ targetMethod: e.target.value as any }, 'target');
            }}
            data-testid="mate-target-method"
            className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs w-full"
          >
            {ANCHOR_METHOD_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
          <div className="text-[9px] text-[var(--text-secondary)] mt-1">
            Resolved: {matePreview.target?.methodUsed || '—'}
            {matePreview.target?.fallbackUsed ? ' (fallback)' : ''}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-1">
        <div>
          <label className="text-[10px] text-[var(--text-secondary)]">Source Offset (local)</label>
          <div className="grid grid-cols-3 gap-1 text-[9px] text-[var(--text-secondary)]">
            <span>X</span>
            <span>Y</span>
            <span>Z</span>
          </div>
          <div className="grid grid-cols-3 gap-1 text-[10px]">
            <ScrubbableNumber
              value={mateDraft.sourceOffset[0]}
              onChange={(v) => setSourceOffsetAxis(0, v)}
              precision={4}
              step={0.01}
            />
            <ScrubbableNumber
              value={mateDraft.sourceOffset[1]}
              onChange={(v) => setSourceOffsetAxis(1, v)}
              precision={4}
              step={0.01}
            />
            <ScrubbableNumber
              value={mateDraft.sourceOffset[2]}
              onChange={(v) => setSourceOffsetAxis(2, v)}
              precision={4}
              step={0.01}
            />
          </div>
        </div>
        <div>
          <label className="text-[10px] text-[var(--text-secondary)]">Target Offset (local)</label>
          <div className="grid grid-cols-3 gap-1 text-[9px] text-[var(--text-secondary)]">
            <span>X</span>
            <span>Y</span>
            <span>Z</span>
          </div>
          <div className="grid grid-cols-3 gap-1 text-[10px]">
            <ScrubbableNumber
              value={mateDraft.targetOffset[0]}
              onChange={(v) => setTargetOffsetAxis(0, v)}
              precision={4}
              step={0.01}
            />
            <ScrubbableNumber
              value={mateDraft.targetOffset[1]}
              onChange={(v) => setTargetOffsetAxis(1, v)}
              precision={4}
              step={0.01}
            />
            <ScrubbableNumber
              value={mateDraft.targetOffset[2]}
              onChange={(v) => setTargetOffsetAxis(2, v)}
              precision={4}
              step={0.01}
            />
          </div>
        </div>
      </div>

      <button
        type="button"
        className="self-start text-[10px] text-[var(--text-secondary)] hover:text-white"
        onClick={() => setMateDraft({ sourceOffset: [0, 0, 0], targetOffset: [0, 0, 0] })}
      >
        Reset Offsets
      </button>

      <label className="text-[10px] text-[var(--text-secondary)]">Mate Mode</label>
      <select
        value={mateDraft.mode}
        onChange={(e) => setMateDraft({ mode: e.target.value as any })}
        data-testid="mate-mode"
        className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs"
      >
        <option value="translate">Translate (move only)</option>
        <option value="twist">Twist (rotate around normal)</option>
        <option value="both">Both (align + twist + translate)</option>
      </select>

      {mateDraft.mode !== 'translate' ? (
        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-[var(--text-secondary)]">Twist Space</label>
            <select
              value={mateDraft.twistAxisSpace}
              onChange={(e) => setMateDraft({ twistAxisSpace: e.target.value as any })}
              className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs"
            >
              <option value="target_face">Target Face</option>
              <option value="source_face">Source Face</option>
              <option value="world">World</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-[var(--text-secondary)]">Twist Axis</label>
            <select
              value={mateDraft.twistAxis}
              onChange={(e) => setMateDraft({ twistAxis: e.target.value as any })}
              className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs"
            >
              <option value="normal">Normal</option>
              <option value="tangent">Tangent</option>
              <option value="bitangent">Bitangent</option>
              <option value="x">World X</option>
              <option value="y">World Y</option>
              <option value="z">World Z</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-[var(--text-secondary)]">Twist Angle (deg)</label>
            <input
              type="number"
              value={mateDraft.twistAngleDeg}
              onChange={(e) => setMateDraft({ twistAngleDeg: Number(e.target.value) })}
              className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs"
            />
          </div>
        </div>
      ) : null}

      <button
        type="button"
        className="py-1.5 text-[10px] rounded border border-white/10 hover:bg-white/10"
        onClick={() => {
          if (mateDraft.sourceId) clearPartOverride(mateDraft.sourceId);
          if (mateDraft.targetId) clearPartOverride(mateDraft.targetId);
        }}
      >
        Reset Parts
      </button>

      <div className="sticky bottom-0 pt-2">
        <div className="border-t border-white/10 bg-[rgba(25,25,30,0.85)] backdrop-blur-md px-2 py-3 rounded">
          <button
            type="button"
            className="w-full py-2 rounded bg-[var(--accent-color)] text-xs font-bold hover:brightness-110 disabled:opacity-40"
            disabled={!mateDraft.sourceId || !mateDraft.targetId || isApplying}
            data-testid="mate-apply"
            onClick={() => {
              void applyMate();
            }}
          >
            {isApplying ? 'Applying…' : 'Apply Mate'}
          </button>
          {applyError ? (
            <div className="mt-2 text-[10px] text-red-300 break-words" data-testid="mate-apply-error">
              {applyError}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
