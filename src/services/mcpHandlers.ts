/**
 * MCP Handler implementations — runs in the React frontend.
 *
 * Each handler receives (command, args) from MCPBridge and returns a result
 * that gets JSON-stringified and sent back to the MCP server via WebSocket.
 *
 * Geometry-heavy tools (align_faces, compute_mate, compute_twist) run the
 * computation here because they need direct access to the Three.js scene graph.
 */

import * as THREE from 'three';
import { useAppStore } from '../store/useAppStore';
import type { MCPBridge } from './MCPBridge';
import type { InteractionMode, MateMode, FaceDirection, Vec3, Quat, PathKeyframe } from '../../shared/types';
import {
  computeFaceFrame,
  computeMate,
  computeTwist,
  worldToLocal,
  findMeshByName,
} from '../utils/geometry';

// ── Scene reference (set by SceneConnector component inside Canvas) ──

let _scene: THREE.Scene | null = null;

export function setSceneRef(scene: THREE.Scene | null) {
  _scene = scene;
}

function requireScene(): THREE.Scene {
  if (!_scene) throw new Error('Scene not available yet');
  return _scene;
}

// ── Helpers ──

/** Convert quaternion to euler rotation tuple */
function quatToRot(q: Quat): [number, number, number] {
  const euler = new THREE.Euler().setFromQuaternion(
    new THREE.Quaternion(q[0], q[1], q[2], q[3]),
  );
  return [euler.x, euler.y, euler.z];
}

function resolvePart(nameOrId: string) {
  const state = useAppStore.getState();
  const parts = state.parts;

  if (parts[nameOrId]) return parts[nameOrId];

  const lower = nameOrId.toLowerCase();
  for (const p of Object.values(parts)) {
    if (p.name.toLowerCase() === lower) return p;
  }
  for (const p of Object.values(parts)) {
    if (p.name.toLowerCase().includes(lower)) return p;
  }

  throw new Error(`Part not found: "${nameOrId}"`);
}

function resolveMesh(nameOrId: string): THREE.Mesh {
  const scene = requireScene();
  const mesh = findMeshByName(scene, nameOrId);
  if (!mesh) {
    const part = resolvePart(nameOrId);
    const obj = scene.getObjectByProperty('uuid', part.uuid);
    if (obj instanceof THREE.Mesh) return obj;
    let found: THREE.Mesh | null = null;
    obj?.traverse((c) => { if (!found && c instanceof THREE.Mesh) found = c; });
    if (found) return found;
    throw new Error(`Mesh not found in scene for part: "${nameOrId}"`);
  }
  return mesh;
}

function makeHistoryEntry(description: string, partUuid: string, beforePos: Vec3, beforeRot: Vec3, afterPos: Vec3, afterRot: Vec3) {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    description,
    partUuid,
    before: { position: beforePos as [number, number, number], rotation: beforeRot as [number, number, number] },
    after: { position: afterPos as [number, number, number], rotation: afterRot as [number, number, number] },
  };
}

// ── Handler Registration ──

export function registerMcpHandlers(bridge: MCPBridge) {
  const store = useAppStore;

  // ────────────────────────────────────────────
  // Query
  // ────────────────────────────────────────────

  bridge.registerHandler('get_scene_state', async () => {
    const state = store.getState();
    return {
      parts: Object.values(state.parts).map((p) => ({
        id: p.uuid,
        name: p.name,
        position: p.position,
        rotation: p.rotation,
        scale: p.scale,
        color: p.color,
      })),
      selectedPartId: state.selectedPartId,
      interactionMode: state.interactionMode,
      previewActive: state.previewState.active,
      undoDepth: state.history.undoStack.length,
      redoDepth: state.history.redoStack.length,
      constraintCount: state.constraints.length,
      environment: state.environmentPreset,
      floor: state.floorStyle,
    };
  });

  bridge.registerHandler('get_ui_state', async () => {
    const state = store.getState();
    return {
      interactionMode: state.interactionMode,
      preview: state.previewState,
      isAnimationPlaying: state.isAnimationPlaying,
      isSequencePlaying: state.isSequencePlaying,
      sequenceLength: state.sequence.length,
      currentStepIndex: state.currentStepIndex,
      undoDepth: state.history.undoStack.length,
      redoDepth: state.history.redoStack.length,
    };
  });

  // ────────────────────────────────────────────
  // Selection
  // ────────────────────────────────────────────

  bridge.registerHandler('select_part', async (_cmd, args) => {
    const part = resolvePart(args.part);
    store.getState().selectPart(part.uuid);
    return { selected: part.uuid, name: part.name };
  });

  // ────────────────────────────────────────────
  // Transform
  // ────────────────────────────────────────────

  bridge.registerHandler('move_part', async (_cmd, args) => {
    const part = resolvePart(args.part);
    const current = part.position;
    const pos: [number, number, number] = args.absolute
      ? [args.position[0], args.position[1], args.position[2]]
      : [current[0] + args.position[0], current[1] + args.position[1], current[2] + args.position[2]];

    if (args.preview) {
      const q: Quat = [0, 0, 0, 1];
      store.getState().startPreview(part.uuid, { position: pos, quaternion: q });
      return { preview: true, position: pos };
    }

    store.getState().updatePart(part.uuid, { position: pos });
    store.getState().pushHistory(
      makeHistoryEntry('move_part', part.uuid, current, part.rotation, pos, part.rotation),
    );
    return { applied: true, position: pos };
  });

  bridge.registerHandler('rotate_part', async (_cmd, args) => {
    const part = resolvePart(args.part);

    let axis: THREE.Vector3;
    if (typeof args.axis === 'string') {
      axis = new THREE.Vector3(
        args.axis === 'x' ? 1 : 0,
        args.axis === 'y' ? 1 : 0,
        args.axis === 'z' ? 1 : 0,
      );
    } else {
      axis = new THREE.Vector3(args.axis[0], args.axis[1], args.axis[2]).normalize();
    }

    const angleRad = THREE.MathUtils.degToRad(args.angle);
    const deltaQ = new THREE.Quaternion().setFromAxisAngle(axis, angleRad);

    let finalQ: THREE.Quaternion;
    if (args.absolute) {
      finalQ = deltaQ;
    } else {
      const currentQ = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(part.rotation[0], part.rotation[1], part.rotation[2]),
      );
      finalQ = deltaQ.multiply(currentQ);
    }

    const euler = new THREE.Euler().setFromQuaternion(finalQ);
    const rot: [number, number, number] = [euler.x, euler.y, euler.z];

    if (args.preview) {
      const q: Quat = [finalQ.x, finalQ.y, finalQ.z, finalQ.w];
      store.getState().startPreview(part.uuid, { position: part.position, quaternion: q });
      return { preview: true, rotation: rot };
    }

    const beforeRot = part.rotation;
    store.getState().updatePart(part.uuid, { rotation: rot });
    store.getState().pushHistory(
      makeHistoryEntry('rotate_part', part.uuid, part.position, beforeRot, part.position, rot),
    );
    return { applied: true, rotation: rot };
  });

  // ────────────────────────────────────────────
  // Mate / Align
  // ────────────────────────────────────────────

  bridge.registerHandler('align_faces', async (_cmd, args) => {
    const srcMesh = resolveMesh(args.source_part);
    const tgtMesh = resolveMesh(args.target_part);

    const result = computeMate(
      srcMesh, args.source_face as FaceDirection,
      tgtMesh, args.target_face as FaceDirection,
      args.mode as MateMode,
      args.offset ?? 0,
      args.flip ?? false,
      args.twist_angle ?? 0,
    );

    const afterRot = quatToRot(result.quaternion);

    if (args.preview) {
      store.getState().startPreview(
        srcMesh.uuid,
        { position: result.position, quaternion: result.quaternion },
        result.path,
        2.0,
      );
      return { preview: true, ...result };
    }

    const part = resolvePart(args.source_part);
    const beforePos = part.position;
    const beforeRot = part.rotation;
    store.getState().updatePart(part.uuid, {
      position: result.position as [number, number, number],
      rotation: afterRot,
    });
    store.getState().pushHistory(
      makeHistoryEntry('align_faces', part.uuid, beforePos, beforeRot, result.position, afterRot),
    );

    return { applied: true, ...result };
  });

  bridge.registerHandler('compute_mate', async (_cmd, args) => {
    const srcMesh = resolveMesh(args.source_part);
    const tgtMesh = resolveMesh(args.target_part);
    return computeMate(
      srcMesh, args.source_face as FaceDirection,
      tgtMesh, args.target_face as FaceDirection,
      args.mode as MateMode,
      args.offset ?? 0,
      args.flip ?? false,
      args.twist_angle ?? 0,
    );
  });

  bridge.registerHandler('compute_twist', async (_cmd, args) => {
    const mesh = resolveMesh(args.part);
    return computeTwist(
      mesh,
      args.axis || 'z',
      args.angle || 0,
      args.reference_face as FaceDirection | undefined,
      args.snap_increment,
    );
  });

  // ────────────────────────────────────────────
  // Preview & Commit
  // ────────────────────────────────────────────

  bridge.registerHandler('preview_transform', async (_cmd, args) => {
    const part = resolvePart(args.part);
    const pos: Vec3 = args.position || part.position;
    const quat: Quat = args.quaternion || [0, 0, 0, 1];
    store.getState().startPreview(part.uuid, { position: pos, quaternion: quat }, args.path, args.duration);
    return { preview: true, partUuid: part.uuid };
  });

  bridge.registerHandler('commit_transform', async (_cmd, args) => {
    const state = store.getState();
    const part = resolvePart(args.part);

    if (state.previewState.active && state.previewState.partUuid === part.uuid) {
      state.commitPreview();
    } else if (args.position || args.quaternion) {
      const pos: Vec3 = args.position || part.position;
      const quat: Quat = args.quaternion || [0, 0, 0, 1];
      const rot = quatToRot(quat);
      state.updatePart(part.uuid, {
        position: pos as [number, number, number],
        rotation: rot,
      });
      state.pushHistory(
        makeHistoryEntry('commit_transform', part.uuid, part.position, part.rotation, pos, rot),
      );
    }

    if (args.add_to_sequence) {
      const endPos = args.position || part.position;
      state.addStep({
        id: crypto.randomUUID(),
        partId: part.uuid,
        startMarker: { position: part.position },
        endMarker: { position: endPos as [number, number, number] },
        duration: 2.0,
        easing: 'easeInOut',
        description: args.step_description || 'Committed transform',
        targetQuaternion: args.quaternion,
      });
    }

    return { committed: true, partUuid: part.uuid };
  });

  bridge.registerHandler('cancel_preview', async () => {
    const state = store.getState();
    if (state.previewState.active) {
      state.cancelPreview();
      return { cancelled: true };
    }
    return { cancelled: false, reason: 'No active preview' };
  });

  // ────────────────────────────────────────────
  // History
  // ────────────────────────────────────────────

  bridge.registerHandler('undo', async () => {
    const entry = store.getState().undo();
    if (!entry) return { success: false, reason: 'Nothing to undo' };
    return { success: true, undone: entry.description, partUuid: entry.partUuid };
  });

  bridge.registerHandler('redo', async () => {
    const entry = store.getState().redo();
    if (!entry) return { success: false, reason: 'Nothing to redo' };
    return { success: true, redone: entry.description, partUuid: entry.partUuid };
  });

  // ────────────────────────────────────────────
  // Mode
  // ────────────────────────────────────────────

  bridge.registerHandler('set_interaction_mode', async (_cmd, args) => {
    store.getState().setInteractionMode(args.mode as InteractionMode);
    return { mode: args.mode };
  });

  // ────────────────────────────────────────────
  // Animation / Sequence
  // ────────────────────────────────────────────

  bridge.registerHandler('add_animation_step', async (_cmd, args) => {
    const part = resolvePart(args.part);
    const targetPos: [number, number, number] = args.target_position || part.position;
    const id = crypto.randomUUID();

    store.getState().addStep({
      id,
      partId: part.uuid,
      startMarker: { position: part.position },
      endMarker: { position: targetPos },
      duration: args.duration || 2.0,
      easing: args.easing || 'easeInOut',
      description: args.description,
      path: args.path,
      targetQuaternion: args.target_quaternion,
    });

    return { added: true, stepId: id, partName: part.name };
  });

  bridge.registerHandler('play_animation', async (_cmd, args) => {
    const state = store.getState();
    if (args?.mode === 'single_step' && args.step_index != null) {
      state.setAnimationPlaying(true);
      return { playing: true, mode: 'single_step', step: args.step_index };
    }
    state.playSequence();
    return { playing: true, mode: 'sequence', steps: state.sequence.length };
  });

  bridge.registerHandler('stop_animation', async () => {
    const state = store.getState();
    state.stopSequence();
    state.setAnimationPlaying(false);
    return { stopped: true };
  });

  // ────────────────────────────────────────────
  // Scene
  // ────────────────────────────────────────────

  bridge.registerHandler('reset_scene', async () => {
    store.getState().resetAllParts();
    store.getState().triggerReset();
    return { reset: true };
  });

  bridge.registerHandler('reset_part', async (_cmd, args) => {
    const part = resolvePart(args.part);
    store.getState().resetPart(part.uuid);
    return { reset: true, partName: part.name };
  });

  bridge.registerHandler('load_model', async (_cmd, args) => {
    store.getState().setCadUrl(args.url, args.filename || args.url);
    return { loading: true, url: args.url };
  });

  // ────────────────────────────────────────────
  // UI / Environment
  // ────────────────────────────────────────────

  bridge.registerHandler('set_environment', async (_cmd, args) => {
    const state = store.getState();
    if (args.preset) state.setEnvironmentPreset(args.preset);
    if (args.floor) state.setFloorStyle(args.floor);
    return { preset: args.preset, floor: args.floor };
  });

  // ────────────────────────────────────────────
  // Legacy handlers (backward compat)
  // ────────────────────────────────────────────

  bridge.registerHandler('set_pose_target', async (_cmd, args) => {
    const state = store.getState();
    const source = resolvePart(args.source);
    const target = resolvePart(args.target);

    state.selectPart(source.uuid);
    state.setMovingPartId(source.uuid);

    try {
      const srcMesh = resolveMesh(args.source);
      const tgtMesh = resolveMesh(args.target);
      const srcFrame = computeFaceFrame(srcMesh, args.source_face as FaceDirection);
      const tgtFrame = computeFaceFrame(tgtMesh, args.target_face as FaceDirection);
      state.setStartMarker(srcFrame.frame.origin as [number, number, number]);
      state.setEndMarker(tgtFrame.frame.origin as [number, number, number]);
    } catch {
      state.setStartMarker(source.position);
      state.setEndMarker(target.position);
    }

    return { source: source.name, target: target.name };
  });

  bridge.registerHandler('set_marker_manual', async (_cmd, args) => {
    const pos: [number, number, number] = [args.x, args.y, args.z];
    if (args.type === 'start') {
      store.getState().setStartMarker(pos);
    } else {
      store.getState().setEndMarker(pos);
    }
    return { marker: args.type, position: pos };
  });

  bridge.registerHandler('preview_animation', async () => {
    store.getState().setAnimationPlaying(true);
    return 'Playing animation preview';
  });

  bridge.registerHandler('add_current_step', async (_cmd, args) => {
    const state = store.getState();
    if (!state.movingPartId || !state.startMarker || !state.endMarker) {
      throw new Error('No animation configured to add as step');
    }
    state.addStep({
      id: crypto.randomUUID(),
      partId: state.movingPartId,
      startMarker: state.startMarker,
      endMarker: state.endMarker,
      duration: state.animationDuration,
      easing: state.animationEasing,
      description: args?.description || 'Animation step',
    });
    return 'Step added';
  });

  bridge.registerHandler('load_demo_model', async () => {
    store.getState().setCadUrl('/test_model.glb', 'demo_model.glb');
    return 'Demo model loading';
  });

  bridge.registerHandler('play_sequence', async () => {
    store.getState().playSequence();
    return 'Playing animation sequence';
  });

  bridge.registerHandler('reset_selected_part', async () => {
    const { selectedPartId, resetPart, parts } = store.getState();
    if (selectedPartId && parts[selectedPartId]) {
      resetPart(selectedPartId);
      return `Reset part: ${parts[selectedPartId].name}`;
    }
    return 'No part selected to reset';
  });
}
