import React from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Play, Plus, RotateCcw, Save, MousePointerClick, ChevronRight, ChevronDown, Trash2, Settings } from 'lucide-react';
import { SequenceList } from './SequenceList';
import { ChatInterface } from './ChatInterface';

export const AnimationStudio: React.FC = () => {
    const [editingStepId, setEditingStepId] = React.useState<string | null>(null);

    const { 
        parts, movingPartId, setMovingPartId,
        pickingMode, setPickingMode,
        startMarker, endMarker, setStartMarker, setEndMarker,
        animationDuration, animationEasing, setAnimationConfig,
        isAnimationPlaying, setAnimationPlaying,
        updatePart, resetPart,
        addStep,
        updateStep,
        resetAllParts,
        sequence 
    } = useAppStore();

    const handleRun = () => {
        setAnimationPlaying(true);
    };

    const handleAddToSequence = () => {
        if (!movingPartId || !startMarker || !endMarker) return;
        
        addStep({
            id: crypto.randomUUID(),
            partId: movingPartId,
            startMarker: startMarker,
            endMarker: endMarker,
            duration: animationDuration,
            easing: animationEasing,
            description: `Move ${parts[movingPartId]?.name || 'Object'}`
        });
    };

    const handleUpdateStep = () => {
        if (!editingStepId || !movingPartId || !startMarker || !endMarker) return;

        updateStep(editingStepId, {
            partId: movingPartId,
            startMarker: startMarker,
            endMarker: endMarker,
            duration: animationDuration,
            easing: animationEasing,
            description: `Move ${parts[movingPartId]?.name || 'Object'}`
        });
        setEditingStepId(null); // Exit editing mode
    };

    const handleSelectStep = (step: any) => {
        setEditingStepId(step.id);
        setMovingPartId(step.partId);
        setStartMarker(step.startMarker.position);
        setEndMarker(step.endMarker.position);
        setAnimationConfig(step.duration, step.easing);
    };

    const handleReset = () => {
        resetAllParts();
        setEditingStepId(null);
    };

    const cancelEditing = () => {
        setEditingStepId(null);
        // Optionally clear inputs? Let's keep them.
    };

    return (
        <div className="bg-black/40 backdrop-blur-md rounded-lg p-4 border border-white/10 flex flex-col gap-4 max-h-[calc(100vh-200px)] overflow-y-auto custom-scrollbar">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                <Settings className="w-4 h-4 text-[var(--accent-color)]" />
                Animation Studio
            </h3>
            
            <div className="flex flex-col gap-3">
                {/* 1. Select Moving Object */}
                <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase text-gray-500 font-bold">Target Object</label>
                    <div className="flex gap-2">
                        <select 
                            value={movingPartId || ''}
                            onChange={(e) => setMovingPartId(e.target.value || null)}
                            className="bg-black/50 border border-white/10 rounded px-2 py-1 text-xs text-white flex-1 min-w-0"
                        >
                            <option value="">-- Select Object to Move --</option>
                            {Object.values(parts).map(part => (
                                <option key={part.uuid} value={part.uuid}>{part.name}</option>
                            ))}
                        </select>
                        <button
                            onClick={() => movingPartId && resetPart(movingPartId)}
                            disabled={!movingPartId}
                            className="p-1.5 bg-white/10 hover:bg-white/20 text-white rounded disabled:opacity-30 disabled:cursor-not-allowed"
                            title="Reset Selected Part"
                        >
                            <RotateCcw className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                {/* 2. Start/End Points */}
                <div className="flex flex-col gap-3">
                    {/* Start Point */}
                    <div className={`p-3 rounded border ${pickingMode === 'start' ? 'border-green-400 bg-green-400/10' : 'border-white/10 bg-black/20'}`}>
                        <div className="flex justify-between items-center mb-2">
                            <span className="text-xs font-bold text-gray-300">Start Point</span>
                            <button 
                                onClick={() => setPickingMode(pickingMode === 'start' ? 'idle' : 'start')}
                                className={`p-1.5 rounded transition-colors ${pickingMode === 'start' ? 'bg-green-400 text-black' : 'bg-white/10 hover:bg-white/20'}`}
                                title="Pick Face Center"
                            >
                                <MousePointerClick className="w-4 h-4" />
                            </button>
                        </div>
                        
                        {startMarker ? (
                             <div className="flex gap-2 mb-2 items-center">
                                {startMarker.position.map((val, idx) => (
                                    <div key={idx} className="flex-1 min-w-0">
                                        <input 
                                            type="number" 
                                            step="0.01"
                                            className="w-full bg-black/40 border border-white/20 rounded px-2 py-2 text-sm text-gray-200 text-center focus:border-[var(--accent-color)] outline-none font-mono"
                                            value={Number(val).toFixed(2)}
                                            onChange={(e) => {
                                                const newPos = [...startMarker.position] as [number, number, number];
                                                newPos[idx] = parseFloat(e.target.value);
                                                setStartMarker(newPos);
                                            }}
                                        />
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="text-xs text-gray-500 italic px-2 py-1">Not set</div>
                        )}
                        <div className="flex justify-end">
                            {startMarker && (
                                <button 
                                    onClick={() => setStartMarker(null)}
                                    className="text-xs text-red-400 hover:text-red-300"
                                >
                                    Clear
                                </button>
                            )}
                        </div>
                    </div>

                    {/* End Point */}
                    <div className="bg-white/5 rounded p-3 border border-white/5">
                        <div className="flex justify-between items-center mb-2">
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">End Point</label>
                            {/* Pick Button */}
                             <button
                                onClick={() => setPickingMode(pickingMode === 'end' ? 'idle' : 'end')}
                                className={`p-1.5 rounded transition-colors ${pickingMode === 'end' ? 'bg-[var(--accent-color)] text-white' : 'bg-white/10 text-gray-400 hover:bg-white/20'}`}
                                title="Pick Face Center"
                            >
                                <MousePointerClick className="w-4 h-4" />
                            </button>
                        </div>

                        {endMarker ? (
                             <div className="flex gap-2 mb-2 items-center">
                                {endMarker.position.map((val, idx) => (
                                    <div key={idx} className="flex-1 min-w-0">
                                        <input 
                                            type="number" 
                                            step="0.01"
                                            className="w-full bg-black/40 border border-white/20 rounded px-2 py-2 text-sm text-gray-200 text-center focus:border-[var(--accent-color)] outline-none font-mono"
                                            value={Number(val).toFixed(2)}
                                            onChange={(e) => {
                                                const newPos = [...endMarker.position] as [number, number, number];
                                                newPos[idx] = parseFloat(e.target.value);
                                                setEndMarker(newPos);
                                            }}
                                        />
                                    </div>
                                ))}
                            </div>
                        ) : (
                             <div className="text-xs text-gray-500 italic px-2 py-1">Not set</div>
                        )}

                        <div className="flex justify-end">
                             {endMarker && (
                                <button 
                                   onClick={() => setEndMarker(null)} 
                                   className="text-xs text-red-400 hover:text-red-300"
                                >Clear</button>
                             )}
                        </div>
                    </div>
                </div>

                {/* 3. Settings */}
                 <div className="grid grid-cols-2 gap-2">
                    <div>
                        <label className="text-[9px] text-gray-500 block mb-1">Duration (s)</label>
                        <input 
                            type="number" step="0.1"
                            value={animationDuration}
                            onChange={(e) => setAnimationConfig(parseFloat(e.target.value), animationEasing)}
                            className="w-full bg-black/50 border border-white/10 rounded px-1 py-1 text-xs"
                        />
                    </div>
                    <div>
                         <label className="text-[9px] text-gray-500 block mb-1">Easing</label>
                         <select 
                            value={animationEasing}
                            onChange={(e) => setAnimationConfig(animationDuration, e.target.value as any)}
                            className="w-full bg-black/50 border border-white/10 rounded px-1 py-1 text-xs"
                         >
                            <option value="linear">Linear</option>
                            <option value="easeIn">Ease In</option>
                            <option value="easeOut">Ease Out</option>
                            <option value="easeInOut">Ease InOut</option>
                         </select>
                    </div>
                 </div>

                {/* Controls */}
                <div className="flex flex-col gap-2 mt-1">
                    <div className="flex gap-2">
                        <button
                            onClick={handleRun}
                            disabled={!movingPartId || !startMarker || !endMarker || isAnimationPlaying}
                            className="flex-1 py-2 bg-[var(--accent-color)] text-white font-bold rounded hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2 text-xs"
                        >
                            <Play className="w-3 h-3" />
                            RUN
                        </button>

                        {editingStepId ? (
                            <>
                                <button
                                    onClick={handleUpdateStep}
                                    disabled={!movingPartId || !startMarker || !endMarker}
                                    className="px-3 py-2 bg-yellow-500/20 text-yellow-400 border border-yellow-500/50 rounded hover:bg-yellow-500/30 disabled:opacity-30 disabled:cursor-not-allowed text-xs font-bold"
                                    title="Update Sequence Step"
                                >
                                    UPDATE
                                </button>
                                <button
                                    onClick={cancelEditing}
                                    className="px-3 py-2 bg-white/10 text-gray-400 border border-white/10 rounded hover:bg-white/20 text-xs"
                                    title="Cancel Editing"
                                >
                                    CANCEL
                                </button>
                            </>
                        ) : (
                            <button
                                onClick={handleAddToSequence}
                                disabled={!movingPartId || !startMarker || !endMarker}
                                className="px-3 py-2 bg-blue-500/20 text-blue-400 border border-blue-500/50 rounded hover:bg-blue-500/30 disabled:opacity-30 disabled:cursor-not-allowed"
                                title="Add to Sequence"
                            >
                                <Plus className="w-4 h-4" />
                            </button>
                        )}
                        
                        <button
                             onClick={handleReset}
                             className="px-3 py-2 bg-red-500/20 text-red-400 border border-red-500/50 rounded hover:bg-red-500/30"
                             title="Reset All Parts"
                        >
                            <RotateCcw className="w-4 h-4" />
                        </button>
                    </div>
                </div>
                
                 <div className="h-px bg-white/10 my-1" />
                
                 {/* Sequence List */}
                 <SequenceList onSelect={handleSelectStep} />
                 
                 <div className="h-px bg-white/10 my-1" />

                 {/* Chat Interface */}
                 <ChatInterface />

                <button 
                    onClick={() => useAppStore.getState().setCadUrl('/demo/Spark.glb', 'Spark.glb')}
                    className="text-[9px] text-gray-500 hover:text-white underline text-center mt-2"
                >
                    Load Demo (Spark.glb)
                </button>
            </div>
        </div>
    );
};
