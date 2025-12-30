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
            const parts = Object.values(store.parts).map(p => ({
                uuid: p.uuid,
                name: p.name,
                position: p.position
            }));
            return { parts };
        });

        mcpBridge.registerHandler('select_part', async (_cmd, args: { name_or_uuid: string }) => {
            const { name_or_uuid } = args;
            // Try UUID first
            if (store.parts[name_or_uuid]) {
                store.selectPart(name_or_uuid);
                return { success: true, message: `Selected ${store.parts[name_or_uuid].name}` };
            }
            // Try Name
            const part = Object.values(store.parts).find(p => p.name === name_or_uuid);
            if (part) {
                store.selectPart(part.uuid);
                return { success: true, message: `Selected ${part.name}` };
            }
            throw new Error(`Part not found: ${name_or_uuid}`);
        });

        mcpBridge.registerHandler('set_pose_target', async (_cmd, args: { source: string, target: string, source_face: string, target_face: string }) => {
             // 1. Resolve objects
             const findMesh = (idOrName: string) => {
                 // Check if it's a UUID in store
                 let uuid = idOrName;
                 // Case-insensitive name match
                 const p = Object.values(store.parts).find(p => 
                     p.name.toLowerCase() === idOrName.toLowerCase() || 
                     p.uuid === idOrName
                 );
                 if (p) uuid = p.uuid;

                 // Find in Scene
                 const mesh = scene.getObjectByProperty('uuid', uuid);
                 return mesh as THREE.Mesh;
             };

             const sourceMesh = findMesh(args.source);
             const targetMesh = findMesh(args.target);

             if (!sourceMesh || !targetMesh) throw new Error("Source or Target mesh not found in scene");

             // 2. Calculate Bounds and Face Points
             const getBounds = (obj: THREE.Object3D) => {
                 const box = new THREE.Box3();
                 
                 // Smart Bounds: If it's a Mesh, use geometry directly to avoid children/artifacts
                 if ((obj as THREE.Mesh).isMesh) {
                     const mesh = obj as THREE.Mesh;
                     if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
                     // Copy local box and apply world matrix
                     box.copy(mesh.geometry.boundingBox!);
                     box.applyMatrix4(mesh.matrixWorld);
                 } else {
                     // Fallback for Groups
                     box.setFromObject(obj);
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
             store.setMovingPartId(sourceMesh.uuid);
             store.setStartMarker(startPos.toArray());
             store.setEndMarker(endPos.toArray());
             store.setPickingMode('idle');

             return { 
                 success: true, 
                 message: `Aligned '${sourceMesh.name}' (${args.source_face}) to '${targetMesh.name}' (${args.target_face}). [Debug: src=${args.source} tgt=${args.target}]`
             };
        });

        mcpBridge.registerHandler('preview_animation', async () => {
             store.setAnimationPlaying(true);
             return { success: true };
        });

        mcpBridge.registerHandler('add_current_step', async (_cmd, args: { description: string }) => {
            const { movingPartId, startMarker, endMarker, animationDuration, animationEasing } = store;
            if (!movingPartId || !startMarker || !endMarker) throw new Error("Incomplete animation state");
            
            store.addStep({
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
            if (args.type === 'start') {
                store.setStartMarker(pos);
            } else {
                store.setEndMarker(pos);
            }
            return { success: true, message: `Set ${args.type} marker to [${pos.join(', ')}]` };
        });
        
        mcpBridge.registerHandler('reset_scene', async () => {
            store.triggerReset();
            return { success: true };
        });

        mcpBridge.registerHandler('load_demo_model', async () => {
             store.setCadUrl('/demo/Spark.glb', 'Spark.glb');
             // Note: In a real app we might want to wait for load, but here we trigger it.
             return { success: true, message: "Triggered Demo Model Load" };
        });

    }, [scene, store]);

    return null;
};
