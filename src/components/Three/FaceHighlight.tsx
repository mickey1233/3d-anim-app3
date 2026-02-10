/**
 * FaceHighlight — renders colored planes at selected face positions.
 *
 * Uses the selectedFaces array from the store. First face (source) is green,
 * second face (target) is blue. Each face shows a semi-transparent plane
 * oriented to the face normal plus a small arrow helper indicating direction.
 */

import React, { useMemo } from 'react';
import * as THREE from 'three';
import { useAppStore } from '../../store/useAppStore';

const COLORS = [0x22c55e, 0x3b82f6]; // green (source), blue (target)
const PLANE_SIZE = 0.3;
const ARROW_LENGTH = 0.25;

export const FaceHighlight: React.FC = () => {
  const selectedFaces = useAppStore((s) => s.selectedFaces);
  const interactionMode = useAppStore((s) => s.interactionMode);

  // Only show in mate mode
  if (interactionMode !== 'mate' || selectedFaces.length === 0) return null;

  return (
    <group>
      {selectedFaces.map((sf, idx) => (
        <FacePlane
          key={`${sf.partUuid}-${sf.face}-${idx}`}
          origin={sf.frame.origin}
          normal={sf.frame.normal}
          tangent={sf.frame.tangent}
          bitangent={sf.frame.bitangent}
          color={COLORS[idx] ?? COLORS[1]}
        />
      ))}
    </group>
  );
};

interface FacePlaneProps {
  origin: [number, number, number];
  normal: [number, number, number];
  tangent: [number, number, number];
  bitangent: [number, number, number];
  color: number;
}

const FacePlane: React.FC<FacePlaneProps> = ({ origin, normal, tangent, bitangent, color }) => {
  const { quaternion, arrowDir } = useMemo(() => {
    // Build rotation matrix from face frame axes
    const t = new THREE.Vector3(tangent[0], tangent[1], tangent[2]);
    const b = new THREE.Vector3(bitangent[0], bitangent[1], bitangent[2]);
    const n = new THREE.Vector3(normal[0], normal[1], normal[2]);

    // Construct rotation: plane's default normal is +Z, we rotate to face normal
    const mat = new THREE.Matrix4().makeBasis(t, b, n);
    const q = new THREE.Quaternion().setFromRotationMatrix(mat);

    return {
      quaternion: q,
      arrowDir: n,
    };
  }, [normal, tangent, bitangent]);

  return (
    <group position={origin}>
      {/* Semi-transparent face plane */}
      <mesh quaternion={quaternion}>
        <planeGeometry args={[PLANE_SIZE, PLANE_SIZE]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.4}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/* Wireframe border */}
      <mesh quaternion={quaternion}>
        <planeGeometry args={[PLANE_SIZE, PLANE_SIZE]} />
        <meshBasicMaterial
          color={color}
          wireframe
          transparent
          opacity={0.8}
        />
      </mesh>

      {/* Normal direction arrow */}
      <arrowHelper
        args={[
          arrowDir,
          new THREE.Vector3(0, 0, 0),
          ARROW_LENGTH,
          color,
          ARROW_LENGTH * 0.3,
          ARROW_LENGTH * 0.15,
        ]}
      />
    </group>
  );
};
