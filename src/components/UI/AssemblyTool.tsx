import React from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Target, MousePointer2, Play } from 'lucide-react';
import * as THREE from 'three';

export const AssemblyTool: React.FC = () => {
    const { 
        assemblyMode, setAssemblyMode, 
        assemblySource, assemblyTarget,
        setAssemblySource, setAssemblyTarget,
        updatePart, parts
    } = useAppStore();

    const handleRun = () => {
        if (!assemblySource || !assemblyTarget) return;

        console.log("Running Assembly:", assemblySource, "->", assemblyTarget);

        // Calculate Delta in World Space
        const pStart = new THREE.Vector3(...assemblySource.point);
        const pEnd = new THREE.Vector3(...assemblyTarget.point);
        const delta = new THREE.Vector3().subVectors(pEnd, pStart);

        // Apply Delta to Source Part
        // Note: We need to apply this delta to the Part's Position.
        // Since we fixed Model.tsx to ensure Part Position == World Position (via scene.attach),
        // we can simply add the delta.
        
        const sourcePart = parts[assemblySource.partId];
        if (sourcePart) {
            const currentPos = new THREE.Vector3(...sourcePart.position);
            const newPos = currentPos.add(delta);

            // Animate? For now, snap.
            // Or use a simple loop.
            // Let's just update store, Scene handles Lerp if we implemented it, or snap.
            // If we want animation "Walk", we should assume this tool runs the animation.
            // But User said: "Run... move first object from initial to final".
            
            updatePart(assemblySource.partId, {
                position: [newPos.x, newPos.y, newPos.z]
            });
            
            // Clear Selection?
            setAssemblyMode('idle');
            setAssemblySource(assemblySource.partId, [newPos.x, newPos.y, newPos.z]); // Update source to new pos
        }
    };

    return (
        <div className="bg-black/40 backdrop-blur-md rounded-lg p-4 border border-white/10 flex flex-col gap-4">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                <Target className="w-4 h-4 text-green-400" />
                Assembly Tool
            </h3>
            
            <div className="flex flex-col gap-3">
                {/* Source Selection */}
                <div className={`p-3 rounded border ${assemblyMode === 'pick_source' ? 'border-green-400 bg-green-400/10' : 'border-white/10 bg-black/20'}`}>
                    <div className="flex justify-between items-center mb-2">
                        <span className="text-xs font-bold text-gray-300">1. Initial Position (Face Center)</span>
                        <button 
                            onClick={() => setAssemblyMode(assemblyMode === 'pick_source' ? 'idle' : 'pick_source')}
                            className={`p-1.5 rounded transition-colors ${assemblyMode === 'pick_source' ? 'bg-green-400 text-black' : 'bg-white/10 hover:bg-white/20'}`}
                        >
                            <MousePointer2 className="w-4 h-4" />
                        </button>
                    </div>
                    {assemblySource ? (
                         <div className="text-[10px] text-green-300">
                            Part: {parts[assemblySource.partId]?.name || 'Unknown'} <br/>
                            Loc: {assemblySource.point.map(v=>v.toFixed(3)).join(', ')}
                         </div>
                    ) : (
                        <div className="text-[10px] text-gray-500 italic">Select a face...</div>
                    )}
                </div>

                {/* Target Selection */}
                <div className={`p-3 rounded border ${assemblyMode === 'pick_target' ? 'border-blue-400 bg-blue-400/10' : 'border-white/10 bg-black/20'}`}>
                    <div className="flex justify-between items-center mb-2">
                        <span className="text-xs font-bold text-gray-300">2. Final Position (Target Face)</span>
                        <button 
                             onClick={() => setAssemblyMode(assemblyMode === 'pick_target' ? 'idle' : 'pick_target')}
                             className={`p-1.5 rounded transition-colors ${assemblyMode === 'pick_target' ? 'bg-blue-400 text-black' : 'bg-white/10 hover:bg-white/20'}`}
                        >
                            <MousePointer2 className="w-4 h-4" />
                        </button>
                    </div>
                    {assemblyTarget ? (
                         <div className="text-[10px] text-blue-300">
                            Part: {parts[assemblyTarget.partId]?.name || 'Unknown'} <br/>
                            Loc: {assemblyTarget.point.map(v=>v.toFixed(3)).join(', ')}
                         </div>
                    ) : (
                        <div className="text-[10px] text-gray-500 italic">Select a face...</div>
                    )}
                </div>

                {/* Run Button */}
                <button
                    onClick={handleRun}
                    disabled={!assemblySource || !assemblyTarget}
                    className="w-full py-3 bg-[var(--accent-color)] text-white font-bold rounded hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2"
                >
                    <Play className="w-4 h-4" />
                    ASSEMBLE
                </button>

                <div className="h-px bg-white/10 my-2" />
                
                <button 
                    onClick={() => useAppStore.getState().setCadUrl('/demo/Spark.glb', 'Spark.glb')}
                    className="text-[10px] text-gray-500 hover:text-white underline text-center"
                >
                    Load Demo (Spark.glb)
                </button>
            </div>
        </div>
    );
};
