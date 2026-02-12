/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useRef, useState } from 'react';
import { useGLTF, Html, TransformControls } from '@react-three/drei';
import { useThree, useFrame, useLoader } from '@react-three/fiber';
import { USDZLoader } from 'three/examples/jsm/loaders/USDZLoader.js';
import * as THREE from 'three';
import { useAppStore } from '../../store/useAppStore';
import { computeSmartOBB } from '../../utils/OBBUtils';

// --- Shared Interaction Logic ---
const ModelInteraction = ({ scene }: { scene: THREE.Object3D }) => {
  const { 
      registerPart, selectPart, parts,
      pickingMode, setStartMarker, setEndMarker, startMarker, endMarker, 
      setPickingMode, selectedPartId,
      selectedMarkerId, setSelectedMarkerId,
      isTransformDragging
  } = useAppStore();
  const { gl, size, camera } = useThree();
  const controls = useThree((state) => state.controls) as any;
  
  const [modelScene, setModelScene] = useState<THREE.Object3D | null>(null);

  // 1. Initial Part Registration & Debugging
  useEffect(() => {
    if (scene) {
      const box = new THREE.Box3().setFromObject(scene);
      const sizeVec = new THREE.Vector3();
      box.getSize(sizeVec);
      const center = new THREE.Vector3();
      box.getCenter(center);

      scene.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          mesh.userData.isPart = true;
          if (!parts[mesh.uuid]) {
            registerPart({
              uuid: mesh.uuid,
              name: mesh.name || `Part_${mesh.uuid.slice(0,4)}`,
              position: [mesh.position.x, mesh.position.y, mesh.position.z],
              rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
              scale: [mesh.scale.x, mesh.scale.y, mesh.scale.z],
              color: (mesh.material as any).color ? '#' + (mesh.material as any).color.getHexString() : '#ffffff'
            });
          }
        }
      });
      setModelScene(scene);
      
      // AUTO-FIT CAMERA (Keep this as it helps with large models visibility)
      if (controls) {
          const fitRatio = 1.2;
          const maxSize = Math.max(sizeVec.x, sizeVec.y, sizeVec.z);
          const fov = (camera as THREE.PerspectiveCamera).fov || 50;
          const fitHeightDistance = maxSize / (2 * Math.atan((Math.PI * fov) / 360));
          const fitDistance = fitRatio * fitHeightDistance;
          
          const direction = controls.target.clone().sub(camera.position).normalize().multiplyScalar(fitDistance);
          
          controls.target.copy(center);
          camera.position.copy(center).sub(direction);
          camera.lookAt(center);
          controls.update();
      }
    }
  }, [scene, registerPart, camera, controls]);

  // 2. Sync State -> 3D Object
  useEffect(() => {
    if (!modelScene) return;
    Object.values(parts).forEach(part => {
      const object = modelScene.getObjectByProperty('uuid', part.uuid);
      if (object) {
        object.position.set(...part.position);
        object.rotation.set(...part.rotation);
        object.scale.set(...part.scale);
      }
    });
  }, [parts, modelScene]);

  // 3. Picking Logic
  const handleClick = (e: any) => {
    e.stopPropagation();
    
    if (pickingMode === 'start' || pickingMode === 'end') {
        const mesh = e.object as THREE.Mesh;
        if (!mesh.isMesh) return;
        const face = e.face;
        if (!face) return;

        // Face Logic (Coplanar Smart Snap)
        const localNormal = face.normal.clone().normalize();
        const posAttr = mesh.geometry.attributes.position;
        const indexAttr = mesh.geometry.index;
        
        const getV = (i: number) => {
            const v = new THREE.Vector3();
            v.fromBufferAttribute(posAttr, i);
            return v;
        };
        
        const planePoint = getV(face.a);
        const triangleCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3;
        const coplanarBox = new THREE.Box3();
        
        const triNormal = new THREE.Vector3();
        const triA = new THREE.Vector3();
        const triB = new THREE.Vector3();
        const triC = new THREE.Vector3();

        for (let i = 0; i < triangleCount; i++) {
            let a, b, c;
            if (indexAttr) {
                a = indexAttr.getX(i * 3);
                b = indexAttr.getY(i * 3);
                c = indexAttr.getZ(i * 3);
            } else {
                a = i * 3; b = i * 3 + 1; c = i * 3 + 2;
            }
            triA.fromBufferAttribute(posAttr, a);
            triB.fromBufferAttribute(posAttr, b);
            triC.fromBufferAttribute(posAttr, c);
            
            triNormal.subVectors(triC, triB).cross(new THREE.Vector3().subVectors(triA, triB)).normalize();
            
            if (triNormal.dot(localNormal) > 0.99) {
                const dist = new THREE.Vector3().subVectors(triA, planePoint).dot(localNormal);
                if (Math.abs(dist) < 0.001) {
                    coplanarBox.expandByPoint(triA);
                    coplanarBox.expandByPoint(triB);
                    coplanarBox.expandByPoint(triC);
                }
            }
        }
        
        let centerLocal = new THREE.Vector3();
        if (!coplanarBox.isEmpty()) {
             coplanarBox.getCenter(centerLocal);
        } else {
             centerLocal.copy(planePoint);
        }
        
        const centerWorld = centerLocal.clone().applyMatrix4(mesh.matrixWorld);
        const pointData = [centerWorld.x, centerWorld.y, centerWorld.z] as [number, number, number];

        if (pickingMode === 'start') {
             setStartMarker(pointData);
             setPickingMode('idle');
        } else {
             setEndMarker(pointData);
             setPickingMode('idle');
        }
        return; 
    }

    // Normal Part Selection
    if (e.object.userData.isPart) {
      selectPart(e.object.uuid);
    } else {
      selectPart(null);
    }
  };

  const handlePointerMissed = (e: any) => {
      if (isTransformDragging) return;
      setSelectedMarkerId(null);
  };

  return (
    <group onPointerMissed={handlePointerMissed}>
        {/* The Scenes */}
        <primitive 
            object={scene} 
            onClick={handleClick}
        />
      
        {/* Markers */}
        {startMarker && (
            <DraggableMarker 
                id="start"
                position={startMarker.position} 
                color="#4ade80" 
                label="Start"
                onDragEnd={(pos) => setStartMarker([pos.x, pos.y, pos.z])}
                isSelected={selectedMarkerId === 'start'}
                onSelect={() => setSelectedMarkerId('start')}
            />
        )}
        {endMarker && (
            <DraggableMarker 
                id="end"
                position={endMarker.position} 
                color="#60a5fa" 
                label="End"
                onDragEnd={(pos) => setEndMarker([pos.x, pos.y, pos.z])}
                isSelected={selectedMarkerId === 'end'}
                onSelect={() => setSelectedMarkerId('end')}
            />
        )}

        {/* Highlight Selected Part */}
        {selectedPartId && <PartHighlighter uuid={selectedPartId} scene={scene} />}
    </group>
  );
};

// --- Models Logic ---

const GLTFModel = ({ url }: { url: string }) => {
    const gltf = useGLTF(url, true);
    return <ModelInteraction scene={gltf.scene} />;
};

const USDModel = ({ url }: { url: string }) => {
    const scene = useLoader(USDZLoader, url);
    
    useEffect(() => {
        if (scene) {
            console.log("[USDModel] Loaded Scene:", scene);
            const box = new THREE.Box3().setFromObject(scene);
            console.log("[USDModel] Bounding Box:", box);
            console.log("[USDModel] Size:", box.getSize(new THREE.Vector3()));
        }
    }, [scene]);

    return <ModelInteraction scene={scene as THREE.Object3D} />;
};

export const Model = () => {
    const { cadUrl, cadFileName } = useAppStore();
    if (!cadUrl) return null;

    const isUSD = cadFileName?.toLowerCase().endsWith('.usd') || cadFileName?.toLowerCase().endsWith('.usdz');

    return (
        <React.Suspense fallback={null}>
            {isUSD ? <USDModel url={cadUrl} /> : <GLTFModel url={cadUrl} />}
        </React.Suspense>
    );
};

// --- Helpers ---

const PartHighlighter = ({ uuid, scene }: { uuid: string, scene: THREE.Object3D }) => {
   const [helper, setHelper] = useState<THREE.Object3D | null>(null);
   const trackedMeshRef = useRef<THREE.Mesh | null>(null);

   useFrame(() => {
       if (helper && scene && trackedMeshRef.current && helper.userData.basis) {
            const meshWorld = trackedMeshRef.current.matrixWorld;
            const pcaBasis = helper.userData.basis as THREE.Matrix4;
            helper.matrix.multiplyMatrices(meshWorld, pcaBasis);
       }
   });

   useEffect(() => {
      const obj = scene.getObjectByProperty('uuid', uuid);
      if (obj) {
          obj.updateWorldMatrix(true, true);
          const meshes: THREE.Mesh[] = [];
          obj.traverse((child) => {
              if ((child as THREE.Mesh).isMesh && child.visible) meshes.push(child as THREE.Mesh);
          });

          if (meshes.length === 1) {
              const mesh = meshes[0];
              trackedMeshRef.current = mesh; 
              const { center, size, basis } = computeSmartOBB(mesh);
              
              const geom = new THREE.BoxGeometry(size.x, size.y, size.z);
              const edges = new THREE.EdgesGeometry(geom);
              const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffff00 }));
              
              const localOBBMatrix = new THREE.Matrix4();
              localOBBMatrix.copy(basis);
              localOBBMatrix.setPosition(center);
              
              line.userData.basis = localOBBMatrix;
              line.matrixAutoUpdate = false;
              line.matrix.multiplyMatrices(mesh.matrixWorld, localOBBMatrix);
              setHelper(line);
          } else {
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
};

const DraggableMarker = ({ id, position, color, label, onDragEnd, isSelected, onSelect }: { 
    id: string;
    position: [number, number, number], 
    color: string, 
    label: string, 
    onDragEnd: (pos: THREE.Vector3) => void,
    isSelected: boolean,
    onSelect: () => void
}) => {
    const transformRef = useRef<any>(null);
    const meshRef = useRef<THREE.Mesh>(null);
    const setTransformDragging = useAppStore((s) => s.setTransformDragging);
    const onDragEndRef = useRef(onDragEnd);

    useEffect(() => {
        onDragEndRef.current = onDragEnd;
    }, [onDragEnd]);
    
    useEffect(() => {
        if (transformRef.current) {
            const controlsObj = transformRef.current;
            const callback = (event: any) => {
                const isDragging = event.value;
                setTransformDragging(id, !!isDragging);
                if (isDragging) {
                    const forceEnd = () => setTransformDragging(id, false);
                    window.addEventListener('pointerup', forceEnd, { once: true });
                    window.addEventListener('pointercancel', forceEnd, { once: true });
                    window.addEventListener('blur', forceEnd, { once: true });
                }
                if (!isDragging && meshRef.current) onDragEndRef.current(meshRef.current.position);
            };
            controlsObj.addEventListener('dragging-changed', callback);
            return () => {
                controlsObj.removeEventListener('dragging-changed', callback);
                setTransformDragging(id, false);
            };
        }
    }, [id, setTransformDragging]);

    return (
        <TransformControls 
            ref={transformRef}
            mode="translate"
            size={1.6}
            enabled={isSelected}
            showX={isSelected} showY={isSelected} showZ={isSelected}
            onPointerDown={(e) => {
                e.stopPropagation();
                onSelect();
            }}
        >
            <mesh 
                ref={meshRef} 
                position={new THREE.Vector3(...position)}
                onPointerDown={(e) => {
                    e.stopPropagation();
                    // Ensure we keep receiving pointer events even if leaving the canvas.
                    const target = e.target as any;
                    target?.setPointerCapture?.(e.pointerId);
                    onSelect();
                }}
            >
                <sphereGeometry args={[0.04, 18, 18]} />
                <meshBasicMaterial color={isSelected ? '#ffffff' : color} depthTest={false} transparent opacity={0.9} />
                <Html position={[0.025, 0, 0]} pointerEvents="none">
                    <div 
                        style={{
                            color: isSelected ? '#ffffff' : color,
                            transform: 'translateX(4px)'
                        }} 
                        className="text-[10px] font-bold bg-black/60 px-1 py-0.5 rounded border border-white/20 whitespace-nowrap backdrop-blur-sm shadow-sm transition-colors"
                    >
                        {label}
                    </div>
                </Html>
            </mesh>
        </TransformControls>
    )
};
