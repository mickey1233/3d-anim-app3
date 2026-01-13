import React from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Play, Trash2, X, ListOrdered, StepForward } from 'lucide-react';

import { AnimationStep } from '../../store/useAppStore';

interface SequenceListProps {
    onSelect?: (step: AnimationStep) => void;
}

export const SequenceList: React.FC<SequenceListProps> = ({ onSelect }) => {
    const { 
        sequence, 
        removeStep, 
        playSequence, 
        stopSequence,
        isSequencePlaying,
        currentStepIndex,
        parts
    } = useAppStore();

    if (sequence.length === 0) return null;

    return (
        <div className="flex flex-col gap-2 mt-4 border-t border-white/10 pt-4">
            <h4 className="text-[10px] font-bold text-gray-400 uppercase flex items-center gap-2">
                <ListOrdered className="w-3 h-3" />
                Assembly Sequence ({sequence.length})
            </h4>

            <div className="max-h-[150px] overflow-y-auto flex flex-col gap-1 pr-1 custom-scrollbar">
                {sequence.map((step, idx) => {
                    const partName = parts[step.partId]?.name || step.partId;
                    const isActive = isSequencePlaying && currentStepIndex === idx;

                    return (
                        <div 
                            key={step.id} 
                            onClick={() => onSelect && onSelect(step)}
                            className={`flex items-center justify-between p-2 rounded border text-xs cursor-pointer hover:bg-white/5 transition-colors ${isActive ? 'bg-[var(--accent-color)]/20 border-[var(--accent-color)]' : 'bg-black/30 border-white/5'}`}
                        >
                            <div className="flex items-center gap-2 overflow-hidden">
                                <span className={`text-[9px] font-mono ${isActive ? 'text-[var(--accent-color)]' : 'text-gray-500'}`}>
                                    {idx + 1}.
                                </span>
                                <div className="flex flex-col truncate">
                                    <span className="text-gray-200 truncate font-bold">{partName}</span>
                                    <span className="text-[9px] text-gray-500 truncate">{step.description}</span>
                                </div>
                            </div>
                            <button 
                                onClick={() => removeStep(step.id)}
                                disabled={isSequencePlaying}
                                className="text-gray-500 hover:text-red-400 disabled:opacity-30"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </div>
                    );
                })}
            </div>

            <div className="flex gap-2 mt-1">
                {!isSequencePlaying ? (
                    <button
                        onClick={playSequence}
                        className="flex-1 py-1.5 bg-green-500/20 hover:bg-green-500/30 text-green-400 border border-green-500/50 rounded text-xs flex justify-center items-center gap-2 transition-all"
                    >
                        <Play className="w-3 h-3" />
                        Play Assembly
                    </button>
                ) : (
                    <button
                        onClick={stopSequence}
                        className="flex-1 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/50 rounded text-xs flex justify-center items-center gap-2 transition-all"
                    >
                        <div className="w-2 h-2 bg-current rounded-sm" />
                        Stop
                    </button>
                )}
                
                {/* Clear Button - only show if not playing */}
                {!isSequencePlaying && sequence.length > 0 && (
                     <button
                        onClick={() => {
                            if(confirm("Clear entire sequence?")) {
                                sequence.forEach(s => removeStep(s.id));
                            }
                        }}
                        className="px-2 py-1.5 bg-white/5 hover:bg-white/10 text-gray-400 rounded border border-white/5"
                        title="Clear Sequence"
                    >
                        <Trash2 className="w-3 h-3" />
                    </button>
                )}
            </div>
        </div>
    );
};
