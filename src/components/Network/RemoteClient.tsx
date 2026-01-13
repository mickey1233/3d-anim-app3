import React, { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { mcpBridge } from '../../services/MCPBridge';
import { useAppStore } from '../../store/useAppStore';

export const RemoteClient: React.FC = () => {
    const { scene } = useThree();
    const store = useAppStore();

    useEffect(() => {
        mcpBridge.connect('ws://localhost:3001');

        mcpBridge.registerHandler('get_scene_state', async () => {
            const currentState = useAppStore.getState();
            const parts = Object.values(currentState.parts).map(p => ({
                uuid: p.uuid,
                name: p.name,
                position: p.position
            }));
            return { parts };
        });

        mcpBridge.registerHandler('select_part', async (_cmd, args: { name_or_uuid: string }) => {
            const { name_or_uuid } = args;
            const state = useAppStore.getState();
            // Try UUID first
            if (state.parts[name_or_uuid]) {
                state.selectPart(name_or_uuid);
                return { success: true, message: `Selected ${state.parts[name_or_uuid].name}` };
            }
            // Try Name
            const part = Object.values(state.parts).find(p => p.name === name_or_uuid);
            if (part) {
                state.selectPart(part.uuid);
                return { success: true, message: `Selected ${part.name}` };
            }
            throw new Error(`Part not found: ${name_or_uuid}`);
        });

        mcpBridge.registerHandler('set_pose_target', async (_cmd, args: { source: string, target: string, source_face: string, target_face: string }) => {
             // 1. Resolve objects
             const findMesh = (idOrName: string) => {
                 const state = useAppStore.getState();
                 console.log(`[RemoteClient] Resolving '${idOrName}'...`);
                 
                 // Check if it's a UUID in store
                 let uuid = idOrName;
                 // Case-insensitive name match
                 const p = Object.values(state.parts).find(p => 
                     p.name.toLowerCase() === idOrName.toLowerCase() || 
                     p.uuid === idOrName
                 );
                 
                 if (p) {
                     console.log(`[RemoteClient] Found in Store: ${p.name} (${p.uuid})`);
                     uuid = p.uuid;
                 } else {
                     console.log(`[RemoteClient] Not found in store by exact/UUID match.`);
                 }

                 // Find in Scene
                 let mesh = scene.getObjectByProperty('uuid', uuid);
                 
                 if (!mesh) {
                     // Fallback: Check for fuzzy/containment match in scene directly if store lookup failed or mesh not found
                      console.log(`[RemoteClient] Mesh not found by UUID. Searching scene candidates...`);
                      const candidates: { mesh: THREE.Object3D; name: string }[] = [];
                      scene.traverse((child) => {
                        if ((child as THREE.Mesh).isMesh) {
                            candidates.push({ mesh: child, name: child.name });
                        }
                      });
                      
                      const lowerName = idOrName.toLowerCase();
                      const match = candidates.find(c => c.name.toLowerCase().includes(lowerName));
                      if (match) {
                          console.log(`[RemoteClient] Found fuzzy match in scene: ${match.name}`);
                          mesh = match.mesh;
                      }
                 }

                 console.log(`[RemoteClient] Final resolution for '${idOrName}':`, mesh ? mesh.name : 'null');
                 return mesh as THREE.Mesh;
             };

             console.log(`[RemoteClient] set_pose_target called with:`, args);
             const sourceMesh = findMesh(args.source);
             const targetMesh = findMesh(args.target);

             if (!sourceMesh || !targetMesh) {
                 console.error(`[RemoteClient] Failed to resolve meshes. Source: ${sourceMesh?.name}, Target: ${targetMesh?.name}`);
                 throw new Error(`Source or Target mesh not found in scene. Source=${args.source}, Target=${args.target}`);
             }

             // 2. Calculate Bounds and Face Points
             const getBounds = (obj: THREE.Object3D) => {
                 const box = new THREE.Box3();
                 
                 // Smart Bounds: Compute precise bounds ignoring invisible children
                 if ((obj as THREE.Mesh).isMesh) {
                     // Single Mesh case (still check geometry directly)
                     const mesh = obj as THREE.Mesh;
                     if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
                     box.copy(mesh.geometry.boundingBox!);
                     box.applyMatrix4(mesh.matrixWorld);
                 } else {
                     // For Groups: Traverse and expand only for Visible Meshes
                     box.makeEmpty();
                     let foundMesh = false;
                     obj.traverse((child) => {
                        if ((child as THREE.Mesh).isMesh && child.visible) {
                            const mesh = child as THREE.Mesh;
                            if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
                            
                            const localBox = mesh.geometry.boundingBox!.clone();
                            localBox.applyMatrix4(mesh.matrixWorld);
                            
                            box.union(localBox);
                            foundMesh = true;
                        }
                     });
                     if (!foundMesh) {
                         // Fallback
                         box.setFromObject(obj);
                     }
                 }

                 const center = new THREE.Vector3();
                 const size = new THREE.Vector3();
                 box.getCenter(center);
                 box.getSize(size);
                 
                 // Debug Log
                 console.log(`[Bounds] ${obj.name}: Size=[${size.toArray().map(n=>n.toFixed(2))}] Center=[${center.toArray().map(n=>n.toFixed(2))}]`);
                 
                 return { box, center, size, min: box.min, max: box.max };
             };

             const getFacePoint = (obj: THREE.Object3D, face: string) => {
                 const { center, min, max } = getBounds(obj);
                 const point = center.clone();
                 switch (face) {
                     case 'top': point.y = max.y; break;
                     case 'bottom': point.y = min.y; break;
                     case 'left': point.x = min.x; break;
                     case 'right': point.x = max.x; break;
                     case 'front': point.z = max.z; break;
                     case 'back': point.z = min.z; break;
                     case 'center': break;
                 }
                 return point;
             }

             const startPos = getFacePoint(sourceMesh, args.source_face);
             const endPos = getFacePoint(targetMesh, args.target_face);

             // Update Store
             const state = useAppStore.getState();
             state.setMovingPartId(sourceMesh.uuid);
             state.setStartMarker(startPos.toArray());
             state.setEndMarker(endPos.toArray());
             state.setPickingMode('idle');

             return { 
                 success: true, 
                 message: `Aligned '${sourceMesh.name}' (${args.source_face}) to '${targetMesh.name}' (${args.target_face}). [Debug: src=${args.source} tgt=${args.target}]`
             };
        });

        mcpBridge.registerHandler('preview_animation', async () => {
             useAppStore.getState().setAnimationPlaying(true);
             return { success: true };
        });

        mcpBridge.registerHandler('add_current_step', async (_cmd, args: { description: string }) => {
            const state = useAppStore.getState();
            const { movingPartId, startMarker, endMarker, animationDuration, animationEasing } = state;
            if (!movingPartId || !startMarker || !endMarker) throw new Error("Incomplete animation state");
            
            state.addStep({
                id: THREE.MathUtils.generateUUID(),
                partId: movingPartId,
                startMarker,
                endMarker,
                duration: animationDuration,
                easing: animationEasing,
                description: args.description || "Auto-generated step"
            });
            return { success: true, message: "Step added to sequence" };
        });
        
        mcpBridge.registerHandler('set_marker_manual', async (_cmd, args: { type: 'start'|'end', x: number, y: number, z: number }) => {
            const pos: [number, number, number] = [args.x, args.y, args.z];
            const state = useAppStore.getState();
            if (args.type === 'start') {
                state.setStartMarker(pos);
            } else {
                state.setEndMarker(pos);
            }
            return { success: true, message: `Set ${args.type} marker to [${pos.join(', ')}]` };
        });
        
        mcpBridge.registerHandler('reset_scene', async () => {
            useAppStore.getState().resetAllParts();
            return { success: true };
        });

        mcpBridge.registerHandler('load_demo_model', async () => {
             useAppStore.getState().setCadUrl('/demo/Spark.glb', 'Spark.glb');
             // Note: In a real app we might want to wait for load, but here we trigger it.
             return { success: true, message: "Triggered Demo Model Load" };
        });

    }, [scene]);

    return null;
};
