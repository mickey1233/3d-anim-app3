import React, { useState, useEffect } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Canvas, ThreeEvent } from '@react-three/fiber';
import { OrbitControls, useGLTF, Stage } from '@react-three/drei';
import * as THREE from 'three';

// 3D Scene Component for Picking
const PickingScene = ({ 
    cadUrl, 
    onPick 
}: { 
    cadUrl: string, 
    onPick: (p: [number,number,number]) => void 
}) => {
    const gltf = useGLTF(cadUrl);
    
    return (
        <Stage adjustCamera={1.5} intensity={0.5} environment="city">
           <primitive 
              object={gltf.scene} 
              onClick={(e: ThreeEvent<MouseEvent>) => {
                  e.stopPropagation();
                  // Point is Vector3
                  onPick([e.point.x, e.point.y, e.point.z]);
              }}
           />
        </Stage>
    );
};

export const AnnotationTool: React.FC = () => {
    const { 
        images, selectedImageId, cadUrl, 
        calibrationPoints, addCalibrationPoint, removeCalibrationPoint, clearCalibrationPoints 
    } = useAppStore();

    const [current2D, setCurrent2D] = useState<[number, number] | null>(null);
    const [current3D, setCurrent3D] = useState<[number, number, number] | null>(null);
    const [activePartId, setActivePartId] = useState<string>("merged"); // Default to merged/base
    
    const selectedImage = images.find(i => i.id === selectedImageId);

    if (!selectedImage || !cadUrl) {
        return <div className="p-4 text-center text-gray-500">Select an Image and ensure CAD is loaded to calibrate.</div>;
    }

    const handleCopyJSON = () => {
        const data = {
            images: images.map(img => ({
                imageId: img.id,
                file: img.name,
                points: calibrationPoints
                    .filter(p => p.imageId === img.id)
                    .map(p => ({ partId: p.partId, p2d: p.p2d, p3d: p.p3d })) // Group by Part? No, list is fine if tagged.
            })).filter(Group => Group.points.length > 0)
        };
        const jsonStr = JSON.stringify(data, null, 2);
        console.log("Calibration Data:", jsonStr);
        window.prompt("Copy this JSON:", jsonStr);
    };

    return (
        <div className="flex flex-col h-full bg-black/90 text-white relative z-50 p-4 gap-4">
            <div className="flex items-center gap-8 border-b border-white/20 pb-2 bg-black/80 px-4 py-2 rounded">
                <h2 className="text-xl font-bold text-[var(--accent-color)]">Geometry Calibration</h2>
                
                {/* Part Selector - Moved to Left to avoid Close Button on Right */}
                <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-gray-400">Target Part:</span>
                    <select 
                        value={activePartId} 
                        onChange={(e) => setActivePartId(e.target.value)}
                        className="bg-gray-800 border border-[var(--accent-color)] rounded px-3 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[var(--accent-color)]"
                    >
                        <option value="merged">Base (merged)</option>
                        <option value="Part1">Part1 (Lid/Insert)</option>
                        <option value="Part2">Part2</option>
                        <option value="Part3">Part3</option>
                    </select>
                </div>
            </div>

            <div className="flex flex-1 gap-4 min-h-0">
                {/* 2D View */}
                <div className="flex-1 border border-white/10 rounded overflow-hidden relative bg-black">
                    <div className="absolute top-2 left-2 z-10 bg-black/50 px-2 py-1 text-xs">
                        1. Select Point on Image for <b>{activePartId}</b>
                        {current2D && <div className="text-green-400">Selected: {current2D[0].toFixed(0)}, {current2D[1].toFixed(0)}</div>}
                    </div>
                    {/* ... (Image Component) ... */}
                    <div className="w-full h-full overflow-auto flex items-center justify-center">
                        <div className="relative inline-block">
                             <img 
                                src={selectedImage.url} 
                                className="max-w-none cursor-crosshair" 
                                style={{ maxHeight: '600px' }} 
                                onClick={(e) => {
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const x = e.clientX - rect.left;
                                    const y = e.clientY - rect.top;
                                    const scaleX = e.currentTarget.naturalWidth / e.currentTarget.width;
                                    const scaleY = e.currentTarget.naturalHeight / e.currentTarget.height;
                                    setCurrent2D([x * scaleX, y * scaleY]);
                                }}
                             />
                             {/* Markers: Color code by Part ID? */}
                             {calibrationPoints.filter(p => p.imageId === selectedImageId).map((p, idx) => (
                                <div key={p.id} className="absolute w-2 h-2 rounded-full border border-white -translate-x-1 -translate-y-1 bg-red-500 pointer-events-none"
                                     style={{ display: 'none' }} // Still hidden as we don't have exact overlay scale logic in React yet
                                />
                             ))}
                        </div>
                    </div>
                </div>

                {/* 3D View */}
                <div className="flex-1 border border-white/10 rounded overflow-hidden relative bg-gray-900">
                    <div className="absolute top-2 left-2 z-10 bg-black/50 px-2 py-1 text-xs pointer-events-none">
                        2. Select Corresponding Point on 3D Model
                        {current3D && <div className="text-green-400">Selected: {current3D.map(v=>v.toFixed(3)).join(',')}</div>}
                    </div>
                     <Canvas shadows camera={{ position: [5, 5, 5], fov: 50 }}>
                         <PickingScene cadUrl={cadUrl} onPick={setCurrent3D} />
                         <OrbitControls makeDefault />
                     </Canvas>
                </div>
            </div>

            {/* Controls */}
            <div className="h-40 border-t border-white/20 pt-2 flex gap-4">
                <div className="flex flex-col gap-2 w-48">
                     <button 
                        disabled={!current2D || !current3D}
                        onClick={() => {
                            if(current2D && current3D && selectedImageId) {
                                addCalibrationPoint(selectedImageId, activePartId, current2D, current3D);
                                setCurrent2D(null);
                                setCurrent3D(null);
                            }
                        }}
                        className="w-full py-2 bg-[var(--accent-color)] disabled:opacity-50 disabled:cursor-not-allowed rounded font-bold"
                     >
                        Add Pair ({activePartId})
                     </button>
                     <div className="text-xs text-gray-400 text-center">
                         Need 4+ points per Moving Part.
                     </div>
                     
                     <button onClick={handleCopyJSON} className="w-full py-2 bg-blue-600 rounded font-bold hover:bg-blue-500 mt-4">
                        EXPORT JSON
                     </button>
                </div>
                
                <div className="flex-1 overflow-auto bg-black/30 rounded p-2">
                    <table className="w-full text-xs text-left">
                        <thead>
                            <tr className="text-gray-500 border-b border-white/10">
                                <th className="p-1">Part</th>
                                <th className="p-1">2D (px)</th>
                                <th className="p-1">3D (m)</th>
                                <th className="p-1">Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {calibrationPoints.filter(p => p.imageId === selectedImageId).map((p, idx) => (
                                <tr key={p.id} className="border-b border-white/5 hover:bg-white/5">
                                    <td className="p-1 font-bold text-gray-300">{p.partId}</td>
                                    <td className="p-1">{p.p2d[0].toFixed(0)}, {p.p2d[1].toFixed(0)}</td>
                                    <td className="p-1">{p.p3d.map(v=>v.toFixed(2)).join(',')}</td>
                                    <td className="p-1">
                                        <button onClick={() => removeCalibrationPoint(p.id)} className="text-red-400 hover:text-red-300">
                                            Remove
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};
