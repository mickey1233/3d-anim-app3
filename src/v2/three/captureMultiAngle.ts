import * as THREE from 'three';
import { getV2Camera, getV2Renderer, getV2Scene, getV2ViewportPx } from './SceneRegistry';
import { computeCaptureSize, dataUrlFromPixels } from './captureUtils';

export type AnglePreset = {
  label: string;
  /** World-space camera position. Will be scaled to frame the scene. */
  cameraDir: [number, number, number];
};

export type AngleCaptureResult = {
  angle: string;
  dataUrl: string;
  widthPx: number;
  heightPx: number;
};

export const DEFAULT_ANGLES: AnglePreset[] = [
  { label: 'front',  cameraDir: [0,  0,  1] },
  { label: 'back',   cameraDir: [0,  0, -1] },
  { label: 'left',   cameraDir: [-1, 0,  0] },
  { label: 'right',  cameraDir: [1,  0,  0] },
  { label: 'top',    cameraDir: [0,  1,  0] },
  { label: 'iso',    cameraDir: [1,  1,  1] },
];

export type CaptureMultiAnglesOptions = {
  maxWidthPx?: number;
  maxHeightPx?: number;
  angles?: AnglePreset[];
};

/**
 * Captures the scene from multiple preset angles.
 * Camera position is automatically scaled to frame the scene bounding box.
 * The user's camera view is fully restored after capture.
 */
export async function captureMultiAngles(
  options?: CaptureMultiAnglesOptions
): Promise<AngleCaptureResult[]> {
  const renderer = getV2Renderer();
  const scene = getV2Scene();
  const camera = getV2Camera();
  const viewportPx = getV2ViewportPx();

  if (!renderer || !scene || !camera || !viewportPx) {
    throw new Error('Three.js context not ready for multi-angle capture');
  }

  const maxWidthPx = options?.maxWidthPx ?? 512;
  const maxHeightPx = options?.maxHeightPx ?? 384;
  const angles = options?.angles ?? DEFAULT_ANGLES;

  const size = computeCaptureSize({
    viewportWidth: viewportPx.width,
    viewportHeight: viewportPx.height,
    maxWidthPx,
    maxHeightPx,
  });

  // Compute scene bounding box to determine camera distance and lookat target.
  const box = new THREE.Box3();
  scene.traverseVisible((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      box.expandByObject(obj);
    }
  });
  const sceneCenter = box.isEmpty()
    ? new THREE.Vector3(0, 0, 0)
    : box.getCenter(new THREE.Vector3());
  const sceneRadius = box.isEmpty()
    ? 3
    : box.getBoundingSphere(new THREE.Sphere()).radius;
  // Camera distance: far enough to see whole scene with some padding.
  const camDistance = Math.max(sceneRadius * 2.5, 1);

  // Save camera state.
  const savedPos = camera.position.clone();
  const savedQuat = camera.quaternion.clone();
  const savedAspect = (camera as any).isPerspectiveCamera
    ? (camera as THREE.PerspectiveCamera).aspect
    : null;

  const prevTarget = renderer.getRenderTarget();
  const renderTarget = new THREE.WebGLRenderTarget(size.width, size.height, {
    depthBuffer: true,
    stencilBuffer: false,
  });
  const pixels = new Uint8Array(size.width * size.height * 4);

  const results: AngleCaptureResult[] = [];

  try {
    for (const preset of angles) {
      // Position camera along direction vector at computed distance.
      const dir = new THREE.Vector3(...preset.cameraDir).normalize();
      camera.position.copy(sceneCenter).addScaledVector(dir, camDistance);
      camera.lookAt(sceneCenter);

      if ((camera as any).isPerspectiveCamera) {
        const pcam = camera as THREE.PerspectiveCamera;
        pcam.aspect = size.width / Math.max(1, size.height);
        pcam.updateProjectionMatrix();
      }

      renderer.setRenderTarget(renderTarget);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(renderTarget, 0, 0, size.width, size.height, pixels);

      const dataUrl = dataUrlFromPixels({
        pixels: pixels.slice(), // copy — buffer reused next iteration
        width: size.width,
        height: size.height,
        mimeType: 'image/png',
      });

      results.push({ angle: preset.label, dataUrl, widthPx: size.width, heightPx: size.height });
    }
  } finally {
    // Always restore camera and renderer state.
    renderer.setRenderTarget(prevTarget);
    camera.position.copy(savedPos);
    camera.quaternion.copy(savedQuat);
    if (savedAspect !== null && (camera as any).isPerspectiveCamera) {
      (camera as THREE.PerspectiveCamera).aspect = savedAspect;
      (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
    }
    renderTarget.dispose();
  }

  return results;
}
