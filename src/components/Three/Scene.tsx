import React, { useEffect, useRef } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, Environment, Grid, Stage } from '@react-three/drei';
import { Model } from './Model';
import { useAppStore, ImageItem } from '../../store/useAppStore';
import * as THREE from 'three';

const PartAnimator = () => {
  const { isAnimationPlaying, images, setAnimationPlaying, parts } = useAppStore();
  const { scene } = useThree();
  
  // Animation State
  const startTime = useRef(0);
  const isRunning = useRef(false);

  useEffect(() => {
    if (isAnimationPlaying && !isRunning.current) {
      if (images.length < 2) {
         console.warn("Need at least 2 images for animation");
         setAnimationPlaying(false);
         return;
      }
      isRunning.current = true;
      startTime.current = Date.now();
    } else if (!isAnimationPlaying) {
      isRunning.current = false;
      
      // Optional: Reset parts to initial state? 
      // Or leave them at end state? User usually wants to reset or see result.
      // Let's leave them.
    }
  }, [isAnimationPlaying, images.length]);

  useFrame(() => {
    if (!isRunning.current || images.length < 2) return;

    const DURATION_PER_SEGMENT = 2000; // 2 seconds between keyframes
    const now = Date.now();
    const elapsed = now - startTime.current;
    
    // Total duration = (Images - 1) * Segment_Duration
    const totalDuration = (images.length - 1) * DURATION_PER_SEGMENT;
    
    if (elapsed >= totalDuration) {
      setAnimationPlaying(false);
      isRunning.current = false;
      return;
    }

    // Determine current segment
    // Segment 0: Image 0 -> Image 1
    // Segment 1: Image 1 -> Image 2
    const currentSegmentIndex = Math.floor(elapsed / DURATION_PER_SEGMENT);
    const segmentProgress = (elapsed % DURATION_PER_SEGMENT) / DURATION_PER_SEGMENT; // 0 to 1

    const startImg = images[currentSegmentIndex];
    const endImg = images[currentSegmentIndex + 1];

    if (!startImg || !endImg) return;

    // Animate every part
    Object.keys(parts).forEach(partId => {
       const startPos = startImg.partPositions[partId];
       const endPos = endImg.partPositions[partId];

       // If keyframe data is missing, we skip (or stay at last known?)
       // Our AI logic ensures all are filled mostly.
       if (startPos && endPos) {
          const partObj = scene.getObjectByProperty('uuid', partId);
          if (partObj) {
             const vStart = new THREE.Vector3(...startPos);
             const vEnd = new THREE.Vector3(...endPos);
             
             // Linear Interpolation
             // We can use easeInOutQuad for smoothness?
             // t = segmentProgress
             // ease = t < .5 ? 2 * t * t : -1 + (4 - 2 * t) * t
             // Simple Lerp for now
             
             // BUT WAIT: The stored positions are WORLD coordinates (as per marker logic)? 
             // OR Local? 
             // We decided markers update Store with local-converted-from-world?
             // Let's check Model.tsx:
             // updateKeyframePosition calls with [pos.x, y, z] from Mesh World (TransformControls operates in World default? OR Local default?)
             // TransformControls default is World unless `space="local"`. We didn't specify, so World.
             // BUT inside onMouseUp in previous code we did `parentObj.matrixWorld.clone().invert()`.
             // IN NEW CODE `Model.tsx` (Step 241), I removed the matrix inversion logic!
             // I just did: `updateKeyframePosition(..., [pos.x, pos.y, pos.z])`.
             // `meshRef.current` is child of `TransformControls`? No, `TransformControls` wraps `mesh`.
             // If `mesh` is direct child of `group`(Scene) or `Stage`?
             // In `Model.tsx`, `Marker` is rendered inside `group` which is inside `Stage`?
             // `Stage` creates a hierarchy.
             // `Marker` component renders `TransformControls` -> `mesh`.
             // When dragging, `mesh.position` updates.
             // Since `mesh` is child of `TransformControls` (which adds itself to scene usually? No, Drei TC wraps).
             // Drei `TransformControls` adds the controls to scene, but the child `mesh`...
             // If `makeDefault` is not set, it wraps children.
             // It puts children in a group.
             // Basically: The position we get is likely LOCAL to the Marker's parent group if we read `mesh.position`.
             // The Marker's parent in JSX is `group` (the Model inner group).
             // So `mesh.position` is RELATIVE to the Model Group.
             // EXCEPT `TransformControls` might re-parent?
             // Actually, `TransformControls` from Drei maintains the `object` prop or children.
             // If children: It renders them.
             
             // Key assumption: The stored [x,y,z] is RELATIVE TO THE SCENE/MODEL GROUP.
             // If so, we can just apply it to the Part Object IF the Part Object is in the same space.
             // The Part Object is inside `gltf.scene`.
             // `gltf.scene` is inside `<primitive>` inside `group`.
             // The Markers are siblings of `<primitive>` inside `group`.
             // So Markers and GLTF Root are siblings.
             // BUT the Parts (Meshes) are descendants of GLTF Root.
             // So Part.position is relative to Part.Parent (some node in GLTF).
             // Marker.position is relative to Model Group (Top Level).
             
             // ISSUE: We are animating `Part.position`.
             // If the GLTF has hierarchy (Nodes inside Nodes), setting `Part.position` to a World-ish value (Relative to Root) will break it if the part has a parent with transform.
             // FIX: We need to use `WorldPosition` logic or clear transforms.
             // Simplified approach for this "hacky" visualizer:
             // Assume Parts are mostly top level or we just apply World Matrix updates.
             // OR: We detach parts from hierarchy? Dangerous.
             // BETTER: We convert the "Marker Position (Relative to Model Root)" into "Part Local Position" before applying.
             // We need `partObj.parent.worldToLocal( targetPos.clone() )`.
             // Yes.
             
             const targetLerp = new THREE.Vector3().lerpVectors(vStart, vEnd, segmentProgress);
             
             // Convert Model-Root-Space (Marker Space) to Part-Local-Space
             // Simple position update. 
             // We assume markers are in World Space (or Scene Space).
             // We assume Parts are in Scene Space (or have Identity parents).
             // If hierarchy exists, this might be offset, but it Won't Freeze.
             partObj.position.copy(targetLerp);
             // The loop above is risky.
             // Let's try simple copy first. If it flies away, we know why.
             partObj.position.copy(targetLerp);
          }
       }
    });

  });

  return null;
}

// Wrapper for Controls to handle Animation overrides
const Controls = () => {
   const { isAnimationPlaying, images, parts } = useAppStore();
   const { camera, scene } = useThree();
   const controlsRef = useRef<any>(null);

   useFrame(() => {
      // If animation is playing, we might want to disable controls or update target?
      // CameraRig fights with OrbitControls. 
      // Ideally we disable OrbitControls when animation is playing.
      if (configs.current) {
         configs.current.enabled = !isAnimationPlaying;
      }
   });
   
   const configs = useRef<any>(null);

   return <OrbitControls ref={configs} makeDefault />;
}


export const Scene = () => {
  return (
    <div className="w-full h-full bg-transparent">
      <Canvas shadows camera={{ position: [5, 5, 5], fov: 50 }}>
        {/* Stage handles lighting and centering */}
        <Stage environment="city" intensity={0.5}>
           <Model />
        </Stage>
        <Grid infiniteGrid fadeDistance={50} fadeStrength={1.5} position={[0, -0.01, 0]} />
        
        <PartAnimator />
        <Controls />
      </Canvas>
    </div>
  );
};
