import React, { useRef, useState } from 'react';
import { useAppStore, ImageItem } from '../../store/useAppStore';
import { Reorder } from 'framer-motion';
import { Upload, GripVertical, Image as ImageIcon, ChevronDown, ChevronRight, Settings, Wrench } from 'lucide-react';
import * as THREE from 'three';

const SectionHeader = ({ title, icon: Icon, expanded, onClick }: { title: string, icon: any, expanded: boolean, onClick: () => void }) => (
    <div 
      onClick={onClick}
      className="flex items-center gap-2 cursor-pointer py-2 px-1 hover:bg-white/5 rounded select-none"
    >
        {expanded ? <ChevronDown className="w-3 h-3 text-[var(--text-secondary)]" /> : <ChevronRight className="w-3 h-3 text-[var(--text-secondary)]" />}
        <Icon className="w-3 h-3 text-[var(--accent-color)]" />
        <span className="text-xs uppercase font-bold text-[var(--text-secondary)] tracking-wider">{title}</span>
    </div>
);

export const ImageUploader: React.FC = () => {
  const { 
      images, addImage, reorderImages, parts, selectedImageId, selectImage, 
      cameraTransform, objectTransform, setCameraTransform, setObjectTransform 
  } = useAppStore();
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showCalibration, setShowCalibration] = useState(false);
  const [showTweaks, setShowTweaks] = useState(false);
  const [showDebug, setShowDebug] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      Array.from(e.target.files).forEach(file => {
        addImage(file);
      });
    }
  };

  const handleReorder = (newOrder: ImageItem[]) => {
     reorderImages(newOrder);
  };

  return (
    <div className="flex flex-col gap-2">
       {/* Upload Area - Always Visible but Compact */}
       <div 
        onClick={() => fileInputRef.current?.click()}
        className="
          border border-dashed border-[rgba(255,255,255,0.2)] 
          rounded p-3 flex items-center justify-center gap-2
          cursor-pointer hover:border-[var(--accent-color)] hover:bg-[rgba(255,255,255,0.05)]
          transition-all
        "
      >
        <Upload className="w-4 h-4 text-[var(--accent-color)]" />
        <span className="text-xs font-medium">Upload Images</span>
        <input 
          type="file" 
          ref={fileInputRef} 
          className="hidden" 
          accept="image/*" 
          multiple
          onChange={handleFileChange}
        />
      </div>

      {/* Global Calibration Settings */}
      <div className="bg-black/20 rounded px-2 border border-white/10 overflow-hidden">
         <SectionHeader title="Calibration" icon={Settings} expanded={showCalibration} onClick={() => setShowCalibration(!showCalibration)} />
         
         {showCalibration && (
            <div className="p-2 pt-0 flex flex-col gap-3 pb-3">
                 {/* Camera Space */}
                 <div>
                    <div className="text-[10px] font-bold mb-1 text-[var(--accent-color)]">Camera Space</div>
                    <div className="grid grid-cols-2 gap-2">
                       <div>
                         <div className="text-[10px] text-[var(--text-secondary)]">Position</div>
                         <input 
                            className="w-full bg-black/50 border border-white/10 rounded px-1 py-0.5 text-xs font-mono"
                            placeholder="0,0,0"
                            defaultValue={cameraTransform.position.join(',')}
                            onBlur={(e) => {
                                const val = e.target.value.split(',').map(Number);
                                if(val.length === 3) setCameraTransform(val as any, cameraTransform.rotation);
                            }}
                         />
                       </div>
                       <div>
                         <div className="text-[10px] text-[var(--text-secondary)]">Rotation</div>
                         <input 
                            className="w-full bg-black/50 border border-white/10 rounded px-1 py-0.5 text-xs font-mono"
                            placeholder="0,0,0"
                            defaultValue={cameraTransform.rotation.join(',')}
                            onBlur={(e) => {
                                const val = e.target.value.split(',').map(Number);
                                if(val.length === 3) setCameraTransform(cameraTransform.position, val as any);
                            }}
                         />
                       </div>
                    </div>
                 </div>
    
                 {/* Object Space */}
                 <div>
                    <div className="text-[10px] font-bold mb-1 text-[var(--accent-color)]">Object Space</div>
                    <div className="grid grid-cols-2 gap-2">
                       <div>
                         <div className="text-[10px] text-[var(--text-secondary)]">Translate</div>
                         <input 
                            className="w-full bg-black/50 border border-white/10 rounded px-1 py-0.5 text-xs font-mono"
                            placeholder="0,0,0"
                            defaultValue={objectTransform.position.join(',')}
                            onBlur={(e) => {
                                const val = e.target.value.split(',').map(Number);
                                if(val.length === 3) setObjectTransform(val as any, objectTransform.rotation);
                            }}
                         />
                       </div>
                       <div>
                         <div className="text-[10px] text-[var(--text-secondary)]">Rotate</div>
                         <input 
                            className="w-full bg-black/50 border border-white/10 rounded px-1 py-0.5 text-xs font-mono"
                            placeholder="0,0,0"
                            defaultValue={objectTransform.rotation.join(',')}
                            onBlur={(e) => {
                                const val = e.target.value.split(',').map(Number);
                                if(val.length === 3) setObjectTransform(objectTransform.position, val as any);
                            }}
                         />
                       </div>
                    </div>
                 </div>
    
                 <button 
                    onClick={() => useAppStore.getState().setCalibrationMode(true)}
                    className="w-full mt-2 py-1 bg-white/10 hover:bg-white/20 rounded text-[10px] text-center border border-white/10"
                 >
                    OPEN MANUAL ANCHOR TOOL
                 </button>
            </div>
         )}
      </div>

      {/* Manual Part Adjustment */}
      {Object.keys(parts).length > 0 && (
        <div className="bg-black/20 rounded px-2 border border-white/10 overflow-hidden">
            <SectionHeader title="Part Tweaks" icon={Wrench} expanded={showTweaks} onClick={() => setShowTweaks(!showTweaks)} />
            
            {showTweaks && (
                <div className="p-2 pt-0 flex flex-col gap-3 pb-3 max-h-[300px] overflow-y-auto custom-scrollbar">
                    {Object.entries(parts)
                        .filter(([_, p]) => p.name !== 'Base' && p.name !== 'merged')
                        .map(([uuid, part]) => (
                        <div key={uuid} className="border-t border-white/5 pt-2 first:border-t-0 first:pt-0">
                            <div className="text-[10px] font-bold mb-1 text-green-400">{part.name}</div>
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <div className="text-[10px] text-[var(--text-secondary)]">Pos</div>
                                    <input 
                                        className="w-full bg-black/50 border border-white/10 rounded px-1 py-0.5 text-xs font-mono"
                                        placeholder="0,0,0"
                                        defaultValue={part.position ? part.position.map(n=>n.toFixed(3)).join(',') : "0,0,0"}
                                        onBlur={(e) => {
                                            const val = e.target.value.split(',').map(Number);
                                            if(val.length === 3) useAppStore.getState().updatePart(uuid, { position: val as [number,number,number] });
                                        }}
                                        key={part.position?.join(',')} 
                                    />
                                </div>
                                <div>
                                    <div className="text-[10px] text-[var(--text-secondary)]">Rot</div>
                                    <input 
                                        className="w-full bg-black/50 border border-white/10 rounded px-1 py-0.5 text-xs font-mono"
                                        placeholder="0,0,0"
                                        defaultValue={part.rotation ? part.rotation.map(n=>n.toFixed(1)).join(',') : "0,0,0"}
                                        onBlur={(e) => {
                                            const val = e.target.value.split(',').map(Number);
                                            if(val.length === 3) useAppStore.getState().updatePart(uuid, { rotation: val as [number,number,number] });
                                        }}
                                        key={part.rotation?.join(',')}
                                    />
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
      )}

      {/* Debug Buttons - Collapsible */}
      <div className="flex flex-col">
         <div 
           onClick={() => setShowDebug(!showDebug)}
           className="text-[10px] text-[var(--text-secondary)] hover:text-white cursor-pointer select-none flex items-center gap-1 self-start opacity-70 hover:opacity-100"
         >
             {showDebug ? <ChevronDown className="w-3 h-3"/> : <ChevronRight className="w-3 h-3"/>}
             Debug / Demo Tools
         </div>
         
         {showDebug && (
             <div className="flex gap-2 flex-wrap mt-2 p-2 bg-black/20 rounded border border-white/5">
                 <button 
                    onClick={() => {
                    const file = new File(["foo"], "Debug_Image.png", { type: "image/png" });
                    addImage(file);
                    }}
                    className="text-[10px] text-gray-400 hover:text-white underline"
                >
                    Add Test Image
                </button>

                <button 
                    onClick={async () => {
                    try {
                        // 1. Load CAD
                        console.log("Loading Demo CAD...");
                        const cadBlob = await fetch('/demo/Spark.glb').then(r => r.blob());
                        const cadFile = new File([cadBlob], "Spark.glb", { type: "model/gltf-binary" });
                        const cadUrl = URL.createObjectURL(cadFile);
                        useAppStore.getState().setCadUrl(cadUrl, "Spark.glb");

                        // 2. Set Transforms
                        useAppStore.getState().setCameraTransform(
                            [147.8192099029741, 130.51526430927998, -238.96454223038023],
                            [-151.35, 28.5, 165.4] 
                        );
                        useAppStore.getState().setObjectTransform([0,0,0], [0,0,0]);

                        // 3. Load Images 
                        const imgNames = ["Spark1.png", "Spark2.png", "Spark3.png", "Spark4.png"];
                        for (const name of imgNames) {
                            const blob = await fetch(`/demo/${name}`).then(r => r.blob());
                            const file = new File([blob], name, { type: "image/png" });
                            addImage(file);
                            await new Promise(r => setTimeout(r, 100));
                        }
                    } catch (e) {
                        alert("Load Failed: " + e);
                    }
                    }}
                    className="text-[10px] text-[var(--accent-color)] hover:text-white underline font-bold"
                >
                    LOAD TEST SCENARIO
                </button>

                <button 
                    onClick={async () => {
                        try {
                        const res = await fetch('/demo/results.json').then(r => r.json());
                        const solvedImg = res.images.find((img: any) => img.status === "SOLVED" && img.camera);
                        if (!solvedImg) return;
                        
                        const camPose = solvedImg.camera.pose_world;
                        const q = new THREE.Quaternion(camPose.quaternion[0], camPose.quaternion[1], camPose.quaternion[2], camPose.quaternion[3]);
                        const qFix = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
                        q.multiply(qFix);
                        const euler = new THREE.Euler().setFromQuaternion(q);
                        const rotDeg = [ THREE.MathUtils.radToDeg(euler.x), THREE.MathUtils.radToDeg(euler.y), THREE.MathUtils.radToDeg(euler.z) ] as [number, number, number];
                        
                        useAppStore.getState().setCameraTransform( camPose.position as [number,number,number], rotDeg );
                        alert("Applied Camera Calibration");
                        } catch (e) { alert("Failed: " + e); }
                    }}
                    className="text-[10px] text-green-400 hover:text-white underline font-bold"
                >
                    APPLY RESULT
                </button>
             </div>
         )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs uppercase text-[var(--text-secondary)] font-bold tracking-wider">Sequence</h3>
        {/* Scrollable Image List */}
        <Reorder.Group axis="y" values={images} onReorder={handleReorder} className="flex flex-col gap-2 max-h-[150px] overflow-y-auto custom-scrollbar pr-1">
          {images.map((img) => {
            const isSelected = img.id === selectedImageId;
            return (
              <Reorder.Item key={img.id} value={img} 
                  onClick={() => selectImage(isSelected ? null : img.id)}
              >
                <div className={`
                  border rounded p-2 flex flex-col gap-2 cursor-pointer transition-colors
                  ${isSelected 
                     ? 'bg-[var(--accent-color)]/20 border-[var(--accent-color)]' 
                     : 'bg-[rgba(0,0,0,0.4)] border-[rgba(255,255,255,0.1)] hover:border-[rgba(255,255,255,0.3)]'}
                `}>
                  
                  <div className="flex items-center gap-3 w-full">
                      <GripVertical className="w-4 h-4 text-[var(--text-secondary)] cursor-grab active:cursor-grabbing" />
                      <div className="w-8 h-8 rounded overflow-hidden bg-black/50 shrink-0">
                        <img src={img.url} alt={img.name} className="w-full h-full object-cover" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] font-medium truncate" title={img.name}>{img.name}</div>
                        <div className="flex items-center gap-1">
                          <span className={`text-[9px] truncate ${isSelected ? 'text-white' : 'text-[var(--text-secondary)]'}`}>
                              {Object.keys(img.partPositions).length > 0 
                                ? `Detected: ${Object.keys(img.partPositions).length} parts` 
                                : 'Analyzing...'}
                          </span>
                        </div>
                      </div>
                  </div>

                </div>
              </Reorder.Item>
            );
          })}
        </Reorder.Group>
        {images.length === 0 && (
          <div className="text-center text-xs opacity-40 py-2">No images uploaded</div>
        )}
      </div>
    </div>
  );
};
