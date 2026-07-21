import { useMemo } from 'react';
import * as THREE from 'three';
import { SCENE_COLORS } from './materials';

const makeShape = (points: Array<[number, number]>) => {
  const shape = new THREE.Shape();
  points.forEach(([x, y], index) => {
    if (index === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  });
  shape.closePath();
  return shape;
};

export function BackdropPanels3D() {
  const left = useMemo(
    () => makeShape([
      [-5.15, -1.35],
      [-5.15, 3.55],
      [-4.35, 5.05],
      [-3.3, 4.35],
      [-2.65, -1.35],
    ]),
    [],
  );
  const center = useMemo(
    () => makeShape([
      [-2.45, -1.35],
      [-2.45, 4.75],
      [-1.35, 6.65],
      [0, 7.75],
      [1.35, 6.65],
      [2.45, 4.75],
      [2.45, -1.35],
    ]),
    [],
  );
  const right = useMemo(
    () => makeShape([
      [2.65, -1.35],
      [3.3, 4.35],
      [4.35, 5.05],
      [5.15, 3.55],
      [5.15, -1.35],
    ]),
    [],
  );

  return (
    <group position={[0, 0.1, -0.78]}>
      {[left, center, right].map((shape, index) => (
        <mesh key={index} renderOrder={-2}>
          <shapeGeometry args={[shape]} />
          <meshBasicMaterial
            color={SCENE_COLORS.graphiteSoft}
            transparent
            opacity={index === 1 ? 0.24 : 0.18}
            depthWrite
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}
