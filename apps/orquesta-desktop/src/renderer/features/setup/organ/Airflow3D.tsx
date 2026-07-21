import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Mesh } from 'three';
import type { SetupVisualState } from '../setup-visual-types';
import { getScenePhaseState, type Vec3Tuple } from './sceneLayout';
import { getPhaseVisual, SCENE_COLORS } from './materials';
import { OutlinedTube } from './ScenePrimitives';

interface FlowParticleProps {
  points: Vec3Tuple[];
  state: SetupVisualState;
  delay: number;
  speed?: number;
  size?: number;
}

function FlowParticle({ points, state, delay, speed = 0.18, size = 0.06 }: FlowParticleProps) {
  const ref = useRef<Mesh>(null);
  const phaseState = useMemo(() => getScenePhaseState(state), [state]);
  const visual = getPhaseVisual(phaseState, 5);
  const curve = useMemo(
    () => new THREE.CatmullRomCurve3(
      points.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
      false,
      'catmullrom',
      0.06,
    ),
    [points],
  );

  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.visible = visual.running;
    if (!visual.running) return;
    const t = state.reducedMotion ? 0.42 : (clock.elapsedTime * speed + delay) % 1;
    ref.current.position.copy(curve.getPointAt(t));
  });

  return (
    <mesh ref={ref} visible={visual.running}>
      <sphereGeometry args={[size, 12, 8]} />
      <meshBasicMaterial color={SCENE_COLORS.mint} transparent opacity={0.82} />
    </mesh>
  );
}

function FlowChannel({
  points,
  state,
  markerCount = 2,
  radius = 0.1,
  speed = 0.18,
}: {
  points: Vec3Tuple[];
  state: SetupVisualState;
  markerCount?: number;
  radius?: number;
  speed?: number;
}) {
  const phaseState = useMemo(() => getScenePhaseState(state), [state]);
  const visual = getPhaseVisual(phaseState, 5);

  return (
    <group>
      <OutlinedTube
        points={points}
        radius={radius}
        radialSegments={10}
        tubularSegments={Math.max(16, points.length * 14)}
        fillColor={SCENE_COLORS.rearGraySoft}
        edgeColor={visual.running ? SCENE_COLORS.graphiteSoft : SCENE_COLORS.rearGray}
        opacity={visual.running ? 0.055 : 0.028}
        edgeOpacity={visual.running ? 0.54 : 0.3}
      />
      {visual.emphasized && (
        <OutlinedTube
          points={points}
          radius={radius * 0.24}
          radialSegments={7}
          tubularSegments={Math.max(16, points.length * 14)}
          fillColor={SCENE_COLORS.mint}
          edgeColor={SCENE_COLORS.mintDark}
          opacity={0.44}
          edgeOpacity={0.72}
        />
      )}
      {Array.from({ length: markerCount }, (_, index) => (
        <FlowParticle
          key={index}
          points={points}
          state={state}
          delay={index / markerCount}
          speed={speed}
          size={radius * 0.52}
        />
      ))}
    </group>
  );
}

const branchXs = [-4.75, -3.55, -2.35, -1.15, 1.15, 2.35, 3.55, 4.75];

export function Airflow3D({ state }: { state: SetupVisualState }) {
  const intake: Vec3Tuple[] = [
    [-5.0, -4.25, 0.08],
    [-4.15, -4.25, 0.08],
    [-3.35, -3.4, 0.08],
    [-2.2, -2.55, 0.12],
    [0, -2.2, 0.18],
  ];
  const manifold: Vec3Tuple[] = [
    [-5.0, -2.05, 0.1],
    [-2.5, -2.05, 0.1],
    [0, -2.05, 0.1],
    [2.5, -2.05, 0.1],
    [5.0, -2.05, 0.1],
  ];
  const spineRise: Vec3Tuple[] = [
    [0, -2.2, 0.4],
    [0, 0.2, 0.42],
    [0, 2.8, 0.42],
    [0, 5.8, 0.4],
  ];
  const gearFeed: Vec3Tuple[] = [
    [0.25, 4.9, 0.38],
    [1.8, 4.9, 0.48],
    [3.3, 4.9, 0.58],
    [5.28, 4.82, 0.7],
    [5.3, 1.6, 0.7],
    [4.62, -1.2, 0.68],
  ];

  return (
    <group>
      <FlowChannel points={intake} state={state} markerCount={3} radius={0.115} speed={0.15} />
      <FlowChannel points={manifold} state={state} markerCount={4} radius={0.105} speed={0.13} />
      <FlowChannel points={spineRise} state={state} markerCount={4} radius={0.09} speed={0.2} />
      <FlowChannel points={gearFeed} state={state} markerCount={3} radius={0.075} speed={0.18} />
      {branchXs.map((x, index) => (
        <FlowChannel
          key={x}
          points={[
            [x, -2.05, 0.1],
            [x, -1.48, 0.1],
            [x * 0.98, -1.15 + (index % 2) * 0.08, 0.35],
          ]}
          state={state}
          markerCount={1}
          radius={0.07}
          speed={0.28}
        />
      ))}
    </group>
  );
}
