import * as THREE from 'three';

let activeScene: THREE.Scene | null = null;
let activeCamera: THREE.Camera | null = null;
let activeRenderer: THREE.WebGLRenderer | null = null;
let activeViewportPx: { width: number; height: number } | null = null;
let activeDevicePixelRatio: number | null = null;

export function registerV2Scene(scene: THREE.Scene) {
  activeScene = scene;
}

export function registerV2ThreeContext(params: {
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  viewportPx: { width: number; height: number };
  devicePixelRatio: number;
}) {
  activeScene = params.scene;
  activeCamera = params.camera;
  activeRenderer = params.renderer;
  activeViewportPx = params.viewportPx;
  activeDevicePixelRatio = params.devicePixelRatio;
}

export function getV2Scene() {
  return activeScene;
}

export function getV2Camera() {
  return activeCamera;
}

export function getV2Renderer() {
  return activeRenderer;
}

export function getV2ViewportPx() {
  return activeViewportPx;
}

export function getV2DevicePixelRatio() {
  return activeDevicePixelRatio;
}

export function getV2ObjectByPartId(partId: string) {
  return activeScene?.getObjectByProperty('uuid', partId) ?? null;
}

if (import.meta.env?.DEV && typeof window !== 'undefined') {
  (window as any).__V2_GET_OBJECT__ = getV2ObjectByPartId;
}
