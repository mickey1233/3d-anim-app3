import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import * as THREE from 'three';

export interface ImageItem {
  id: string;
  url: string;
  name: string;
  // Keyframe Data: Part UUID -> Target Position [x,y,z]
  partPositions: Record<string, [number, number, number]>; 
}

export interface PartData {
  uuid: string;
  name: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  color: string;
}

interface AppState {
  cadUrl: string | null;
  cadFileName: string | null;
  selectedImageId: string | null;
  images: ImageItem[];
  parts: Record<string, PartData>; // Keyed by UUID
  selectedPartId: string | null;
  isAnimationPlaying: boolean;

  setCadUrl: (url: string, fileName: string) => void;
  addImage: (file: File) => void;
  reorderImages: (newOrder: ImageItem[]) => void;
  updateKeyframePosition: (imageId: string, partId: string, position: [number, number, number]) => void;
  registerPart: (part: PartData) => void;
  updatePart: (uuid: string, data: Partial<PartData>) => void;
  selectPart: (uuid: string | null) => void;
  selectImage: (id: string | null) => void;
  setAnimationPlaying: (playing: boolean) => void;
}

const COLORS = ['#ef4444', '#22c55e', '#3b82f6', '#eab308', '#ec4899', '#8b5cf6', '#f97316'];

export const useAppStore = create<AppState>((set) => ({
  cadUrl: null,
  cadFileName: null,
  selectedImageId: null,
  images: [],
  parts: {},
  selectedPartId: null,
  isAnimationPlaying: false,

  setCadUrl: (url, fileName) => set({ cadUrl: url, cadFileName: fileName }),

  addImage: (file) => {
    const url = URL.createObjectURL(file);
    set((state) => ({
      images: [
        ...state.images,
        {
          id: uuidv4(),
          url,
          name: file.name,
          partPositions: {} // Will be populated by "AI" logic
        }
      ]
    }));
  },

  reorderImages: (newOrder) => set({ images: newOrder }),

  updateKeyframePosition: (imageId, partId, position) => set((state) => ({
    images: state.images.map(img => 
      img.id === imageId ? { 
        ...img, 
        partPositions: {
          ...img.partPositions,
          [partId]: position
        }
      } : img
    )
  })),

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
  selectImage: (id) => set({ selectedImageId: id }),
  setAnimationPlaying: (playing) => set({ isAnimationPlaying: playing }),
}));
