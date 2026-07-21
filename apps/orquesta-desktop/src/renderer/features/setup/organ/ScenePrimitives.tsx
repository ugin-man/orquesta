import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Vec3Tuple } from './sceneLayout';
import { EdgeOutlinedMesh } from './EdgeOutlinedMesh';
import { distance, midpoint, quaternionFromYTo } from './geometry';

interface CommonVisualProps {
  fillColor: THREE.ColorRepresentation;
  edgeColor: THREE.ColorRepresentation;
  opacity?: number;
  edgeOpacity?: number;
}

interface OutlinedBoxProps extends CommonVisualProps {
  size: Vec3Tuple;
  position: Vec3Tuple;
  rotation?: Vec3Tuple;
}

export function OutlinedBox({
  size,
  position,
  rotation = [0, 0, 0],
  fillColor,
  edgeColor,
  opacity,
  edgeOpacity,
}: OutlinedBoxProps) {
  const geometry = useMemo(
    () => new THREE.BoxGeometry(size[0], size[1], size[2]),
    [size[0], size[1], size[2]],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <group position={position} rotation={rotation}>
      <EdgeOutlinedMesh
        geometry={geometry}
        fillColor={fillColor}
        edgeColor={edgeColor}
        opacity={opacity}
        edgeOpacity={edgeOpacity}
      />
    </group>
  );
}

interface OutlinedCylinderProps extends CommonVisualProps {
  radius: number;
  height: number;
  position: Vec3Tuple;
  rotation?: Vec3Tuple;
  radialSegments?: number;
  openEnded?: boolean;
}

export function OutlinedCylinder({
  radius,
  height,
  position,
  rotation = [0, 0, 0],
  radialSegments = 18,
  openEnded = false,
  fillColor,
  edgeColor,
  opacity,
  edgeOpacity,
}: OutlinedCylinderProps) {
  const geometry = useMemo(
    () => new THREE.CylinderGeometry(
      radius,
      radius,
      height,
      radialSegments,
      1,
      openEnded,
    ),
    [height, openEnded, radialSegments, radius],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <group position={position} rotation={rotation}>
      <EdgeOutlinedMesh
        geometry={geometry}
        fillColor={fillColor}
        edgeColor={edgeColor}
        opacity={opacity}
        edgeOpacity={edgeOpacity}
      />
    </group>
  );
}

interface OutlinedRodProps extends CommonVisualProps {
  start: Vec3Tuple;
  end: Vec3Tuple;
  radius: number;
  radialSegments?: number;
}

export function OutlinedRod({
  start,
  end,
  radius,
  radialSegments = 12,
  fillColor,
  edgeColor,
  opacity,
  edgeOpacity,
}: OutlinedRodProps) {
  const length = distance(start, end);
  const position = midpoint(start, end);
  const quaternion = useMemo(() => quaternionFromYTo(start, end), [
    start[0], start[1], start[2], end[0], end[1], end[2],
  ]);
  const geometry = useMemo(
    () => new THREE.CylinderGeometry(radius, radius, length, radialSegments),
    [length, radialSegments, radius],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <group position={position} quaternion={quaternion}>
      <EdgeOutlinedMesh
        geometry={geometry}
        fillColor={fillColor}
        edgeColor={edgeColor}
        opacity={opacity}
        edgeOpacity={edgeOpacity}
      />
    </group>
  );
}

interface OutlinedTubeProps extends CommonVisualProps {
  points: Vec3Tuple[];
  radius: number;
  radialSegments?: number;
  tubularSegments?: number;
}

export function OutlinedTube({
  points,
  radius,
  radialSegments = 8,
  tubularSegments = 48,
  fillColor,
  edgeColor,
  opacity,
  edgeOpacity,
}: OutlinedTubeProps) {
  const curve = useMemo(
    () => new THREE.CatmullRomCurve3(
      points.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
      false,
      'catmullrom',
      0.12,
    ),
    [points],
  );
  const geometry = useMemo(
    () => new THREE.TubeGeometry(
      curve,
      tubularSegments,
      radius,
      radialSegments,
      false,
    ),
    [curve, radialSegments, radius, tubularSegments],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <EdgeOutlinedMesh
      geometry={geometry}
      fillColor={fillColor}
      edgeColor={edgeColor}
      opacity={opacity}
      edgeOpacity={edgeOpacity}
      edgeThreshold={20}
    />
  );
}
