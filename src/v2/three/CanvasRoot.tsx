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
import { NestedFixture } from './fixtures/NestedFixture';
import { StepRunner } from './animation/StepRunner';
import { SceneRegistryBridge } from './SceneRegistryBridge';

const GIZMO_RAYCAST_PRIORITY_FLAG = '__v2TransformGizmoHandle';

const hasGizmoPriorityAncestor = (object: any): boolean => {
  let node = object;
  while (node) {
    if (node.userData?.[GIZMO_RAYCAST_PRIORITY_FLAG]) return true;
    node = node.parent;
  }
  return false;
};

const prioritizeGizmoIntersections = (intersections: any[]) => {
  if (!Array.isArray(intersections) || intersections.length < 2) return intersections;
  let hasGizmoHit = false;
  const gizmoHits: any[] = [];
  const otherHits: any[] = [];
  for (const hit of intersections) {
    if (hasGizmoPriorityAncestor(hit?.object)) {
      hasGizmoHit = true;
      gizmoHits.push(hit);
    } else {
      otherHits.push(hit);
    }
  }
  return hasGizmoHit ? [...gizmoHits, ...otherHits] : intersections;
};

export function CanvasRoot() {
  const view = useV2Store((s) => s.view);
  const cadUrl = useV2Store((s) => s.cadUrl);
  const fixtureId = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('fixture') : null;
  const shouldUseFixture = Boolean(fixtureId) || !cadUrl;
  const fixture = fixtureId || 'boxes';

  return (
    <div className="w-full h-full">
      <Canvas
        camera={{ position: [4, 4, 4], fov: 50 }}
        onCreated={(state) => {
          const prevFilter = state.events.filter;
          state.events.filter = (intersections, eventState) => {
            const base = prevFilter ? prevFilter(intersections, eventState) : intersections;
            const current = useV2Store.getState();
            if (!current.selection.partId) return base;
            if (current.interaction.mode !== 'move' && current.interaction.mode !== 'rotate') return base;
            return prioritizeGizmoIntersections(base as any[]);
          };
        }}
      >
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
          ) : fixture === 'nested' ? (
            <NestedFixture />
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
