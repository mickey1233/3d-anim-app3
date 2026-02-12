import React from 'react';
import { Canvas } from '@react-three/fiber';
import { Grid } from '@react-three/drei';
import { ModelLoader } from './ModelLoader';
import { OrbitCoordinator } from './interaction/OrbitCoordinator';
import { TransformGizmo } from './interaction/TransformGizmo';
import { SelectionOutline } from './interaction/SelectionOutline';
import { AnchorMarkers } from './anchors/AnchorMarkers';
import { MateExecutor } from './mating/MateExecutor';
import { MatePreviewMarkers } from './mating/MatePreviewMarkers';
import { PartTransformSync } from './interaction/PartTransformSync';
import { useV2Store } from '../store/store';
import { GeneratedBackground } from './backgrounds/GeneratedBackground';
import { BoxesFixture } from './fixtures/BoxesFixture';
import { SideFixture } from './fixtures/SideFixture';
import { LidFixture } from './fixtures/LidFixture';
import { ShelfFixture } from './fixtures/ShelfFixture';
import { SlotFixture } from './fixtures/SlotFixture';
import { StepRunner } from './animation/StepRunner';
import { SceneRegistryBridge } from './SceneRegistryBridge';

export function CanvasRoot() {
  const view = useV2Store((s) => s.view);
  const cadUrl = useV2Store((s) => s.cadUrl);
  const fixtureId = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('fixture') : null;
  const shouldUseFixture = Boolean(fixtureId) || !cadUrl;
  const fixture = fixtureId || 'boxes';

  return (
    <div className="w-full h-full">
      <Canvas camera={{ position: [4, 4, 4], fov: 50 }}>
        <SceneRegistryBridge />
        <ambientLight intensity={0.6} />
        <directionalLight position={[6, 8, 5]} intensity={1.2} castShadow />
        <GeneratedBackground />
        <OrbitCoordinator />
        {shouldUseFixture ? (
          fixture === 'side' ? (
            <SideFixture />
          ) : fixture === 'lid' ? (
            <LidFixture />
          ) : fixture === 'shelf' ? (
            <ShelfFixture />
          ) : fixture === 'slot' ? (
            <SlotFixture />
          ) : (
            <BoxesFixture />
          )
        ) : (
          <React.Suspense fallback={null}>
            <ModelLoader />
          </React.Suspense>
        )}
        <PartTransformSync />
        <StepRunner />
        <MateExecutor />
        <MatePreviewMarkers />
        {view.showAnchors && <AnchorMarkers />}
        <SelectionOutline />
        <TransformGizmo />
        {view.showGrid && (
          <Grid
            infiniteGrid
            cellSize={0.5}
            sectionSize={5}
            cellThickness={0.8}
            sectionThickness={1.2}
            cellColor="#6b7280"
            sectionColor="#9ca3af"
            fadeDistance={50}
            fadeStrength={1}
            position={[0, -0.01, 0]}
          />
        )}
      </Canvas>
    </div>
  );
}
