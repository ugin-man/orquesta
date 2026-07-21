import * as THREE from 'three';
import type { Vec3Tuple } from './sceneLayout';

export const createGearGeometry = (
  radius: number,
  thickness: number,
  teeth: number,
): THREE.ExtrudeGeometry => {
  const shape = new THREE.Shape();
  const root = radius * 0.82;
  const tip = radius;
  const steps = teeth * 4;

  for (let index = 0; index <= steps; index += 1) {
    const angle = (Math.PI * 2 * index) / steps;
    const useTip = index % 4 === 1 || index % 4 === 2;
    const currentRadius = useTip ? tip : root;
    const x = Math.cos(angle) * currentRadius;
    const y = Math.sin(angle) * currentRadius;
    if (index === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();

  const hubRadius = radius * 0.16;
  shape.holes.push(new THREE.Path().absarc(0, 0, hubRadius, 0, Math.PI * 2, true));

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelSize: Math.max(radius * 0.035, 0.018),
    bevelThickness: Math.max(thickness * 0.08, 0.018),
    bevelSegments: 2,
    curveSegments: 6,
    steps: 1,
  });
  geometry.translate(0, 0, -thickness / 2);
  geometry.computeVertexNormals();
  return geometry;
};

export const createCylinderGeometry = (
  radius: number,
  height: number,
  radialSegments = 18,
  openEnded = false,
): THREE.CylinderGeometry =>
  new THREE.CylinderGeometry(
    radius,
    radius,
    height,
    radialSegments,
    1,
    openEnded,
  );

export const createTaperedCylinderGeometry = (
  topRadius: number,
  bottomRadius: number,
  height: number,
  radialSegments = 16,
): THREE.CylinderGeometry =>
  new THREE.CylinderGeometry(
    topRadius,
    bottomRadius,
    height,
    radialSegments,
    1,
    false,
  );

export const createLathedProfileGeometry = (
  profile: Array<[number, number]>,
  radialSegments = 28,
): THREE.LatheGeometry => {
  const points = profile.map(([radius, y]) => new THREE.Vector2(Math.max(radius, 0.001), y));
  const geometry = new THREE.LatheGeometry(points, radialSegments);
  geometry.computeVertexNormals();
  return geometry;
};

export const createOrganPipeBodyGeometry = (
  radius: number,
  height: number,
): THREE.LatheGeometry => {
  const topY = height / 2;
  const bottomY = -height / 2;
  const collarY = bottomY + height * 0.09;
  const shoulderY = bottomY + height * 0.16;
  const lipY = bottomY + height * 0.24;
  const upperLipY = bottomY + height * 0.28;
  const rimInset = radius * 0.92;
  const flareRadius = radius * 1.03;
  return createLathedProfileGeometry(
    [
      [radius * 0.94, bottomY],
      [radius * 0.94, collarY],
      [radius, shoulderY],
      [radius, lipY],
      [rimInset, upperLipY],
      [radius, upperLipY + height * 0.015],
      [radius, topY - height * 0.035],
      [flareRadius, topY - height * 0.012],
      [flareRadius, topY],
    ],
    18,
  );
};

export const createOrganPipeFootGeometry = (
  baseRadius: number,
  height: number,
): THREE.LatheGeometry => {
  const topY = height / 2;
  const bottomY = -height / 2;
  return createLathedProfileGeometry(
    [
      [baseRadius * 0.22, bottomY],
      [baseRadius * 0.28, bottomY + height * 0.14],
      [baseRadius * 0.34, bottomY + height * 0.28],
      [baseRadius * 0.46, bottomY + height * 0.5],
      [baseRadius * 0.64, bottomY + height * 0.8],
      [baseRadius * 0.72, topY],
    ],
    16,
  );
};

export const midpoint = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [
  (a[0] + b[0]) / 2,
  (a[1] + b[1]) / 2,
  (a[2] + b[2]) / 2,
];

export const distance = (a: Vec3Tuple, b: Vec3Tuple): number =>
  Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

export const quaternionFromYTo = (a: Vec3Tuple, b: Vec3Tuple): THREE.Quaternion => {
  const direction = new THREE.Vector3(
    b[0] - a[0],
    b[1] - a[1],
    b[2] - a[2],
  ).normalize();
  return new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction,
  );
};
