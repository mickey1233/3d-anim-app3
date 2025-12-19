/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useRef, useState } from 'react';
import { useGLTF, Html, TransformControls } from '@react-three/drei';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useAppStore, ImageItem } from '../../store/useAppStore';

// Inner Component that actually uses the hook
const InnerModel = ({ url }: { url: string }) => {
  const { registerPart, selectPart, parts, images, updatePart } = useAppStore();
  const { scene } = useThree();
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
        object.position.set(...part.position);
        object.rotation.set(...part.rotation);
        object.scale.set(...part.scale);
      }
    });
  }, [parts, modelScene]);  // Handle Selection
  const handleClick = (e: any) => {
    e.stopPropagation();
    if (e.object.userData.isPart) {
      selectPart(e.object.uuid);
    } else {
      selectPart(null);
    }
  };

  const controls = useThree((state) => state.controls);
  const { selectedImageId, selectedPartId } = useAppStore();

  return (
    <group onClick={handleClick}>
      <primitive object={gltf.scene} />
      
      {/* Highlight Selected Part */}
      {selectedPartId && <PartHighlighter uuid={selectedPartId} scene={gltf.scene} />}

      {/* 
          Render Markers for SELECTED Image Keyframe ONLY.
      */}
      {images.map((img) => {
         // Only show markers for the selected image
         if (img.id !== selectedImageId) return null;

         return Object.entries(img.partPositions).map(([partId, position]) => {
            const part = parts[partId];
            if (!part) return null;
            
            return (
              <Marker 
                key={`${img.id}-${partId}`} 
                imgId={img.id}
                imgName={img.name}
                position={position}
                part={part} 
                modelScene={modelScene}
                controls={controls}
              />
            );
         });
      })}
    </group>
  );
};

// Component to Highlight Selected Part
const PartHighlighter = ({ uuid, scene }: { uuid: string, scene: THREE.Group }) => {
   const meshRef = useRef<THREE.Mesh>(null);
   // We need to attach the helper to the ACTUAL matrix-world object in the scene.
   // But we can't easily pass the object ref if it's deep in gltf.
   // So we find it.
   const [targetObj, setTargetObj] = useState<THREE.Object3D | null>(null);

   useEffect(() => {
      const obj = scene.getObjectByProperty('uuid', uuid);
      if (obj) setTargetObj(obj);
   }, [uuid, scene]);

   // Create a box helper
   if (!targetObj) return null;

   return <primitive object={new THREE.BoxHelper(targetObj, 0xffff00)} />;
}

export const Model = () => {
  const { cadUrl } = useAppStore();
  if (!cadUrl) return null;
  return <InnerModel url={cadUrl} />;
}

const Marker = ({ imgId, imgName, position, part, modelScene, controls }: { 
  imgId: string, 
  imgName: string, 
  position: [number, number, number], 
  part: any, 
  modelScene: THREE.Group | null,
  controls: any
}) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const { updateKeyframePosition } = useAppStore();
  
  return (
      <TransformControls 
         mode="translate"
         // Disable Orbit when dragging
         onMouseDown={() => { if(controls) controls.enabled = false; }}
         onMouseUp={() => { 
            if(controls) controls.enabled = true;
            
            // Save new position
            if (meshRef.current) {
               const pos = meshRef.current.position;
               updateKeyframePosition(imgId, part.uuid, [pos.x, pos.y, pos.z]);
            }
         }}
      >
        <mesh ref={meshRef} position={new THREE.Vector3(...position)}>
          <sphereGeometry args={[0.05, 16, 16]} />
          {/* Color matches the Part */}
          <meshStandardMaterial color={part.color} emissive={part.color} emissiveIntensity={1} transparent opacity={0.8} />
          <Html distanceFactor={10}>
            <div className="bg-black/80 text-white text-[8px] px-1 rounded pointer-events-none whitespace-nowrap flex flex-col items-center">
              <span>{imgName}</span>
              <span style={{color: part.color}}>{part.name}</span>
            </div>
          </Html>
        </mesh>
      </TransformControls>
  );
}
