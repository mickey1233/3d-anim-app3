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

  setCameraTransform: (position: [number, number, number], rotation: [number, number, number]) => void;
  setObjectTransform: (position: [number, number, number], rotation: [number, number, number]) => void;
}

export const useAppStore = create<AppState>((set) => ({
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

  setCameraTransform: (position, rotation) => set({ cameraTransform: { position, rotation } }),
  setObjectTransform: (position, rotation) => set({ objectTransform: { position, rotation } }),
}));

// Subscribe for Debugging
useAppStore.subscribe((state) => {
    (window as any).__DEBUG_SELECTED_PART__ = state.selectedPartId;
    (window as any).__DEBUG_PICKING_MODE__ = state.pickingMode;
});
