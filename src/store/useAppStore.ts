import { create } from 'zustand';
import * as THREE from 'three';

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
}

// Store Interface
interface AppState {
  cadUrl: string | null;
  cadFileName: string | null;
  
  parts: Record<string, PartData>; 
  selectedPartId: string | null;
  
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

  // Sequence State
  sequence: AnimationStep[];
  isSequencePlaying: boolean;
  currentStepIndex: number;

  // Global Calibration / Transforms
  cameraTransform: {
    position: [number, number, number];
    rotation: [number, number, number]; 
  };
  objectTransform: {
    position: [number, number, number];
    rotation: [number, number, number]; 
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

  setCameraTransform: (position: [number, number, number], rotation: [number, number, number]) => void;
  setObjectTransform: (position: [number, number, number], rotation: [number, number, number]) => void;

  // Sequence Actions
  addStep: (step: AnimationStep) => void;
  updateStep: (id: string, data: Partial<AnimationStep>) => void;
  removeStep: (id: string) => void;
  playSequence: () => void;
  stopSequence: () => void;
  nextStep: () => void;
}

// Store Implementation
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

  sequence: [],
  isSequencePlaying: false,
  currentStepIndex: -1,

  cameraTransform: { position: [0,0,0], rotation: [0,0,0] },
  objectTransform: { position: [0,0,0], rotation: [0,0,0] },

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

  updatePart: (uuid, data) => set((state) => ({
    parts: {
      ...state.parts,
      [uuid]: { ...state.parts[uuid], ...data }
    }
  })),

  resetPart: (uuid) => set((state) => {
      const part = state.parts[uuid];
      if (!part) return {}; // No change if part not found
      
      // If no initial state, do nothing or keep current?
      // We ensured initial state is set in registerPart.
      // If standard "position" was updated, "initialPosition" remains.
      
      return {
          parts: {
              ...state.parts,
              [uuid]: {
                  ...part,
                  // Restore Position
                  position: part.initialPosition ? [...part.initialPosition] : part.position,
                  // Restore Rotation
                  rotation: part.initialRotation ? [...part.initialRotation] : part.rotation,
                  // Restore Scale
                  scale: part.initialScale ? [...part.initialScale] : part.scale
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
              scale: part.initialScale ? [...part.initialScale] : part.scale
          };
      });
      return { 
          parts: newParts,
          isAnimationPlaying: false,
          isSequencePlaying: false,
          currentStepIndex: -1,
          movingPartId: null,
          startMarker: null,
          endMarker: null
      };
  }),

  selectPart: (uuid) => set({ selectedPartId: uuid, movingPartId: uuid }),
  
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
});
