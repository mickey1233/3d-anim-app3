/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useRef, useState } from 'react';
import { useGLTF, Html, TransformControls } from '@react-three/drei';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useAppStore } from '../../store/useAppStore';

// Inner Component that actually uses the hook
const InnerModel = ({ url }: { url: string }) => {
  const { 
      registerPart, selectPart, parts,
      pickingMode, setStartMarker, setEndMarker, startMarker, endMarker, 
      setPickingMode
  } = useAppStore();
  const { scene, gl, size, camera } = useThree();
  const [modelScene, setModelScene] = useState<THREE.Group | null>(null);

  // Load GLTF - URL is guaranteed valid here
  const gltf = useGLTF(url, true);

  // Initial Part Registration
  useEffect(() => {
    if (gltf.scene) {
      gltf.scene.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          if (!parts[mesh.uuid]) {
            registerPart({
              uuid: mesh.uuid,
              name: mesh.name || `Part_${mesh.uuid.slice(0,4)}`,
              position: [mesh.position.x, mesh.position.y, mesh.position.z],
              rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
              scale: [mesh.scale.x, mesh.scale.y, mesh.scale.z],
              color: '#' + (mesh.material as THREE.MeshStandardMaterial).color?.getHexString() || '#ffffff'
            });
          }
          mesh.userData.isPart = true;
        }
      });
      setModelScene(gltf.scene);
    }
  }, [url, gltf, registerPart]);

  useEffect(() => {
    if (!modelScene) return;
    Object.values(parts).forEach(part => {
      const object = modelScene.getObjectByProperty('uuid', part.uuid);
      if (object) {
        // NOTE: We do NOT reparent logic anymore to preserve R3F event bubbling.
        // We will handle world/local conversion in the Animator.
        
        // However, we still need to apply initial positions?
        // Actually the parts in store are just "registered" default positions initially?
        // Or updated positions.
        // If we don't reparent, we rely on the object being in its original hierarchy.
        // We must apply the store transforms.
        
        object.position.set(...part.position);
        object.rotation.set(...part.rotation);
        object.scale.set(...part.scale);
      }
    });
  }, [parts, modelScene]);

  const handlePointerDown = (e: any) => {
      e.stopPropagation();
      console.log(`[POINTER] Object: ${e.object.name}, Type: ${e.object.type}`);
      (window as any).__DEBUG_R3F_OBJ__ = e.object.name || 'Unnamed Object';
      handleClick(e);
  };

  const handleClick = (e: any) => {
    // If in Picking Mode, handle Face Picking
    if (pickingMode === 'start' || pickingMode === 'end') {
        const mesh = e.object as THREE.Mesh;
        if (!mesh.isMesh) {
             console.log("Picking: Ignored (Not a mesh)");
             return;
        }

        const face = e.face;
        if (!face) {
             console.log("Picking: Ignored (No face data)");
             return;
        }

        // --- NEW: Calculate Center of the Entire Coplanar Surface ---
        // 1. Get Local Normal and a Point on the clicked face
        const localNormal = face.normal.clone().normalize();
        const posAttr = mesh.geometry.attributes.position;
        const indexAttr = mesh.geometry.index;
        
        // Helper to get vertex at index
        const getV = (i: number) => {
            const v = new THREE.Vector3();
            v.fromBufferAttribute(posAttr, i);
            return v;
        };
        
        // Point on plane (Vertex A of clicked face)
        const planePoint = getV(face.a);
        
        // 2. Identify all triangles that are coplanar
        // Criteria: Same Normal (dot > 0.99) AND Coplanar (dist < 0.001)
        
        const triangleCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3;
        
        const triNormal = new THREE.Vector3();
        const triA = new THREE.Vector3();
        const triB = new THREE.Vector3();
        const triC = new THREE.Vector3();
        
        // Bounding Box for Coplanar Vertices
        const coplanarBox = new THREE.Box3();
        let matchCount = 0;
        
        for (let i = 0; i < triangleCount; i++) {
            let a, b, c;
            if (indexAttr) {
                a = indexAttr.getX(i * 3);
                b = indexAttr.getY(i * 3);
                c = indexAttr.getZ(i * 3);
            } else {
                a = i * 3;
                b = i * 3 + 1;
                c = i * 3 + 2;
            }
            
            triA.fromBufferAttribute(posAttr, a);
            triB.fromBufferAttribute(posAttr, b);
            triC.fromBufferAttribute(posAttr, c);
            
            // Calc Normal
            triNormal.subVectors(triC, triB).cross(new THREE.Vector3().subVectors(triA, triB)).normalize();
            
            // Check Normal match
            if (triNormal.dot(localNormal) > 0.99) {
                // Check if Coplanar
                const dist = new THREE.Vector3().subVectors(triA, planePoint).dot(localNormal);
                
                if (Math.abs(dist) < 0.001) {
                    // Coplanar! Add vertices to Box
                    coplanarBox.expandByPoint(triA);
                    coplanarBox.expandByPoint(triB);
                    coplanarBox.expandByPoint(triC);
                    matchCount++;
                }
            }
        }
        
        let centerLocal = new THREE.Vector3();
        if (!coplanarBox.isEmpty()) {
             coplanarBox.getCenter(centerLocal);
             console.log(`[SNAP] Found ${matchCount} coplanar triangles. Box Center:`, centerLocal);
        } else {
             // Fallback
             centerLocal.copy(planePoint);
             console.log("[SNAP] No coplanar faces found, using single point.");
        }
        
        // Convert to World Space
        const centerWorld = centerLocal.clone().applyMatrix4(mesh.matrixWorld);
        const pointData = [centerWorld.x, centerWorld.y, centerWorld.z] as [number, number, number];
        
        console.log(`[SNAP] Final World Point:`, pointData);
        // -----------------------------------------------------------

        if (pickingMode === 'start') {
             setStartMarker(pointData);
             setPickingMode('idle');
        } else {
             setEndMarker(pointData);
             setPickingMode('idle');
        }
        return; 
    }

    // Normal Selection
    if (e.object.userData.isPart) {
      console.log(`Select Part: ${e.object.name}`);
      selectPart(e.object.uuid);
    } else {
      console.log(`Deselect (Clicked ${e.object.type})`);
      selectPart(null);
    }
  };

  // Debug Camera
  useFrame(({ camera }) => {
      // Log camera if needed
  });

  const handlePointerMissed = (e: any) => {
      console.log('--- POINTER MISSED ---', e.type);
  };

  const controls = useThree((state) => state.controls);
  const { selectedPartId } = useAppStore();

  return (
    <group onPointerMissed={handlePointerMissed}>
        {/* Debug Red Cube for Verification */}
        <mesh position={[2, 0, 0]} onPointerDown={handlePointerDown}>
             <boxGeometry args={[0.5, 0.5, 0.5]} />
             <meshStandardMaterial color="red" />
             <Html position={[0, 0.6, 0]}>
                <div className="bg-black/50 text-white text-[10px] whitespace-nowrap px-1">Debug Cube</div>
             </Html>
        </mesh>

        {/* Actual Model */}
        <primitive 
            object={gltf.scene} 
            onPointerDown={handlePointerDown}
        />
      
        {/* Markers */}
        {startMarker && (
            <DraggableMarker 
                position={startMarker.position} 
                color="#4ade80" 
                label="Start"
                onDragEnd={(pos) => setStartMarker([pos.x, pos.y, pos.z])}
                controls={controls}
            />
        )}
        {endMarker && (
            <DraggableMarker 
                position={endMarker.position} 
                color="#60a5fa" 
                label="End"
                onDragEnd={(pos) => setEndMarker([pos.x, pos.y, pos.z])}
                controls={controls}
            />
        )}

        {/* Highlight Selected Part */}
        {selectedPartId && <PartHighlighter uuid={selectedPartId} scene={gltf.scene} />}
      
        {/* Labels - Filtered to only show registered parts */}
        {Object.values(parts).map(part => (
            <group key={part.uuid} position={new THREE.Vector3(...part.position)}>
                <Html distanceFactor={10} zIndexRange={[100, 0]} pointerEvents="none">
                    <div className="text-[8px] text-white/50 pointer-events-none whitespace-nowrap select-none bg-black/20 px-1 rounded backdrop-blur-[1px]">
                        {part.name}
                    </div>
                </Html>
            </group>
        ))}
    </group>
  );
};

// Component to Highlight Selected Part
const PartHighlighter = ({ uuid, scene }: { uuid: string, scene: THREE.Group }) => {
   const [targetObj, setTargetObj] = useState<THREE.Object3D | null>(null);

   useEffect(() => {
      const obj = scene.getObjectByProperty('uuid', uuid);
      if (obj) setTargetObj(obj);
   }, [uuid, scene]);

   if (!targetObj) return null;

   return <primitive object={new THREE.BoxHelper(targetObj, 0xffff00)} />;
}

const DraggableMarker = ({ position, color, label, onDragEnd, controls }: { 
    position: [number, number, number], 
    color: string, 
    label: string, 
    onDragEnd: (pos: THREE.Vector3) => void,
    controls: any 
}) => {
    const meshRef = useRef<THREE.Mesh>(null);
    return (
        <TransformControls 
            mode="translate"
            onMouseDown={() => { if(controls) controls.enabled = false; }}
            onMouseUp={() => { 
                if(controls) controls.enabled = true;
                if(meshRef.current) onDragEnd(meshRef.current.position);
            }}
        >
            <mesh ref={meshRef} position={new THREE.Vector3(...position)}>
                <sphereGeometry args={[0.05, 16, 16]} />
                <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.8} />
                <Html distanceFactor={10} pointerEvents="none">
                    <div style={{color}} className="text-[10px] font-bold bg-black/80 px-1 rounded border border-white/20 whitespace-nowrap">
                        {label}
                    </div>
                </Html>
            </mesh>
        </TransformControls>
    )
}

export const Model = () => {
  const { cadUrl } = useAppStore();
  if (!cadUrl) return null;
  return <InnerModel url={cadUrl} />;
}
