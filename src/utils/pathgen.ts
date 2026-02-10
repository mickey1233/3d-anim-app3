/**
 * Path Generation — Arc / Bezier path for insert/cover/both animations.
 *
 * Produces a sequence of PathKeyframe objects:
 *   { t: 0..1, position: Vec3, quaternion: Quat }
 *
 * Position uses a Quadratic Bezier curve (smooth lift-arc-descend).
 * Rotation uses spherical linear interpolation (SLERP).
 */

import * as THREE from 'three';
import type { Vec3, Quat, PathKeyframe } from '../../shared/types';

// ============================================================
// CORE: Arc path via Quadratic Bezier + SLERP
// ============================================================

/**
 * Generate a smooth arc path between two poses.
 *
 * The arc lifts the object upward (or along a perpendicular direction)
 * at the midpoint, creating a natural "pick up → place down" motion.
 *
 * @param startPos    World-space start position
 * @param startQuat   World-space start rotation
 * @param endPos      World-space end position
 * @param endQuat     World-space end rotation
 * @param arcHeight   Height of the arc apex above the straight line.
 *                    If 0 or omitted, auto-computed as 60% of travel distance.
 * @param steps       Number of keyframes (default 20)
 * @returns           Array of PathKeyframe sorted by t ∈ [0, 1]
 */
export function generateArcPath(
  startPos: THREE.Vector3,
  startQuat: THREE.Quaternion,
  endPos: THREE.Vector3,
  endQuat: THREE.Quaternion,
  arcHeight: number = 0,
  steps: number = 20,
): PathKeyframe[] {
  const distance = startPos.distanceTo(endPos);
  const height = arcHeight > 0 ? arcHeight : distance * 0.6;

  // ── Determine the "up" direction for the arc ──
  // Primary: world Y (gravity-aware).
  // If travel direction is nearly vertical, use the world axis most
  // perpendicular to the travel direction instead.
  const travelDir = new THREE.Vector3().subVectors(endPos, startPos);
  const travelLen = travelDir.length();
  if (travelLen > 1e-6) travelDir.normalize();

  let upDir = new THREE.Vector3(0, 1, 0);
  if (Math.abs(travelDir.dot(upDir)) > 0.95) {
    // Travel is nearly vertical — use world X or Z
    upDir = Math.abs(travelDir.x) < 0.5
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 0, 1);
  }

  // ── Bezier control point ──
  // Midpoint raised along upDir by `height`.
  const midpoint = startPos.clone().lerp(endPos, 0.5);
  const control = midpoint.clone().addScaledVector(upDir, height);

  // ── Generate keyframes ──
  const path: PathKeyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;

    // Quadratic Bezier:  B(t) = (1-t)² P0 + 2(1-t)t P1 + t² P2
    const omt = 1 - t;
    const pos = new THREE.Vector3()
      .addScaledVector(startPos, omt * omt)
      .addScaledVector(control, 2 * omt * t)
      .addScaledVector(endPos, t * t);

    // SLERP rotation
    const quat = new THREE.Quaternion().slerpQuaternions(startQuat, endQuat, t);

    path.push({
      t,
      position: [pos.x, pos.y, pos.z],
      quaternion: [quat.x, quat.y, quat.z, quat.w],
    });
  }

  return path;
}

// ============================================================
// VARIANT: S-curve (ease-in-out) path timing
// ============================================================

/**
 * Same arc shape as `generateArcPath` but applies a smoothstep
 * ease to the parametric t, so the object accelerates and decelerates
 * naturally.
 */
export function generateEasedArcPath(
  startPos: THREE.Vector3,
  startQuat: THREE.Quaternion,
  endPos: THREE.Vector3,
  endQuat: THREE.Quaternion,
  arcHeight: number = 0,
  steps: number = 20,
): PathKeyframe[] {
  const raw = generateArcPath(startPos, startQuat, endPos, endQuat, arcHeight, steps);

  // Re-map t through smoothstep for eased spacing
  return raw.map((kf) => ({
    ...kf,
    t: smoothstep(kf.t),
  }));
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

// ============================================================
// VARIANT: Straight-line path (no arc)
// ============================================================

/**
 * Simple linear interpolation path (for flush mate preview where
 * no arc is needed).
 */
export function generateLinearPath(
  startPos: THREE.Vector3,
  startQuat: THREE.Quaternion,
  endPos: THREE.Vector3,
  endQuat: THREE.Quaternion,
  steps: number = 10,
): PathKeyframe[] {
  const path: PathKeyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const pos = startPos.clone().lerp(endPos, t);
    const quat = new THREE.Quaternion().slerpQuaternions(startQuat, endQuat, t);
    path.push({
      t,
      position: [pos.x, pos.y, pos.z],
      quaternion: [quat.x, quat.y, quat.z, quat.w],
    });
  }
  return path;
}

// ============================================================
// VARIANT: Helical / screw-motion path
// ============================================================

/**
 * Screw motion path — simultaneous rotation + translation along a
 * shared axis.  Useful for threaded fasteners or hinge-like motions.
 *
 * @param center     Pivot point on the screw axis
 * @param axis       Screw axis direction (unit vector)
 * @param radius     Radius of the helix (0 = pure axial translation)
 * @param pitch      Axial advance per full revolution
 * @param totalAngle Total rotation angle in radians
 * @param startPos   Object start position
 * @param startQuat  Object start rotation
 * @param steps      Number of keyframes
 */
export function generateHelicalPath(
  center: THREE.Vector3,
  axis: THREE.Vector3,
  radius: number,
  pitch: number,
  totalAngle: number,
  startPos: THREE.Vector3,
  startQuat: THREE.Quaternion,
  steps: number = 30,
): PathKeyframe[] {
  const axisN = axis.clone().normalize();

  // Build a local frame around the axis
  let radial = new THREE.Vector3(1, 0, 0);
  if (Math.abs(axisN.dot(radial)) > 0.9) {
    radial = new THREE.Vector3(0, 1, 0);
  }
  radial.cross(axisN).normalize();
  const tangential = new THREE.Vector3().crossVectors(axisN, radial).normalize();

  const path: PathKeyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = totalAngle * t;
    const axialOffset = (pitch * angle) / (2 * Math.PI);

    // Position on helix
    const pos = center.clone()
      .addScaledVector(axisN, axialOffset)
      .addScaledVector(radial, radius * Math.cos(angle))
      .addScaledVector(tangential, radius * Math.sin(angle));

    // Rotation: accumulate around screw axis
    const qIncrement = new THREE.Quaternion().setFromAxisAngle(axisN, angle);
    const quat = qIncrement.clone().multiply(startQuat);

    path.push({
      t,
      position: [pos.x, pos.y, pos.z],
      quaternion: [quat.x, quat.y, quat.z, quat.w],
    });
  }

  return path;
}
