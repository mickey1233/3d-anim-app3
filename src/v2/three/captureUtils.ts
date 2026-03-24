/**
 * Shared low-level utilities for WebGL render-target capture.
 * Used by both view.capture_image (mcpToolExecutor) and captureMultiAngle.
 */

export function computeCaptureSize(params: {
  viewportWidth: number;
  viewportHeight: number;
  maxWidthPx: number;
  maxHeightPx: number;
}): { width: number; height: number } {
  const { viewportWidth, viewportHeight, maxWidthPx, maxHeightPx } = params;
  const safeW = Math.max(1, viewportWidth);
  const safeH = Math.max(1, viewportHeight);
  const scale = Math.min(maxWidthPx / safeW, maxHeightPx / safeH, 1);
  return {
    width: clampInt(safeW * scale, 64, 2048),
    height: clampInt(safeH * scale, 64, 2048),
  };
}

export function dataUrlFromPixels(params: {
  pixels: Uint8Array;
  width: number;
  height: number;
  mimeType: string;
  jpegQuality?: number;
}): string {
  const { pixels, width, height, mimeType, jpegQuality } = params;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas not available');

  const imageData = ctx.createImageData(width, height);
  const rowStride = width * 4;
  // Flip Y: WebGL readPixels origin is bottom-left.
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * rowStride;
    const dstRow = y * rowStride;
    imageData.data.set(pixels.subarray(srcRow, srcRow + rowStride), dstRow);
  }
  ctx.putImageData(imageData, 0, 0);

  if (mimeType === 'image/jpeg') {
    return canvas.toDataURL(mimeType, jpegQuality ?? 0.92);
  }
  return canvas.toDataURL(mimeType);
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}
