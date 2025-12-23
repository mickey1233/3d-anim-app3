import React, { useRef } from 'react';
import { useAppStore, ImageItem } from '../../store/useAppStore';
import { Reorder } from 'framer-motion';
import { Upload, GripVertical, Image as ImageIcon } from 'lucide-react';
import * as THREE from 'three';

export const ImageUploader: React.FC = () => {
  const { 
      images, addImage, reorderImages, parts, selectedImageId, selectImage, 
      cameraTransform, objectTransform, setCameraTransform, setObjectTransform 
  } = useAppStore();
  
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    <div className="flex flex-col gap-4">
       {/* ... Upload ... */}
       
       <div 
        onClick={() => fileInputRef.current?.click()}
        className="
          border-2 border-dashed border-[rgba(255,255,255,0.2)] 
          rounded-lg p-6 flex flex-col items-center justify-center gap-2
          cursor-pointer hover:border-[var(--accent-color)] hover:bg-[rgba(255,255,255,0.05)]
          transition-all
        "
      >
        <Upload className="w-6 h-6 text-[var(--accent-color)]" />
        <span className="text-sm font-medium">Upload Images</span>
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
      <div className="bg-black/20 rounded p-3 border border-white/10">
         <h3 className="text-xs uppercase text-[var(--text-secondary)] font-bold mb-2">Global Calibration</h3>
         
         <div className="flex flex-col gap-3">
             {/* Camera Space */}
             <div>
                <div className="text-[10px] font-bold mb-1 text-[var(--accent-color)]">Camera Space</div>
                <div className="grid grid-cols-2 gap-2">
                   <div>
                     <div className="text-[10px] text-[var(--text-secondary)]">Position (x,y,z)</div>
                     <input 
                        className="w-full bg-black/50 border border-white/10 rounded px-1 py-0.5 text-xs"
                        placeholder="0,0,0"
                        defaultValue={cameraTransform.position.join(',')}
                        onBlur={(e) => {
                            const val = e.target.value.split(',').map(Number);
                            if(val.length === 3) setCameraTransform(val as any, cameraTransform.rotation);
                        }}
                     />
                   </div>
                   <div>
                     <div className="text-[10px] text-[var(--text-secondary)]">Rotation (deg)</div>
                     <input 
                        className="w-full bg-black/50 border border-white/10 rounded px-1 py-0.5 text-xs"
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
                 {/* ... inputs ... */}
                 
                 {/* ... keep inputs ... */}
                 <div className="grid grid-cols-2 gap-2">
                   {/* ... keep ... */}
                   <div>
                     <div className="text-[10px] text-[var(--text-secondary)]">Translate (x,y,z)</div>
                     <input 
                        className="w-full bg-black/50 border border-white/10 rounded px-1 py-0.5 text-xs"
                        placeholder="0,0,0"
                        defaultValue={objectTransform.position.join(',')}
                        onBlur={(e) => {
                            const val = e.target.value.split(',').map(Number);
                            if(val.length === 3) setObjectTransform(val as any, objectTransform.rotation);
                        }}
                     />
                   </div>
                   <div>
                     <div className="text-[10px] text-[var(--text-secondary)]">Rotate (deg)</div>
                     <input 
                        className="w-full bg-black/50 border border-white/10 rounded px-1 py-0.5 text-xs"
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
      </div>

      {/* Manual Part Adjustment */}
      {Object.keys(parts).length > 0 && (
        <div className="bg-black/20 rounded p-3 border border-white/10 mt-2">
            <h3 className="text-xs uppercase text-[var(--text-secondary)] font-bold mb-2">Part Tweaks</h3>
            <div className="flex flex-col gap-3">
                {Object.entries(parts)
                    .filter(([_, p]) => p.name !== 'Base' && p.name !== 'merged')
                    .map(([uuid, part]) => (
                    <div key={uuid} className="border-t border-white/5 pt-2">
                        <div className="text-[10px] font-bold mb-1 text-green-400">{part.name}</div>
                        <div className="grid grid-cols-2 gap-2">
                            <div>
                                <div className="text-[10px] text-[var(--text-secondary)]">Pos (x,y,z)</div>
                                <input 
                                    className="w-full bg-black/50 border border-white/10 rounded px-1 py-0.5 text-xs"
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
                                <div className="text-[10px] text-[var(--text-secondary)]">Rot (deg)</div>
                                <input 
                                    className="w-full bg-black/50 border border-white/10 rounded px-1 py-0.5 text-xs"
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
        </div>
      )}

      {/* Debug Buttons */}
      <div className="flex gap-2 self-center flex-wrap justify-center">
         <button 
            onClick={() => {
               // Mock file for testing
               const file = new File(["foo"], "Debug_Image.png", { type: "image/png" });
               addImage(file);
            }}
            className="text-[10px] text-gray-500 hover:text-white underline"
         >
            DEBUG: Add Test Image
         </button>

         <button 
            onClick={async () => {
               try {
                  // 1. Load CAD
                  console.log("Loading Demo CAD...");
                  const cadBlob = await fetch('/demo/Spark.glb').then(r => r.blob());
                  const cadFile = new File([cadBlob], "Spark.glb", { type: "model/gltf-binary" });
                  // We need to bypass setCadUrl which expects URL string, or use store action?
                  // Store has `setCadUrl(url, name)`.
                  const cadUrl = URL.createObjectURL(cadFile);
                  useAppStore.getState().setCadUrl(cadUrl, "Spark.glb");

                  // 2. Set Transforms
                  console.log("Setting Transforms...");
                  useAppStore.getState().setCameraTransform(
                      [147.8192099029741, 130.51526430927998, -238.96454223038023],
                      [-151.35, 28.5, 165.4] 
                  );
                  useAppStore.getState().setObjectTransform([0,0,0], [0,0,0]);

                  // 3. Load Images (Sequential to preserve order)
                  const imgNames = ["Spark1.png", "Spark2.png", "Spark3.png", "Spark4.png"];
                  for (const name of imgNames) {
                      console.log(`Loading ${name}...`);
                      const blob = await fetch(`/demo/${name}`).then(r => r.blob());
                      const file = new File([blob], name, { type: "image/png" });
                      addImage(file);
                      // Slight delay to ensure order?
                      await new Promise(r => setTimeout(r, 100));
                  }
                  
               } catch (e) {
                  console.error("Demo Load Failed:", e);
                  alert("Failed to load demo assets. Check console.");
               }
            }}
            className="text-[10px] text-[var(--accent-color)] hover:text-white underline font-bold"
         >
            LOAD TEST SCENARIO
         </button>

          <button 
             onClick={async () => {
                try {
                   console.log("Loading Calibration Results...");
                   const res = await fetch('/demo/results.json').then(r => r.json());
                   const solvedImg = res.images.find((img: any) => img.status === "SOLVED" && img.camera);
                   if (!solvedImg) { alert("No solved camera found."); return; }
                   
                   const camPose = solvedImg.camera.pose_world;
                   
                   // Coordinate Fix: Rotate 180 deg around X
                   const q = new THREE.Quaternion(camPose.quaternion[0], camPose.quaternion[1], camPose.quaternion[2], camPose.quaternion[3]);
                   const qFix = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
                   q.multiply(qFix);

                   const euler = new THREE.Euler().setFromQuaternion(q);
                   const rotDeg = [ THREE.MathUtils.radToDeg(euler.x), THREE.MathUtils.radToDeg(euler.y), THREE.MathUtils.radToDeg(euler.z) ] as [number, number, number];
                   
                   useAppStore.getState().setCameraTransform( camPose.position as [number,number,number], rotDeg );
                   
                   if (solvedImg.parts) {
                       solvedImg.parts.forEach((p: any) => {
                           const store = useAppStore.getState();
                           const targetUuid = Object.keys(store.parts).find(uuid => store.parts[uuid].name === p.id);
                           if (targetUuid) {
                               const pq = new THREE.Quaternion(p.pose_world.quaternion[0], p.pose_world.quaternion[1], p.pose_world.quaternion[2], p.pose_world.quaternion[3]);
                               pq.multiply(qFix); // Re-apply fix (Visually required)
                               
                               const pe = new THREE.Euler().setFromQuaternion(pq);
                               const prot = [ THREE.MathUtils.radToDeg(pe.x), THREE.MathUtils.radToDeg(pe.y), THREE.MathUtils.radToDeg(pe.z) ] as [number, number, number];
                               useAppStore.getState().updatePart(targetUuid, { position: p.pose_world.position as [number,number,number], rotation: prot });
                           }
                       });
                   }
                   alert("Calibration Applied! Use Manual Tweaks if needed.");
                } catch (e) { alert("Failed: " + e); }
             }}
             className="text-[10px] text-green-400 hover:text-white underline font-bold"
          >
             APPLY RESULT
          </button>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs uppercase text-[var(--text-secondary)] font-bold tracking-wider">Sequence</h3>
        <Reorder.Group axis="y" values={images} onReorder={handleReorder} className="flex flex-col gap-2">
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
                      <div className="w-10 h-10 rounded overflow-hidden bg-black/50 shrink-0">
                        <img src={img.url} alt={img.name} className="w-full h-full object-cover" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium truncate" title={img.name}>{img.name}</div>
                        <div className="flex items-center gap-1 mt-1">
                          <span className={`text-[10px] truncate ${isSelected ? 'text-white' : 'text-[var(--text-secondary)]'}`}>
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
          <div className="text-center text-xs opacity-40 py-4">No images uploaded</div>
        )}
      </div>
    </div>
  );
};
