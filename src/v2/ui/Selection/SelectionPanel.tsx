import React from 'react';
import * as THREE from 'three';
import { ScrubbableNumber } from '../controls/ScrubbableNumber';
import { useV2Store } from '../../store/store';
import { callMcpTool } from '../../network/mcpToolsClient';

const AxisButton = ({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    className="px-2 py-1 text-[10px] border border-white/10 rounded hover:bg-white/10"
    onClick={onClick}
  >
    {label}
  </button>
);

export function SelectionPanel() {
  const selection = useV2Store((s) => s.selection.partId);
  const selectionGroupId = useV2Store((s) => s.selection.groupId);
  const parts = useV2Store((s) => s.parts);
  const assemblyGroups = useV2Store((s) => s.assemblyGroups);
  const getPartTransform = useV2Store((s) => s.getPartTransform);

  const gizmoSpace = useV2Store((s) => s.ui.gizmoSpace);
  const setGizmoSpace = useV2Store((s) => s.setGizmoSpace);

  const [step, setStep] = React.useState('0.01');
  const [rotStep, setRotStep] = React.useState('5');

  const selectedPartName = selection ? parts.byId[selection]?.name || selection : 'None';
  const selectedGroupName = selectionGroupId ? assemblyGroups.byId[selectionGroupId]?.name : undefined;
  const selectedName = selectedGroupName
    ? `${selectedGroupName} / ${selectedPartName}`
    : selectedPartName;
  const transform = selection ? getPartTransform(selection) : null;
  const rotation = React.useMemo(() => {
    if (!transform) return null;
    const q = new THREE.Quaternion(
      transform.quaternion[0],
      transform.quaternion[1],
      transform.quaternion[2],
      transform.quaternion[3]
    );
    const euler = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    return {
      euler,
      degrees: [
        THREE.MathUtils.radToDeg(euler.x),
        THREE.MathUtils.radToDeg(euler.y),
        THREE.MathUtils.radToDeg(euler.z),
      ] as [number, number, number],
      quaternion: transform.quaternion,
    };
  }, [transform]);

  const nudgeRotation = (axis: 'x' | 'y' | 'z', dir: -1 | 1) => {
    if (!selection || !transform) return;
    const deg = Number(rotStep) || 5;
    const rad = (deg * dir * Math.PI) / 180;
    const axisVec = new THREE.Vector3(
      axis === 'x' ? 1 : 0,
      axis === 'y' ? 1 : 0,
      axis === 'z' ? 1 : 0
    );
    const deltaQ = new THREE.Quaternion().setFromAxisAngle(axisVec, rad);
    const curQ = new THREE.Quaternion(...(transform.quaternion as [number, number, number, number]));
    const newQ = deltaQ.multiply(curQ);
    void callMcpTool('action.set_part_transform', {
      part: { partId: selection },
      transform: {
        position: transform.position,
        quaternion: [newQ.x, newQ.y, newQ.z, newQ.w],
        scale: transform.scale,
        space: 'world',
      },
      previewOnly: false,
    });
  };

  const nudge = (axis: 'x' | 'y' | 'z', dir: -1 | 1) => {
    if (!selection || !transform) return;
    const delta = Number(step) || 0;
    const deltaVec: [number, number, number] = [0, 0, 0];
    if (axis === 'x') deltaVec[0] = delta * dir;
    if (axis === 'y') deltaVec[1] = delta * dir;
    if (axis === 'z') deltaVec[2] = delta * dir;
    void callMcpTool('action.translate', {
      part: { partId: selection },
      delta: deltaVec,
      space: 'world',
      previewOnly: false,
    });
  };

  const setPositionAxis = (axisIndex: number, next: number) => {
    if (!selection || !transform) return;
    const position = [...transform.position] as [number, number, number];
    position[axisIndex] = next;
    void callMcpTool('action.set_part_transform', {
      part: { partId: selection },
      transform: {
        position,
        quaternion: transform.quaternion,
        scale: transform.scale,
        space: 'world',
      },
      previewOnly: false,
    });
  };

  const setRotationAxis = (axisIndex: number, nextDegrees: number) => {
    if (!selection || !transform) return;
    const q = new THREE.Quaternion(
      transform.quaternion[0],
      transform.quaternion[1],
      transform.quaternion[2],
      transform.quaternion[3]
    );
    const euler = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    const radians = THREE.MathUtils.degToRad(nextDegrees);
    if (axisIndex === 0) euler.x = radians;
    if (axisIndex === 1) euler.y = radians;
    if (axisIndex === 2) euler.z = radians;
    const nextQ = new THREE.Quaternion().setFromEuler(euler);
    void callMcpTool('action.set_part_transform', {
      part: { partId: selection },
      transform: {
        position: transform.position,
        quaternion: [nextQ.x, nextQ.y, nextQ.z, nextQ.w],
        scale: transform.scale,
        space: 'world',
      },
      previewOnly: false,
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">Selection</div>
        <button
          type="button"
          className="px-2 py-1 text-[10px] rounded border border-white/10 hover:bg-white/10"
          onClick={() => setGizmoSpace(gizmoSpace === 'world' ? 'local' : 'world')}
          title="Toggle transform gizmo space"
        >
          {gizmoSpace === 'world' ? 'World' : 'Object'}
        </button>
      </div>
      <div className="text-xs font-semibold">{selectedName}</div>

      <div className="text-[10px] text-[var(--text-secondary)]">Position</div>
      <div className="grid grid-cols-3 gap-2 text-[10px]">
        <ScrubbableNumber
          value={transform ? transform.position[0] : null}
          onChange={(v) => setPositionAxis(0, v)}
          precision={4}
          disabled={!transform}
          testId="position-x"
        />
        <ScrubbableNumber
          value={transform ? transform.position[1] : null}
          onChange={(v) => setPositionAxis(1, v)}
          precision={4}
          disabled={!transform}
          testId="position-y"
        />
        <ScrubbableNumber
          value={transform ? transform.position[2] : null}
          onChange={(v) => setPositionAxis(2, v)}
          precision={4}
          disabled={!transform}
          testId="position-z"
        />
      </div>

      <div className="text-[10px] text-[var(--text-secondary)]">Rotation (deg)</div>
      <div className="grid grid-cols-3 gap-2 text-[10px]">
        <ScrubbableNumber
          value={rotation ? rotation.degrees[0] : null}
          onChange={(v) => setRotationAxis(0, v)}
          precision={1}
          step={0.01}
          disabled={!rotation}
          testId="rotation-x"
        />
        <ScrubbableNumber
          value={rotation ? rotation.degrees[1] : null}
          onChange={(v) => setRotationAxis(1, v)}
          precision={1}
          step={0.01}
          disabled={!rotation}
          testId="rotation-y"
        />
        <ScrubbableNumber
          value={rotation ? rotation.degrees[2] : null}
          onChange={(v) => setRotationAxis(2, v)}
          precision={1}
          step={0.01}
          disabled={!rotation}
          testId="rotation-z"
        />
      </div>

      <div className="text-[10px] text-[var(--text-secondary)]">Quaternion</div>
      <div className="grid grid-cols-4 gap-2 text-[10px]">
        <div className="bg-black/40 border border-white/10 rounded px-2 py-1">
          {rotation ? rotation.quaternion[0].toFixed(3) : '—'}
        </div>
        <div className="bg-black/40 border border-white/10 rounded px-2 py-1">
          {rotation ? rotation.quaternion[1].toFixed(3) : '—'}
        </div>
        <div className="bg-black/40 border border-white/10 rounded px-2 py-1">
          {rotation ? rotation.quaternion[2].toFixed(3) : '—'}
        </div>
        <div className="bg-black/40 border border-white/10 rounded px-2 py-1">
          {rotation ? rotation.quaternion[3].toFixed(3) : '—'}
        </div>
      </div>

      <div className="flex items-center gap-2 text-[10px] text-[var(--text-secondary)]">
        Step (m)
        <input
          value={step}
          onChange={(e) => setStep(e.target.value)}
          className="w-20 bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] outline-none"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <AxisButton label="+X" onClick={() => nudge('x', 1)} />
        <AxisButton label="-X" onClick={() => nudge('x', -1)} />
        <AxisButton label="+Y" onClick={() => nudge('y', 1)} />
        <AxisButton label="-Y" onClick={() => nudge('y', -1)} />
        <AxisButton label="+Z" onClick={() => nudge('z', 1)} />
        <AxisButton label="-Z" onClick={() => nudge('z', -1)} />
      </div>

      <div className="flex items-center gap-2 text-[10px] text-[var(--text-secondary)]">
        Rot (deg)
        <input
          value={rotStep}
          onChange={(e) => setRotStep(e.target.value)}
          className="w-14 bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] outline-none"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <AxisButton label="+Rx" onClick={() => nudgeRotation('x', 1)} />
        <AxisButton label="-Rx" onClick={() => nudgeRotation('x', -1)} />
        <AxisButton label="+Ry" onClick={() => nudgeRotation('y', 1)} />
        <AxisButton label="-Ry" onClick={() => nudgeRotation('y', -1)} />
        <AxisButton label="+Rz" onClick={() => nudgeRotation('z', 1)} />
        <AxisButton label="-Rz" onClick={() => nudgeRotation('z', -1)} />
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          className="flex-1 py-1.5 text-[10px] rounded border border-white/10 hover:bg-white/10"
          disabled={!selection}
          onClick={() => {
            if (!selection) return;
            void callMcpTool('action.reset_part', { part: { partId: selection } });
          }}
        >
          Reset Part
        </button>
        <button
          type="button"
          className="flex-1 py-1.5 text-[10px] rounded border border-white/10 hover:bg-white/10"
          onClick={() => {
            void callMcpTool('action.reset_all', {});
          }}
        >
          Reset All
        </button>
      </div>
    </div>
  );
}
