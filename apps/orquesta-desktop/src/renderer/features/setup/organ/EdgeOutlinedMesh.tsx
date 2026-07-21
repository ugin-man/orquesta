import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import * as THREE from 'three';
import type { ThreeElements } from '@react-three/fiber';

interface EdgeOutlinedMeshProps {
  geometry: THREE.BufferGeometry;
  fillColor: THREE.ColorRepresentation;
  edgeColor: THREE.ColorRepresentation;
  opacity?: number;
  edgeOpacity?: number;
  edgeThreshold?: number;
  material?: 'standard' | 'basic';
  meshProps?: Omit<ThreeElements['mesh'], 'geometry' | 'children'>;
  lineProps?: Omit<ThreeElements['lineSegments'], 'geometry' | 'children'>;
  children?: ReactNode;
}

export function EdgeOutlinedMesh({
  geometry,
  fillColor,
  edgeColor,
  opacity = 0.12,
  edgeOpacity = 0.88,
  edgeThreshold = 14,
  material = 'standard',
  meshProps,
  lineProps,
  children,
}: EdgeOutlinedMeshProps) {
  const edges = useMemo(
    () => new THREE.EdgesGeometry(geometry, edgeThreshold),
    [edgeThreshold, geometry],
  );

  useEffect(() => () => edges.dispose(), [edges]);

  return (
    <group>
      <mesh geometry={geometry} {...meshProps}>
        {material === 'standard' ? (
          <meshStandardMaterial
            color={fillColor}
            transparent={opacity < 1}
            opacity={opacity}
            depthWrite={opacity >= 0.28}
            roughness={0.98}
            metalness={0.02}
            polygonOffset
            polygonOffsetFactor={1}
            polygonOffsetUnits={1}
          />
        ) : (
          <meshBasicMaterial
            color={fillColor}
            transparent={opacity < 1}
            opacity={opacity}
            depthWrite={opacity >= 0.28}
            polygonOffset
            polygonOffsetFactor={1}
            polygonOffsetUnits={1}
          />
        )}
        {children}
      </mesh>
      <lineSegments geometry={edges} {...lineProps}>
        <lineBasicMaterial
          color={edgeColor}
          transparent={edgeOpacity < 1}
          opacity={edgeOpacity}
          depthWrite={false}
        />
      </lineSegments>
    </group>
  );
}
