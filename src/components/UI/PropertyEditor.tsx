import React from 'react';
import { useAppStore } from '../../store/useAppStore';

export const PropertyEditor: React.FC = () => {
  const { parts, selectedPartId, updatePart } = useAppStore();
  
  const selectedPart = selectedPartId ? parts[selectedPartId] : null;

  if (!selectedPart) {
    return (
      <div className="text-center text-[var(--text-secondary)] mt-10">
        <p>No part selected.</p>
        <div className="text-xs opacity-50 mt-2">Click on a 3D part to edit its properties.</div>
      </div>
    );
  }

  const handleChange = (axis: number, type: 'position' | 'rotation' | 'scale', value: string) => {
    const numValue = parseFloat(value);
    if (isNaN(numValue)) return;

    const newArray = [...selectedPart[type]] as [number, number, number];
    newArray[axis] = numValue;

    updatePart(selectedPart.uuid, { [type]: newArray });
  };

  const InputGroup = ({ label, type, values }: { label: string, type: 'position' | 'rotation' | 'scale', values: [number, number, number] }) => (
    <div className="mb-4">
      <label className="block text-xs uppercase mb-2 text-[var(--text-secondary)]">{label}</label>
      <div className="grid grid-cols-3 gap-2">
        {['X', 'Y', 'Z'].map((axisLabel, i) => (
          <div key={axisLabel} className="flex flex-col">
            <span className="text-[10px] opacity-50 mb-1 text-center">{axisLabel}</span>
            <input
              type="number"
              step={type === 'scale' ? 0.1 : 0.5}
              value={values[i]}
              onChange={(e) => handleChange(i, type, e.target.value)}
              className="w-full bg-[rgba(0,0,0,0.3)] border border-[rgba(255,255,255,0.1)] rounded px-2 py-1 text-xs text-white focus:border-[var(--accent-color)] outline-none transition-colors"
            />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="animate-fade-in">
      <div className="mb-6 pb-4 border-b border-[rgba(255,255,255,0.1)]">
        <h3 className="text-lg font-semibold">{selectedPart.name}</h3>
        <p className="text-xs text-[var(--text-secondary)] font-mono mt-1">{selectedPart.uuid.slice(0, 8)}...</p>
      </div>

      <InputGroup label="Position" type="position" values={selectedPart.position} />
      <InputGroup label="Rotation" type="rotation" values={selectedPart.rotation} />
      <InputGroup label="Scale" type="scale" values={selectedPart.scale} />
    </div>
  );
};
