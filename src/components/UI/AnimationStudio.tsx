import React from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Target, MousePointer2, Play, Settings, RotateCcw } from 'lucide-react';
import * as THREE from 'three';

export const AnimationStudio: React.FC = () => {
    const { 
        parts, movingPartId, setMovingPartId,
        pickingMode, setPickingMode,
        startMarker, endMarker, setStartMarker, setEndMarker,
        animationDuration, animationEasing, setAnimationConfig,
        isAnimationPlaying, setAnimationPlaying,
        updatePart
    } = useAppStore();

    const handleRun = () => {
        if (!movingPartId || !startMarker || !endMarker) return;
        setAnimationPlaying(true);
        // Animation Logic is handled in Scene.tsx (PartAnimator)
    };

    const handleReset = () => {
        setAnimationPlaying(false);
        if (movingPartId && startMarker) {
             // Reset to Start
             updatePart(movingPartId, { position: startMarker.position });
        }
    };

    return (
        <div className="bg-black/40 backdrop-blur-md rounded-lg p-4 border border-white/10 flex flex-col gap-4">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                <Settings className="w-4 h-4 text-[var(--accent-color)]" />
                Animation Studio
            </h3>
            
            <div className="flex flex-col gap-3">
                {/* 1. Select Moving Object */}
                <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase text-gray-500 font-bold">Target Object</label>
                    <select 
                        value={movingPartId || ''}
                        onChange={(e) => setMovingPartId(e.target.value || null)}
                        className="bg-black/50 border border-white/10 rounded px-2 py-1 text-xs text-white"
                    >
                        <option value="">-- Select Object to Move --</option>
                        {Object.values(parts).map(part => (
                            <option key={part.uuid} value={part.uuid}>{part.name}</option>
                        ))}
                    </select>
                </div>

                {/* 2. Start/End Points */}
                <div className="grid grid-cols-2 gap-2">
                    {/* Start Point */}
                    <div className={`p-2 rounded border ${pickingMode === 'start' ? 'border-green-400 bg-green-400/10' : 'border-white/10 bg-black/20'}`}>
                        <div className="flex justify-between items-center mb-1">
                            <span className="text-[10px] font-bold text-gray-300">Start Point</span>
                            <button 
                                onClick={() => setPickingMode(pickingMode === 'start' ? 'idle' : 'start')}
                                className={`p-1 rounded transition-colors ${pickingMode === 'start' ? 'bg-green-400 text-black' : 'bg-white/10 hover:bg-white/20'}`}
                                title="Pick Face Center"
                            >
                                <MousePointer2 className="w-3 h-3" />
                            </button>
                        </div>
                        <div className="text-[9px] text-gray-400 font-mono truncate">
                            {startMarker ? startMarker.position.map(n=>n.toFixed(2)).join(',') : 'Not set'}
                        </div>
                        <button 
                           onClick={() => setStartMarker(null)} 
                           className="text-[8px] text-red-400 hover:text-red-300 mt-1"
                        >Clear</button>
                    </div>

                    {/* End Point */}
                    <div className={`p-2 rounded border ${pickingMode === 'end' ? 'border-blue-400 bg-blue-400/10' : 'border-white/10 bg-black/20'}`}>
                        <div className="flex justify-between items-center mb-1">
                            <span className="text-[10px] font-bold text-gray-300">End Point</span>
                            <button 
                                onClick={() => setPickingMode(pickingMode === 'end' ? 'idle' : 'end')}
                                className={`p-1 rounded transition-colors ${pickingMode === 'end' ? 'bg-blue-400 text-black' : 'bg-white/10 hover:bg-white/20'}`}
                                title="Pick Face Center"
                            >
                                <MousePointer2 className="w-3 h-3" />
                            </button>
                        </div>
                         <div className="text-[9px] text-gray-400 font-mono truncate">
                            {endMarker ? endMarker.position.map(n=>n.toFixed(2)).join(',') : 'Not set'}
                        </div>
                         <button 
                           onClick={() => setEndMarker(null)} 
                           className="text-[8px] text-red-400 hover:text-red-300 mt-1"
                        >Clear</button>
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
                <div className="flex gap-2 mt-2">
                    <button
                        onClick={handleRun}
                        disabled={!movingPartId || !startMarker || !endMarker || isAnimationPlaying}
                        className="flex-1 py-2 bg-[var(--accent-color)] text-white font-bold rounded hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2 text-xs"
                    >
                        <Play className="w-3 h-3" />
                        RUN
                    </button>
                    <button
                        onClick={handleReset}
                        className="px-3 py-2 bg-white/10 text-white rounded hover:bg-white/20 flex items-center justify-center"
                        title="Reset Position"
                    >
                        <RotateCcw className="w-3 h-3" />
                    </button>
                </div>
                
                 <div className="h-px bg-white/10 my-1" />
                
                <button 
                    onClick={() => useAppStore.getState().setCadUrl('/demo/Spark.glb', 'Spark.glb')}
                    className="text-[9px] text-gray-500 hover:text-white underline text-center"
                >
                    Load Demo (Spark.glb)
                </button>
            </div>
        </div>
    );
};
