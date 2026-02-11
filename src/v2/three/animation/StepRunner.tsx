import { useFrame } from '@react-three/fiber';
import React from 'react';
import * as THREE from 'three';
import { useV2Store } from '../../store/store';

type StepCache = {
  index: number;
  stepId: string | null;
  startTime: number;
  durationMs: number;
  partIds: string[];
  from: Record<string, { position: [number, number, number]; quaternion: [number, number, number, number]; scale: [number, number, number] }>;
  to: Record<string, { position: [number, number, number]; quaternion: [number, number, number, number]; scale: [number, number, number] }>;
};

const EPS = 1e-4;

function almostEqual(a: number, b: number) {
  return Math.abs(a - b) < EPS;
}

function transformEquals(a: { position: [number, number, number]; quaternion: [number, number, number, number]; scale: [number, number, number] }, b: { position: [number, number, number]; quaternion: [number, number, number, number]; scale: [number, number, number] }) {
  return (
    almostEqual(a.position[0], b.position[0]) &&
    almostEqual(a.position[1], b.position[1]) &&
    almostEqual(a.position[2], b.position[2]) &&
    almostEqual(a.quaternion[0], b.quaternion[0]) &&
    almostEqual(a.quaternion[1], b.quaternion[1]) &&
    almostEqual(a.quaternion[2], b.quaternion[2]) &&
    almostEqual(a.quaternion[3], b.quaternion[3]) &&
    almostEqual(a.scale[0], b.scale[0]) &&
    almostEqual(a.scale[1], b.scale[1]) &&
    almostEqual(a.scale[2], b.scale[2])
  );
}

export function StepRunner() {
  const playback = useV2Store((s) => s.playback);
  const steps = useV2Store((s) => s.steps.list);
  const parts = useV2Store((s) => s.parts);
  const setPartOverrideSilent = useV2Store((s) => s.setPartOverrideSilent);
  const clearAllPartOverridesSilent = useV2Store((s) => s.clearAllPartOverridesSilent);
  const setPlaybackIndex = useV2Store((s) => s.setPlaybackIndex);
  const stopPlayback = useV2Store((s) => s.stopPlayback);
  const selectStep = useV2Store((s) => s.selectStep);

  const cacheRef = React.useRef<StepCache | null>(null);
  const runningRef = React.useRef(false);

  React.useEffect(() => {
    if (!playback.running) {
      runningRef.current = false;
      cacheRef.current = null;
      return;
    }
    if (playback.order.length === 0) {
      stopPlayback();
      return;
    }
    clearAllPartOverridesSilent();
    runningRef.current = true;
    cacheRef.current = null;
    setPlaybackIndex(0);
  }, [playback.running, playback.order.length, clearAllPartOverridesSilent, setPlaybackIndex, stopPlayback]);

  const buildStepCache = React.useCallback(
    (index: number): StepCache | null => {
      const stepId = playback.order[index];
      const step = steps.find((s) => s.id === stepId);
      if (!step) return null;
      const from: StepCache['from'] = {};
      const to: StepCache['to'] = {};
      const partIds: string[] = [];
      parts.order.forEach((id) => {
        const initial = parts.initialTransformById[id];
        if (!initial) return;
        const current = parts.overridesById[id] || initial;
        const target = step.snapshotOverridesById?.[id] || initial;
        if (!transformEquals(current, target)) {
          from[id] = current;
          to[id] = target;
          partIds.push(id);
        }
      });
      selectStep(step.id);
      return {
        index,
        stepId: step.id,
        startTime: performance.now(),
        durationMs: playback.durationMs,
        partIds,
        from,
        to,
      };
    },
    [playback.durationMs, playback.order, parts.initialTransformById, parts.order, parts.overridesById, selectStep, steps]
  );

  useFrame(() => {
    if (!playback.running) return;
    if (!runningRef.current) return;
    if (!cacheRef.current || cacheRef.current.index !== playback.currentIndex) {
      const next = buildStepCache(playback.currentIndex);
      if (!next) {
        stopPlayback();
        return;
      }
      cacheRef.current = next;
    }
    const cache = cacheRef.current;
    if (!cache) return;
    const elapsed = performance.now() - cache.startTime;
    const t = Math.min(1, elapsed / cache.durationMs);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    const posFrom = new THREE.Vector3();
    const posTo = new THREE.Vector3();
    const quatFrom = new THREE.Quaternion();
    const quatTo = new THREE.Quaternion();
    const scaleFrom = new THREE.Vector3();
    const scaleTo = new THREE.Vector3();

    cache.partIds.forEach((id) => {
      const from = cache.from[id];
      const to = cache.to[id];
      if (!from || !to) return;
      posFrom.fromArray(from.position);
      posTo.fromArray(to.position);
      quatFrom.set(from.quaternion[0], from.quaternion[1], from.quaternion[2], from.quaternion[3]);
      quatTo.set(to.quaternion[0], to.quaternion[1], to.quaternion[2], to.quaternion[3]);
      scaleFrom.fromArray(from.scale);
      scaleTo.fromArray(to.scale);

      posFrom.lerp(posTo, ease);
      quatFrom.slerp(quatTo, ease);
      scaleFrom.lerp(scaleTo, ease);

      setPartOverrideSilent(id, {
        position: [posFrom.x, posFrom.y, posFrom.z],
        quaternion: [quatFrom.x, quatFrom.y, quatFrom.z, quatFrom.w],
        scale: [scaleFrom.x, scaleFrom.y, scaleFrom.z],
      });
    });

    if (t >= 1) {
      const nextIndex = cache.index + 1;
      if (nextIndex >= playback.order.length) {
        stopPlayback();
        return;
      }
      setPlaybackIndex(nextIndex);
    }
  });

  return null;
}
