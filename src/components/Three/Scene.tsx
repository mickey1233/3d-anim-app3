import React, { useEffect, useRef } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, Stage, Grid } from '@react-three/drei';
import { Model } from './Model';
import { useAppStore } from '../../store/useAppStore';
import { RemoteClient } from '../Network/RemoteClient';
import * as THREE from 'three';

// Handles animating parts
const PartAnimator = () => {
  const { 
      isAnimationPlaying, setAnimationPlaying, 
      movingPartId, startMarker, endMarker, 
      animationDuration, animationEasing,
      parts,
      updatePart 
  } = useAppStore();
  const { scene } = useThree();
  
  // Animation State
  const startTime = useRef(0);
  const isRunning = useRef(false);
  const initialPosition = useRef<THREE.Vector3 | null>(null);

  useEffect(() => {
    if (isAnimationPlaying && !isRunning.current) {
      if (!movingPartId || !startMarker || !endMarker) {
         console.warn("Cannot start animation: Missing config");
         setAnimationPlaying(false);
         return;
      }
      
      // Capture Initial Position
      const partObj = scene.getObjectByProperty('uuid', movingPartId);
      if (partObj) {
          initialPosition.current = partObj.position.clone();
      } else {
          console.warn("Moving part not found in scene");
          setAnimationPlaying(false);
          return;
      }

      isRunning.current = true;
      startTime.current = Date.now();
    } else if (!isAnimationPlaying) {
      isRunning.current = false;
      initialPosition.current = null;
    }
  }, [isAnimationPlaying, movingPartId, startMarker, endMarker, scene]);

  useFrame(() => {
    if (!isRunning.current || !movingPartId || !startMarker || !endMarker || !initialPosition.current) return;

    const now = Date.now();
    const elapsed = (now - startTime.current) / 1000; // Seconds
    const progress = Math.min(elapsed / animationDuration, 1.0);
    
    // Easing Logic
    let t = progress;
    if (animationEasing === 'easeIn') t = progress * progress;
    else if (animationEasing === 'easeOut') t = progress * (2 - progress);
    else if (animationEasing === 'easeInOut') t = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;

    const partObj = scene.getObjectByProperty('uuid', movingPartId);
    
    if (partObj) {
        // Calculate World Delta Vector
        const vStartWorld = new THREE.Vector3(...startMarker.position);
        const vEndWorld = new THREE.Vector3(...endMarker.position);
        const worldDelta = new THREE.Vector3().subVectors(vEndWorld, vStartWorld);
        
        if (partObj.parent) {
             const initialWorld = initialPosition.current.clone().applyMatrix4(partObj.parent.matrixWorld);
             const targetWorld = initialWorld.clone().add(worldDelta);
             const targetLocal = targetWorld.clone();
             partObj.parent.worldToLocal(targetLocal);
             partObj.position.lerpVectors(initialPosition.current, targetLocal, t);
             
             if (progress >= 1.0) {
                 partObj.position.copy(targetLocal);
             }
        } else {
             const targetLocal = initialPosition.current.clone().add(worldDelta);
             partObj.position.lerpVectors(initialPosition.current, targetLocal, t);
             
             if (progress >= 1.0) {
                 partObj.position.copy(targetLocal);
             }
        }
        
        // SYNC TO STORE ON COMPLETION
        if (progress >= 1.0) {
            updatePart(movingPartId, { 
                position: [partObj.position.x, partObj.position.y, partObj.position.z] 
            });
        }
    }
    
    if (progress >= 1.0) {
        setAnimationPlaying(false);
        isRunning.current = false;
        initialPosition.current = null;
    }
  });

  return null;
}

// Snaps Camera to Global Config
const GlobalCameraRig = () => {
    const { cameraTransform, isAnimationPlaying } = useAppStore();
    const { camera } = useThree();
    
    useEffect(() => {
        // Apply Camera Transform
        const { position, rotation } = cameraTransform;
        
        if (position.every(v => v === 0) && rotation.every(v => v === 0)) return;

        camera.position.set(position[0], position[1], position[2]);
        camera.rotation.set(
            THREE.MathUtils.degToRad(rotation[0]),
            THREE.MathUtils.degToRad(rotation[1]),
            THREE.MathUtils.degToRad(rotation[2])
        );
        
    }, [cameraTransform, isAnimationPlaying]);
    
    return null;
}

// Wrapper for Controls
const Controls = () => {
   const { isAnimationPlaying } = useAppStore();
   const configs = useRef<any>(null);

   useFrame(() => {
      if (configs.current) {
         configs.current.enabled = !isAnimationPlaying;
      }
   });
   
   return <OrbitControls ref={configs} makeDefault />;
}


const ObjectRig = ({ children }: { children: React.ReactNode }) => {
    const { objectTransform } = useAppStore();
    return (
        <group 
            position={new THREE.Vector3(...objectTransform.position)}
            rotation={new THREE.Euler(
                THREE.MathUtils.degToRad(objectTransform.rotation[0]),
                THREE.MathUtils.degToRad(objectTransform.rotation[1]),
                THREE.MathUtils.degToRad(objectTransform.rotation[2])
            )}
        >
            {children}
        </group>
    );
}

const SequenceController = () => {
    const { 
        isSequencePlaying, 
        currentStepIndex, 
        sequence, 
        nextStep, 
        stopSequence,
        setMovingPartId, setStartMarker, setEndMarker, setAnimationConfig, setAnimationPlaying,
        isAnimationPlaying
    } = useAppStore();

    // 1. Trigger Step when Index Changes
    useEffect(() => {
        if (!isSequencePlaying) return;

        if (currentStepIndex >= 0 && currentStepIndex < sequence.length) {
            const step = sequence[currentStepIndex];
            console.log(`[SEQUENCE] Playing Step ${currentStepIndex + 1}:`, step.description);
            
            // Allow a small delay for state to settle? Not strictly needed but safe.
            // Batch updates
            setMovingPartId(step.partId);
            setStartMarker(step.startMarker.position);
            setEndMarker(step.endMarker.position);
            setAnimationConfig(step.duration, step.easing);
            
            // Trigger Animation
            // We need a slight timeout because we just updated the dependencies of the Animator?
            // Actually, Animator watches [isAnimationPlaying].
            // If we set everything THEN set playing, it should be fine.
            setTimeout(() => setAnimationPlaying(true), 10);
            
        } else if (currentStepIndex >= sequence.length) {
            console.log("[SEQUENCE] Finished.");
            stopSequence();
        }
    }, [isSequencePlaying, currentStepIndex]);

    // 2. Watch for Animation Completion
    const wasPlaying = useRef(false);
    useEffect(() => {
        if (!isSequencePlaying) return;

        if (wasPlaying.current && !isAnimationPlaying) {
            // Animation just finished
            console.log("[SEQUENCE] Step Finished. Moving to next...");
            // Non-blocking wait if desired?
            setTimeout(() => nextStep(), 500); // 0.5s pause between steps
        }
        
        wasPlaying.current = isAnimationPlaying;
    }, [isSequencePlaying, isAnimationPlaying]);

    return null;
}


export const Scene = () => {
  const handleCanvasPointerDown = (e: any) => {
      // Log critical debug info requested by user
      const rect = e.target.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const ndc_x = (x / rect.width) * 2 - 1;
      const ndc_y = -(y / rect.height) * 2 + 1;
      
      console.log('--- CANVAS POINTER DOWN ---');
      console.log('Rect:', rect);
      console.log('NDC:', ndc_x, ndc_y);
      // Raycast hits are not available on the raw DOM event, 
      // but R3F onPointerDown provides them if passed to mesh or useThree event manager.
      // We will rely on Model.tsx for raycast hits, but this confirms DOM access.
      (window as any).__DEBUG_CANVAS_CLICK__ = true;
  };

  return (
    <div className="w-full h-full bg-transparent" style={{ pointerEvents: 'auto' }}>
      <Canvas 
          shadows 
          camera={{ position: [5, 5, 5], fov: 50 }}
          eventSource={document.getElementById('root')!}
          style={{ pointerEvents: 'auto' }}
          onPointerDown={handleCanvasPointerDown}
      >
        {/* Lights (Standard Setup) */}
        <ambientLight intensity={0.5} />
        <directionalLight position={[10, 10, 5]} intensity={1} castShadow />
        <spotLight position={[-10, 10, 5]} intensity={1} />
        
        {/* Environment (City) - optional, use Environment component directly if needed */}
        {/* <Environment preset="city" /> */}

        <ObjectRig>
            <Model />
        </ObjectRig>

        <Grid infiniteGrid fadeDistance={50} fadeStrength={1.5} position={[0, -0.01, 0]} />
        
        <PartAnimator />
        <SequenceController />
        <GlobalCameraRig />
        <RemoteClient />
        <Controls />
      </Canvas>
    </div>
  );
};
