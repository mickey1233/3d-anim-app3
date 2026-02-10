import { create } from 'zustand';
import * as THREE from 'three';
import type {
  Vec3, Quat, FaceDirection, InteractionMode, MateMode,
  FaceFrame, PathKeyframe, HistoryEntry, Constraint, PreviewState,
} from '../../shared/types';

// Data Types
export interface PartData {
  uuid: string;
  name: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  color: string;
  // Initial State for Reset
  initialPosition?: [number, number, number];
  initialRotation?: [number, number, number];
  initialScale?: [number, number, number];
}

export interface MarkerData {
    position: [number, number, number];
}

export interface AnimationStep {
  id: string;
  partId: string;
  startMarker: MarkerData;
  endMarker: MarkerData;
  duration: number;
  easing: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
  description: string;
  /** Optional arc/path keyframes (for insert/both mode) */
  path?: PathKeyframe[];
  /** Optional target quaternion (for rotation-aware steps) */
  targetQuaternion?: Quat;
}

export interface SelectedFace {
  partUuid: string;
  face: FaceDirection;
  frame: FaceFrame;
}

export interface ImageItem {
    id: string;
    url: string;
    name: string;
    file: File;
    partPositions: Record<string, { x: number, y: number }>; // 2D Coords
    camera?: {
        pose_world: { position: number[], quaternion: number[] };
    };
    parts?: any[];
}

// Store Interface
interface AppState {
    // ... existing ... 
    cadUrl: string | null;
    cadFileName: string | null;
  
    parts: Record<string, PartData>; 
    selectedPartId: string | null;

    // Controls / Interaction
    isTransformDragging: boolean;
    transformDraggingById: Record<string, true>;
    selectedMarkerId: 'start' | 'end' | null;

    // Status
    wsStatus: 'disconnected' | 'connecting' | 'connected';
    modelLoading: boolean;
    modelLoadingProgress: number;
    modelError: string | null;
    
    // Animation State
    isAnimationPlaying: boolean;
    pickingMode: 'idle' | 'start' | 'end';
    
    startMarker: MarkerData | null;
    endMarker: MarkerData | null;
    
    movingPartId: string | null; 
    animationDuration: number; 
    animationEasing: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

    // Scene Control
    resetTrigger: number;
    environmentPreset: 'warehouse' | 'city' | 'sunset' | 'studio' | 'night' | 'apartment' | 'forest' | 'dawn' | 'lobby' | 'park';
    floorStyle: 'grid' | 'reflective' | 'none';

    // Sequence State
    sequence: AnimationStep[];
    isSequencePlaying: boolean;
    currentStepIndex: number;

    // Images & Calibration
    images: ImageItem[];
    selectedImageId: string | null;
    calibrationMode: boolean;

    // Global Calibration / Transforms
    cameraTransform: {
        position: [number, number, number];
        rotation: [number, number, number];
    };
    objectTransform: {
        position: [number, number, number];
        rotation: [number, number, number];
    };

    // ── NEW: Interaction Mode ──
    interactionMode: InteractionMode;

    // ── NEW: Face Selection ──
    selectedFaces: SelectedFace[];

    // ── NEW: Preview State ──
    previewState: PreviewState;

    // ── NEW: Constraints (Mates) ──
    constraints: Constraint[];

    // ── NEW: History (Undo/Redo) ──
    history: {
        undoStack: HistoryEntry[];
        redoStack: HistoryEntry[];
    };

    // Actions
    setCadUrl: (url: string, fileName: string) => void;
    registerPart: (part: PartData) => void;
    updatePart: (uuid: string, data: Partial<PartData>) => void;
    resetPart: (uuid: string) => void;
    resetAllParts: () => void;
    selectPart: (uuid: string | null) => void;
    
    setAnimationPlaying: (playing: boolean) => void;
    setPickingMode: (mode: 'idle' | 'start' | 'end') => void;
    
    setStartMarker: (position: [number, number, number] | null) => void;
    setEndMarker: (position: [number, number, number] | null) => void;
    
    setMovingPartId: (uuid: string | null) => void;
    setAnimationConfig: (duration: number, easing: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut') => void;
    triggerReset: () => void;
    
    setEnvironmentPreset: (preset: 'warehouse' | 'city' | 'sunset' | 'studio' | 'night' | 'apartment' | 'forest' | 'dawn' | 'lobby' | 'park') => void;
    setFloorStyle: (style: 'grid' | 'reflective' | 'none') => void;

    // Image Actions
    addImage: (file: File) => void;
    reorderImages: (images: ImageItem[]) => void;
    selectImage: (id: string | null) => void;
    setCalibrationMode: (active: boolean) => void;

    setCameraTransform: (position: [number, number, number], rotation: [number, number, number]) => void;
    setObjectTransform: (position: [number, number, number], rotation: [number, number, number]) => void;

    // Sequence Actions
    addStep: (step: AnimationStep) => void;
    updateStep: (id: string, data: Partial<AnimationStep>) => void;
    removeStep: (id: string) => void;
    playSequence: () => void;
    stopSequence: () => void;
    nextStep: () => void;

    setTransformDragging: (id: string, dragging: boolean) => void;
    setSelectedMarkerId: (id: 'start' | 'end' | null) => void;

    setWsStatus: (status: 'disconnected' | 'connecting' | 'connected') => void;
    setModelLoading: (active: boolean, progress: number) => void;
    setModelError: (error: string | null) => void;

    // ── NEW: Interaction Mode ──
    setInteractionMode: (mode: InteractionMode) => void;

    // ── NEW: Face Selection ──
    addSelectedFace: (face: SelectedFace) => void;
    clearSelectedFaces: () => void;

    // ── NEW: Preview ──
    startPreview: (partUuid: string, transform: { position: Vec3; quaternion: Quat }, path?: PathKeyframe[], duration?: number) => void;
    cancelPreview: () => void;
    commitPreview: () => void;

    // ── NEW: Constraints ──
    addConstraint: (constraint: Constraint) => void;
    removeConstraint: (id: string) => void;

    // ── NEW: History ──
    pushHistory: (entry: HistoryEntry) => void;
    undo: () => HistoryEntry | null;
    redo: () => HistoryEntry | null;
}

  // Store Implementation
export const useAppStore = create<AppState>((set, get) => ({
  cadUrl: '/test_model.glb', // Auto-load the large test file
  cadFileName: 'L10_VSOP.glb',
  parts: {},
  selectedPartId: null,

  isTransformDragging: false,
  transformDraggingById: {},
  selectedMarkerId: null,

  wsStatus: 'disconnected',
  modelLoading: false,
  modelLoadingProgress: 0,
  modelError: null,

  isAnimationPlaying: false,
  pickingMode: 'idle',
  startMarker: null,
  endMarker: null,
  movingPartId: null,
  animationDuration: 2.0,
  animationEasing: 'easeInOut',
  resetTrigger: 0,
  environmentPreset: 'warehouse',
  floorStyle: 'grid',

  sequence: [],
  isSequencePlaying: false,
  currentStepIndex: -1,

  // Helper to export state for MCP
  getStateExport: () => {
      const state = get();
      return {
          parts: Object.values(state.parts).map(p => ({
              id: p.uuid,
              name: p.name,
              position: p.position,
              rotation: p.rotation
          })),
          camera: state.cameraTransform
      };
  },

  images: [],
  selectedImageId: null,
  calibrationMode: false,

  cameraTransform: { position: [0,0,0], rotation: [0,0,0] },
  objectTransform: { position: [0,0,0], rotation: [0,0,0] },

  // ── NEW state fields ──
  interactionMode: 'move' as InteractionMode,
  selectedFaces: [],
  previewState: {
    active: false,
    partUuid: null,
    previewId: null,
    originalTransform: null,
    previewTransform: null,
    path: null,
    duration: 2.0,
    isAnimating: false,
  },
  constraints: [],
  history: { undoStack: [], redoStack: [] },

  setCadUrl: (url, fileName) => set({ cadUrl: url, cadFileName: fileName }),

  registerPart: (part) => set((state) => {
      // Auto-set initial values if not present
      const initialPart = {
          ...part,
          initialPosition: part.initialPosition || part.position,
          initialRotation: part.initialRotation || part.rotation,
          initialScale: part.initialScale || part.scale
      };
      return { parts: { ...state.parts, [part.uuid]: initialPart } };
  }),

  updatePart: (uuid, data) => set((state) => ({ images: state.images, parts: { ...state.parts, [uuid]: { ...state.parts[uuid], ...data } } })),

  resetPart: (uuid) => set((state) => {
      const part = state.parts[uuid];
      if (!part) return {}; 
      return {
          parts: {
              ...state.parts,
              [uuid]: {
                  ...part,
                  position: part.initialPosition ? [...part.initialPosition] : part.position,
                  rotation: part.initialRotation ? [...part.initialRotation] : part.rotation,
                  // Keep current scale, do not reset to initial
                  scale: part.scale 
              }
          }
      };
  }),

  resetAllParts: () => set((state) => {
      const newParts = { ...state.parts };
      Object.keys(newParts).forEach(key => {
          const part = newParts[key];
          newParts[key] = {
              ...part,
              position: part.initialPosition ? [...part.initialPosition] : part.position,
              rotation: part.initialRotation ? [...part.initialRotation] : part.rotation,
              // Keep current scale
              scale: part.scale
          };
      });
      return { 
          parts: newParts,
          isAnimationPlaying: false,
          isSequencePlaying: false,
          currentStepIndex: -1,
          movingPartId: null,
          startMarker: null,
          endMarker: null,
          selectedMarkerId: null
      };
  }),

  selectPart: (uuid) => set({ selectedPartId: uuid, movingPartId: uuid }),
  setSelectedMarkerId: (id) => set({ selectedMarkerId: id }),

  setWsStatus: (status) => set({ wsStatus: status }),
  setModelLoading: (active, progress) => set({ modelLoading: active, modelLoadingProgress: progress }),
  setModelError: (error) => set({ modelError: error }),
  
  setTransformDragging: (id, dragging) =>
      set((state) => {
          const next = { ...state.transformDraggingById };
          if (dragging) next[id] = true;
          else delete next[id];
          return {
              transformDraggingById: next,
              isTransformDragging: Object.keys(next).length > 0
          };
      }),
  
  setAnimationPlaying: (playing) => set({ isAnimationPlaying: playing }),
  setPickingMode: (mode) => set({ pickingMode: mode }),
  
  setStartMarker: (position) => set({ startMarker: position ? { position } : null }),
  setEndMarker: (position) => set({ endMarker: position ? { position } : null }),
  
  setMovingPartId: (uuid) => set({ movingPartId: uuid }),
  setAnimationConfig: (duration, easing) => set({ animationDuration: duration, animationEasing: easing }),
  triggerReset: () => set((state) => ({ resetTrigger: state.resetTrigger + 1, isAnimationPlaying: false, isSequencePlaying: false, currentStepIndex: -1, selectedMarkerId: null })),

  // Image Actions Impl
  addImage: (file) => set((state) => {
      const id = crypto.randomUUID();
      const url = URL.createObjectURL(file);
      return { 
          images: [...state.images, { 
              id, url, name: file.name, file, partPositions: {} 
          }] 
      };
  }),
  reorderImages: (images) => set({ images }),
  selectImage: (id) => set({ selectedImageId: id }),
  setCalibrationMode: (active) => set({ calibrationMode: active }),

  setCameraTransform: (position, rotation) => set({ cameraTransform: { position, rotation } }),
  setObjectTransform: (position, rotation) => set({ objectTransform: { position, rotation } }),

  setEnvironmentPreset: (preset) => set({ environmentPreset: preset }),
  setFloorStyle: (style) => set({ floorStyle: style }),

  // ── NEW: Interaction Mode ──
  setInteractionMode: (mode) => set({ interactionMode: mode }),

  // ── NEW: Face Selection ──
  addSelectedFace: (face) => set((state) => ({
    selectedFaces: [...state.selectedFaces.filter(f =>
      !(f.partUuid === face.partUuid && f.face === face.face)
    ), face],
  })),
  clearSelectedFaces: () => set({ selectedFaces: [] }),

  // ── NEW: Preview ──
  startPreview: (partUuid, transform, path, duration) => set((state) => {
    const part = state.parts[partUuid];
    if (!part) return {};
    return {
      previewState: {
        active: true,
        partUuid,
        previewId: crypto.randomUUID(),
        originalTransform: {
          position: [...part.position] as Vec3,
          rotation: [...part.rotation] as Vec3,
        },
        previewTransform: transform,
        path: path ?? null,
        duration: duration ?? 2.0,
        isAnimating: !!path,
      },
    };
  }),

  cancelPreview: () => set((state) => {
    const { previewState } = state;
    if (!previewState.active || !previewState.partUuid || !previewState.originalTransform) {
      return { previewState: { ...previewState, active: false, partUuid: null, previewId: null, originalTransform: null, previewTransform: null, path: null, isAnimating: false } };
    }
    // Restore original transform
    const part = state.parts[previewState.partUuid];
    if (!part) return { previewState: { ...previewState, active: false } };
    return {
      parts: {
        ...state.parts,
        [previewState.partUuid]: {
          ...part,
          position: [...previewState.originalTransform.position] as [number, number, number],
          rotation: [...previewState.originalTransform.rotation] as [number, number, number],
        },
      },
      previewState: {
        active: false,
        partUuid: null,
        previewId: null,
        originalTransform: null,
        previewTransform: null,
        path: null,
        duration: 2.0,
        isAnimating: false,
      },
    };
  }),

  commitPreview: () => set((state) => {
    const { previewState } = state;
    if (!previewState.active || !previewState.partUuid || !previewState.previewTransform) {
      return {};
    }
    const part = state.parts[previewState.partUuid];
    if (!part) return {};

    // Build history entry
    const historyEntry: HistoryEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      description: `Transform ${part.name}`,
      partUuid: previewState.partUuid,
      before: {
        position: previewState.originalTransform?.position ?? part.position,
        rotation: previewState.originalTransform?.rotation ?? part.rotation,
      },
      after: {
        position: previewState.previewTransform.position,
        // Convert quaternion to euler for storage
        rotation: (() => {
          const q = previewState.previewTransform.quaternion;
          const euler = new THREE.Euler().setFromQuaternion(
            new THREE.Quaternion(q[0], q[1], q[2], q[3])
          );
          return [euler.x, euler.y, euler.z] as Vec3;
        })(),
      },
    };

    const afterRotation = historyEntry.after.rotation;

    return {
      parts: {
        ...state.parts,
        [previewState.partUuid]: {
          ...part,
          position: [...previewState.previewTransform.position] as [number, number, number],
          rotation: [...afterRotation] as [number, number, number],
        },
      },
      previewState: {
        active: false,
        partUuid: null,
        previewId: null,
        originalTransform: null,
        previewTransform: null,
        path: null,
        duration: 2.0,
        isAnimating: false,
      },
      history: {
        undoStack: [...state.history.undoStack, historyEntry],
        redoStack: [], // Clear redo on new commit
      },
    };
  }),

  // ── NEW: Constraints ──
  addConstraint: (constraint) => set((state) => ({
    constraints: [...state.constraints, constraint],
  })),
  removeConstraint: (id) => set((state) => ({
    constraints: state.constraints.filter(c => c.id !== id),
  })),

  // ── NEW: History (Undo/Redo) ──
  pushHistory: (entry) => set((state) => ({
    history: {
      undoStack: [...state.history.undoStack, entry],
      redoStack: [], // Clear redo on new action
    },
  })),

  undo: () => {
    const state = get();
    const { undoStack, redoStack } = state.history;
    if (undoStack.length === 0) return null;

    const entry = undoStack[undoStack.length - 1];
    const part = state.parts[entry.partUuid];
    if (!part) return null;

    set({
      parts: {
        ...state.parts,
        [entry.partUuid]: {
          ...part,
          position: [...entry.before.position] as [number, number, number],
          rotation: [...entry.before.rotation] as [number, number, number],
        },
      },
      history: {
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, entry],
      },
    });
    return entry;
  },

  redo: () => {
    const state = get();
    const { undoStack, redoStack } = state.history;
    if (redoStack.length === 0) return null;

    const entry = redoStack[redoStack.length - 1];
    const part = state.parts[entry.partUuid];
    if (!part) return null;

    set({
      parts: {
        ...state.parts,
        [entry.partUuid]: {
          ...part,
          position: [...entry.after.position] as [number, number, number],
          rotation: [...entry.after.rotation] as [number, number, number],
        },
      },
      history: {
        undoStack: [...undoStack, entry],
        redoStack: redoStack.slice(0, -1),
      },
    });
    return entry;
  },

  // Sequence Implementation
  addStep: (step) => set((state) => ({ sequence: [...state.sequence, step] })),
  updateStep: (id, stepData) => set((state) => ({
      sequence: state.sequence.map(s => s.id === id ? { ...s, ...stepData } : s)
  })),
  removeStep: (id) => set((state) => ({ sequence: state.sequence.filter(s => s.id !== id) })),
  playSequence: () => set({ isSequencePlaying: true, currentStepIndex: 0 }),
  stopSequence: () => set({ isSequencePlaying: false, currentStepIndex: -1 }),
  nextStep: () => set((state) => {
      const nextIndex = state.currentStepIndex + 1;
      if (nextIndex >= state.sequence.length) {
          return { isSequencePlaying: false, currentStepIndex: -1 }; // Finished
      }
      return { currentStepIndex: nextIndex };
  }),
}));

// Subscribe for Debugging
useAppStore.subscribe((state) => {
    (window as any).__DEBUG_SELECTED_PART__ = state.selectedPartId;
    (window as any).__DEBUG_PICKING_MODE__ = state.pickingMode;
    (window as any).__DEBUG_SEQUENCE_INDEX__ = state.currentStepIndex;
    (window as any).__DEBUG_TRANSFORM_DRAGGING__ = state.isTransformDragging;
    (window as any).__DEBUG_SELECTED_MARKER__ = state.selectedMarkerId;
    (window as any).__DEBUG_WS_STATUS__ = state.wsStatus;
    (window as any).__DEBUG_INTERACTION_MODE__ = state.interactionMode;
    (window as any).__DEBUG_PREVIEW_ACTIVE__ = state.previewState.active;
    (window as any).__DEBUG_UNDO_DEPTH__ = state.history.undoStack.length;
    (window as any).__DEBUG_REDO_DEPTH__ = state.history.redoStack.length;
});

// Convenient handle for Playwright/manual debugging in dev builds.
if (import.meta.env.DEV) {
    (window as any).__APP_STORE__ = useAppStore;

    // Expose geometry & MCP bridge for e2e tests
    import('../utils/geometry').then((mod) => { (window as any).__GEOMETRY__ = mod; });
    import('../services/mcpHandlers').then((mod) => { (window as any).__SCENE_REF__ = mod; });
    import('../services/MCPBridge').then((mod) => { (window as any).__MCP_BRIDGE__ = mod.mcpBridge; });
}
