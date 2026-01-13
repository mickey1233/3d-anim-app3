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
  const [selectedMarkerId, setSelectedMarkerId] = useState<'start' | 'end' | null>(null);

  return (
    <group onPointerMissed={(e) => {
        handlePointerMissed(e);
        setSelectedMarkerId(null);
    }}>


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
                isSelected={selectedMarkerId === 'start'}
                onSelect={() => setSelectedMarkerId('start')}
            />
        )}
        {endMarker && (
            <DraggableMarker 
                position={endMarker.position} 
                color="#60a5fa" 
                label="End"
                onDragEnd={(pos) => setEndMarker([pos.x, pos.y, pos.z])}
                controls={controls}
                isSelected={selectedMarkerId === 'end'}
                onSelect={() => setSelectedMarkerId('end')}
            />
        )}

        {/* Highlight Selected Part */}
        {selectedPartId && <PartHighlighter uuid={selectedPartId} scene={gltf.scene} />}
      
        {/* Labels - Filtered to only show registered parts */}

    </group>
  );
};

// Component to Highlight Selected Part
import { computeSmartOBB } from '../../utils/OBBUtils';

const PartHighlighter = ({ uuid, scene }: { uuid: string, scene: THREE.Group }) => {
   const [helper, setHelper] = useState<THREE.Object3D | null>(null);

   useFrame(() => {
       if (helper && scene) {
           const obj = scene.getObjectByProperty('uuid', uuid);
           if (obj && trackedMeshRef.current && helper.userData.basis) {
                // Determine Final Matrix: Object World * PCA Basis
                // Helper matrix = MeshWorld * PCAKey
                const meshWorld = trackedMeshRef.current.matrixWorld;
                const pcaBasis = helper.userData.basis as THREE.Matrix4;
                
                helper.matrix.multiplyMatrices(meshWorld, pcaBasis);
           }
       }
   });

   // Ref to store the tracked mesh for useFrame
   const trackedMeshRef = useRef<THREE.Mesh | null>(null);

   useEffect(() => {
      const obj = scene.getObjectByProperty('uuid', uuid);
      if (obj) {
          // Force update to ensure clean state
          obj.updateWorldMatrix(true, true);

          // 1. Find all visible meshes
          const meshes: THREE.Mesh[] = [];
          obj.traverse((child) => {
              if ((child as THREE.Mesh).isMesh && child.visible) {
                  meshes.push(child as THREE.Mesh);
              }
          });

          // 2. Single Mesh -> Show OBB (Tight & Oriented via PCA)
          if (meshes.length === 1) {
              const mesh = meshes[0];
              trackedMeshRef.current = mesh; 

              // Use Smart PCA OBB
              const { center, size, basis } = computeSmartOBB(mesh);
              
              // Create Wireframe Box
              const geom = new THREE.BoxGeometry(size.x, size.y, size.z);
              const edges = new THREE.EdgesGeometry(geom);
              const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffff00 }));
              
              // Store Basis for Sync
              line.userData.basis = basis;
              
              // Offset geometry to match PCA center (which is in local space relative to mesh)
              // But we are applying "basis" check? 
              // computeSmartOBB returns center in LOCAL SPACE (relative to mesh pivot), but already "rotated" into Basis? NO.
              // It returns center in LOCAL SPACE.
              // BUT if we apply `basis` as a rotation, the box is aligned to basis.
              // We need to transform the box geometry to be centered at `center`.
              // But `basis` rotates around (0,0,0).
              // Let's think: 
              // mesh.matrixWorld transforms Local -> World.
              // basis transforms Eigen -> Local (Pure Rotation).
              // BoxGeometry is AABB in Eigen Space.
              // `center` is in Local Space.
              
              // Decompose:
              // We want Helper transform T_h.
              // T_h * v_box = T_mesh * v_local
              // v_local = Basis * v_eigen + Center? No.
              // The PCA Logic: v_local = Center + Basis * v_box_centered
              // So T_h = T_mesh
              // And inside T_h, we effectively render: Basis * v + Center_local_rotated?
              
              // EASIER WAY:
              // Construct the Matrix4 that represents the OBB Frame in LOCAL Space.
              // Position = center. Rotation = basis. Scale = 1.
              // Construct the Matrix4 that represents the OBB Frame in LOCAL Space.
              const localOBBMatrix = new THREE.Matrix4();
              
              // Wait, basis IS the rotation matrix.
              localOBBMatrix.copy(basis);
              localOBBMatrix.setPosition(center);
              
              // Store this LOCAL offset matrix.
              line.userData.basis = localOBBMatrix;

              // Apply World Matrix (Initial)
              // line.matrix = mesh.matrixWorld * localOBBMatrix
              line.matrixAutoUpdate = false;
              line.matrix.multiplyMatrices(mesh.matrixWorld, localOBBMatrix);
              
              console.log(`[PCA-OBB] Highlighting Single Mesh: ${mesh.name}`);
              setHelper(line);
          } 
          // 3. Multiple Meshes -> Fallback As Before
          else {
              trackedMeshRef.current = null;
              const box = new THREE.Box3();
              let foundMesh = false;
              meshes.forEach(mesh => {
                  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
                  const localBox = mesh.geometry.boundingBox!.clone();
                  localBox.applyMatrix4(mesh.matrixWorld);
                  box.union(localBox);
                  foundMesh = true;
              });
              if (!foundMesh) box.setFromObject(obj);
              setHelper(new THREE.Box3Helper(box, 0xffff00));
          }
      } else {
          setHelper(null);
          trackedMeshRef.current = null;
      }
   }, [uuid, scene]);
   
   if (!helper) return null;
   return <primitive object={helper} />;
}

const DraggableMarker = ({ position, color, label, onDragEnd, controls, isSelected, onSelect }: { 
    position: [number, number, number], 
    color: string, 
    label: string, 
    onDragEnd: (pos: THREE.Vector3) => void,
    controls: any,
    isSelected: boolean,
    onSelect: () => void
}) => {
    const transformRef = useRef<any>(null);
    const meshRef = useRef<THREE.Mesh>(null);
    
    // Manage OrbitControls enablement during drag
    useEffect(() => {
        if (transformRef.current) {
            const controlsObj = transformRef.current;
            const callback = (event: any) => {
                const isDragging = event.value;
                if (controls) controls.enabled = !isDragging;
                
                // Sync on drag end
                if (!isDragging && meshRef.current) {
                    onDragEnd(meshRef.current.position);
                }
            };
            controlsObj.addEventListener('dragging-changed', callback);
            return () => controlsObj.removeEventListener('dragging-changed', callback);
        }
    }, [controls, onDragEnd]);

    return (
        <TransformControls 
            ref={transformRef}
            mode="translate"
            enabled={isSelected}
            showX={isSelected}
            showY={isSelected}
            showZ={isSelected}
            // If not selected, we don't want the gizmo to intercept rays, 
            // but we want the mesh to be clickable.
        >
            <mesh 
                ref={meshRef} 
                position={new THREE.Vector3(...position)}
                onClick={(e) => {
                    e.stopPropagation();
                    onSelect();
                }}
            >
                <sphereGeometry args={[0.08, 16, 16]} />
                <meshBasicMaterial 
                    color={isSelected ? '#ffffff' : color} 
                    depthTest={false} 
                    transparent 
                    opacity={0.9} 
                />
                <Html position={[0, 0.15, 0]} distanceFactor={10} pointerEvents="none" center>
                    <div style={{color: isSelected ? '#ffffff' : color}} className="text-[10px] font-bold bg-black/60 px-1.5 py-0.5 rounded border border-white/20 whitespace-nowrap backdrop-blur-sm shadow-sm transition-colors">
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
