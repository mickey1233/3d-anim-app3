import { create } from 'zustand';
import * as THREE from 'three';

export interface PartData {
  uuid: string;
  name: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  color: string;
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
}

interface AppState {
  cadUrl: string | null;
  cadFileName: string | null;
  
  parts: Record<string, PartData>; // Keyed by UUID
  selectedPartId: string | null;
  
  // Animation State
  isAnimationPlaying: boolean;
  pickingMode: 'idle' | 'start' | 'end';
  
  startMarker: MarkerData | null;
  endMarker: MarkerData | null;
  
  movingPartId: string | null; // The object that will move
  animationDuration: number; // Seconds
  animationEasing: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

  // Scene Control
  resetTrigger: number;

  // Sequence State
  sequence: AnimationStep[];
  isSequencePlaying: boolean;
  currentStepIndex: number;

  // Global Calibration / Transforms
  cameraTransform: {
    position: [number, number, number];
    rotation: [number, number, number]; // Degrees
  };
  objectTransform: {
    position: [number, number, number];
    rotation: [number, number, number]; // Degrees
  };

  // Actions
  setCadUrl: (url: string, fileName: string) => void;
  registerPart: (part: PartData) => void;
  updatePart: (uuid: string, data: Partial<PartData>) => void;
  selectPart: (uuid: string | null) => void;
  
  setAnimationPlaying: (playing: boolean) => void;
  setPickingMode: (mode: 'idle' | 'start' | 'end') => void;
  
  setStartMarker: (position: [number, number, number] | null) => void;
  setEndMarker: (position: [number, number, number] | null) => void;
  
  setMovingPartId: (uuid: string | null) => void;
  setAnimationConfig: (duration: number, easing: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut') => void;
  triggerReset: () => void;

  setCameraTransform: (position: [number, number, number], rotation: [number, number, number]) => void;
  setObjectTransform: (position: [number, number, number], rotation: [number, number, number]) => void;

  // Sequence Actions
  addStep: (step: AnimationStep) => void;
  removeStep: (id: string) => void;
  playSequence: () => void;
  stopSequence: () => void;
  nextStep: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  cadUrl: null,
  cadFileName: null,
  parts: {},
  selectedPartId: null,

  isAnimationPlaying: false,
  pickingMode: 'idle',
  startMarker: null,
  endMarker: null,
  movingPartId: null,
  animationDuration: 2.0,
  animationEasing: 'easeInOut',
  resetTrigger: 0,

  // Sequence Defaults
  sequence: [],
  isSequencePlaying: false,
  currentStepIndex: -1,

  cameraTransform: { position: [0,0,0], rotation: [0,0,0] },
  objectTransform: { position: [0,0,0], rotation: [0,0,0] },

  setCadUrl: (url, fileName) => set({ cadUrl: url, cadFileName: fileName }),

  registerPart: (part) => set((state) => ({
    parts: { ...state.parts, [part.uuid]: part }
  })),

  updatePart: (uuid, data) => set((state) => ({
    parts: {
      ...state.parts,
      [uuid]: { ...state.parts[uuid], ...data }
    }
  })),

  selectPart: (uuid) => set({ selectedPartId: uuid }),
  
  setAnimationPlaying: (playing) => set({ isAnimationPlaying: playing }),
  setPickingMode: (mode) => set({ pickingMode: mode }),
  
  setStartMarker: (position) => set({ startMarker: position ? { position } : null }),
  setEndMarker: (position) => set({ endMarker: position ? { position } : null }),
  
  setMovingPartId: (uuid) => set({ movingPartId: uuid }),
  setAnimationConfig: (duration, easing) => set({ animationDuration: duration, animationEasing: easing }),
  triggerReset: () => set((state) => ({ resetTrigger: state.resetTrigger + 1, isAnimationPlaying: false, isSequencePlaying: false, currentStepIndex: -1 })),

  setCameraTransform: (position, rotation) => set({ cameraTransform: { position, rotation } }),
  setObjectTransform: (position, rotation) => set({ objectTransform: { position, rotation } }),

  // Sequence Implementation
  addStep: (step) => set((state) => ({ sequence: [...state.sequence, step] })),
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
});
