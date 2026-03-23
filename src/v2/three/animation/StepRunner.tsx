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
  // Subscribe to only the fields that gate the useEffect
  const playbackRunning = useV2Store((s) => s.playback.running);
  const playbackOrderLength = useV2Store((s) => s.playback.order.length);
  const playbackTargetStepId = useV2Store((s) => s.playback.targetStepId);
  const playbackResetToStepId = useV2Store((s) => s.playback.resetToStepId);

  const cacheRef = React.useRef<StepCache | null>(null);
  const runningRef = React.useRef(false);

  React.useEffect(() => {
    if (!playbackRunning) {
      runningRef.current = false;
      cacheRef.current = null;
      return;
    }
    if (playbackOrderLength === 0) {
      useV2Store.getState().stopPlayback();
      return;
    }

    // Always read fresh state inside the effect to avoid mutation-loop and stale closure issues
    const state = useV2Store.getState();
    const curParts = state.parts;
    const curSteps = state.steps.list;

    if (playbackResetToStepId) {
      // Forward jump: reset to the snapshot of the "from" step
      const resetStep = curSteps.find((s) => s.id === playbackResetToStepId);
      curParts.order.forEach((id) => {
        const t = (resetStep?.snapshotOverridesById?.[id]) ?? curParts.initialTransformById[id];
        if (t) state.setPartOverrideSilent(id, t);
      });
    } else if (playbackTargetStepId) {
      // Single-step play: reset to the step before target.
      // If there is no previous step, fall back to the target step's baseManualTransforms
      // (the user-arranged positions captured at add-step time) so the animation starts
      // from the user's pre-mate arrangement, not from the original import positions.
      const targetIndex = curSteps.findIndex((s) => s.id === playbackTargetStepId);
      const targetStep = curSteps[targetIndex];
      const prevStep = targetIndex > 0 ? curSteps[targetIndex - 1] : null;
      curParts.order.forEach((id) => {
        const t =
          (prevStep?.snapshotOverridesById?.[id]) ??
          (targetStep?.baseManualTransforms?.[id]) ??
          curParts.initialTransformById[id];
        if (t) state.setPartOverrideSilent(id, t);
      });
    } else {
      // Full playback (RUN button): start from the first step's pre-animation state
      // (captured in baseManualTransforms at add-step time — the user's arranged positions),
      // falling back to the original import positions when not available.
      const firstStep = curSteps[0];
      curParts.order.forEach((id) => {
        const t =
          (firstStep?.baseManualTransforms?.[id]) ??
          curParts.initialTransformById[id];
        if (t) state.setPartOverrideSilent(id, t);
      });
    }

    runningRef.current = true;
    cacheRef.current = null;
    state.setPlaybackIndex(0);
  }, [playbackRunning, playbackOrderLength, playbackTargetStepId, playbackResetToStepId]);

  // Build a step cache using fresh store state (avoids stale closure of parts.overridesById)
  const buildStepCache = React.useCallback((index: number): StepCache | null => {
    const state = useV2Store.getState();
    const stepId = state.playback.order[index];
    const step = state.steps.list.find((s) => s.id === stepId);
    if (!step) return null;

    const from: StepCache['from'] = {};
    const to: StepCache['to'] = {};
    const partIds: string[] = [];

    state.parts.order.forEach((id) => {
      const initial = state.parts.initialTransformById[id];
      if (!initial) return;
      const current = state.parts.overridesById[id] ?? initial;
      const target = step.snapshotOverridesById?.[id] ?? initial;
      if (!transformEquals(current, target)) {
        from[id] = current;
        to[id] = target;
        partIds.push(id);
      }
    });

    state.selectStep(step.id);

    // Intermediate steps (not the final animated target) play instantly
    const isInstant = !!state.playback.targetStepId && step.id !== state.playback.targetStepId;
    return {
      index,
      stepId: step.id,
      startTime: performance.now(),
      durationMs: isInstant ? 0 : state.playback.durationMs,
      partIds,
      from,
      to,
    };
  }, []); // No deps — always reads fresh from store

  useFrame(() => {
    const state = useV2Store.getState();
    if (!state.playback.running) return;
    if (!runningRef.current) return;

    if (!cacheRef.current || cacheRef.current.index !== state.playback.currentIndex) {
      const next = buildStepCache(state.playback.currentIndex);
      if (!next) {
        state.stopPlayback();
        return;
      }
      cacheRef.current = next;
    }

    const cache = cacheRef.current;
    if (!cache) return;
    const elapsed = performance.now() - cache.startTime;
    const t = cache.durationMs <= 0 ? 1 : Math.min(1, elapsed / cache.durationMs);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    const posFrom = new THREE.Vector3();
    const posTo = new THREE.Vector3();
    const quatFrom = new THREE.Quaternion();
    const quatTo = new THREE.Quaternion();
    const scaleFrom = new THREE.Vector3();
    const scaleTo = new THREE.Vector3();

    cache.partIds.forEach((id) => {
      const f = cache.from[id];
      const to = cache.to[id];
      if (!f || !to) return;
      posFrom.fromArray(f.position);
      posTo.fromArray(to.position);
      quatFrom.set(f.quaternion[0], f.quaternion[1], f.quaternion[2], f.quaternion[3]);
      quatTo.set(to.quaternion[0], to.quaternion[1], to.quaternion[2], to.quaternion[3]);
      scaleFrom.fromArray(f.scale);
      scaleTo.fromArray(to.scale);

      posFrom.lerp(posTo, ease);
      quatFrom.slerp(quatTo, ease);
      scaleFrom.lerp(scaleTo, ease);

      state.setPartOverrideSilent(id, {
        position: [posFrom.x, posFrom.y, posFrom.z],
        quaternion: [quatFrom.x, quatFrom.y, quatFrom.z, quatFrom.w],
        scale: [scaleFrom.x, scaleFrom.y, scaleFrom.z],
      });
    });

    if (t >= 1) {
      const nextIndex = cache.index + 1;
      if (nextIndex >= state.playback.order.length) {
        state.stopPlayback();
        return;
      }
      state.setPlaybackIndex(nextIndex);
    }
  });

  return null;
}
