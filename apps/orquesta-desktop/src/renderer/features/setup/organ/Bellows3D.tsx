import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import type { SetupVisualState } from '../setup-visual-types';
import { getScenePhaseState } from './sceneLayout';
import { getPhaseVisual, SCENE_COLORS } from './materials';
import { OutlinedBox, OutlinedCylinder, OutlinedRod } from './ScenePrimitives';

function BellowsStack({ x, phaseOffset, state }: { x: number; phaseOffset: number; state: SetupVisualState }) {
  const moving = useRef<Group>(null);
  const phaseState = useMemo(() => getScenePhaseState(state), [state]);
  const visual = getPhaseVisual(phaseState, 3);

  useFrame(({ clock }) => {
    if (!moving.current) return;
    if (state.reducedMotion || !visual.running) {
      moving.current.scale.y += (1 - moving.current.scale.y) * 0.14;
      return;
    }
    const target = 0.87 + (Math.sin(clock.elapsedTime * 1.72 + phaseOffset) * 0.5 + 0.5) * 0.24;
    moving.current.scale.y += (target - moving.current.scale.y) * 0.14;
  });

  return (
    <group position={[x, -4.0, 1.05]} scale={[1, 1.16, 1]}>
      <OutlinedBox
        size={[2.1, 0.18, 1.62]}
        position={[0, 0, 0]}
        fillColor={visual.fill}
        edgeColor={visual.edge}
        opacity={visual.opacity * 0.9}
        edgeOpacity={visual.running ? 0.82 : 0.38}
      />
      <group ref={moving} position={[0, 0.08, 0]}>
        {[0.24, 0.48, 0.72, 0.96, 1.2, 1.44, 1.68].map((y, index) => (
          <OutlinedBox
            key={y}
            size={[index % 2 === 0 ? 1.96 : 1.74, 0.09, index % 2 === 0 ? 1.48 : 1.28]}
            position={[0, y, 0]}
            fillColor={visual.fill}
            edgeColor={visual.edge}
            opacity={visual.opacity * 0.72}
            edgeOpacity={visual.running ? 0.66 : 0.3}
          />
        ))}
        <OutlinedBox
          size={[2.22, 0.18, 1.7]}
          position={[0, 1.92, 0]}
          fillColor={visual.fill}
          edgeColor={visual.edge}
          opacity={visual.opacity}
          edgeOpacity={visual.running ? 0.84 : 0.4}
        />
      </group>
      <OutlinedCylinder
        radius={0.14}
        height={0.64}
        position={[x < 0 ? 1.26 : -1.26, 0.25, 0]}
        rotation={[0, 0, Math.PI / 2]}
        fillColor={visual.fill}
        edgeColor={visual.edge}
        opacity={visual.opacity}
        edgeOpacity={visual.running ? 0.78 : 0.36}
        radialSegments={14}
      />
    </group>
  );
}

function Reservoir({ x, state }: { x: number; state: SetupVisualState }) {
  const phaseState = useMemo(() => getScenePhaseState(state), [state]);
  const visual = getPhaseVisual(phaseState, 4);
  return (
    <group>
      <OutlinedBox
        size={[2.15, 1.3, 1.42]}
        position={[x, -2.9, 0.82]}
        fillColor={visual.fill}
        edgeColor={visual.edge}
        opacity={visual.opacity * 0.74}
        edgeOpacity={visual.running ? 0.7 : 0.34}
      />
      <OutlinedCylinder
        radius={0.28}
        height={1.0}
        position={[x, -2.28, 1.2]}
        fillColor={visual.fill}
        edgeColor={visual.edge}
        opacity={visual.opacity * 0.75}
        edgeOpacity={visual.running ? 0.68 : 0.32}
        radialSegments={18}
      />
      {visual.emphasized && (
        <mesh position={[x, -1.8, 1.36]}>
          <sphereGeometry args={[0.055, 12, 8]} />
          <meshBasicMaterial color={SCENE_COLORS.mint} transparent opacity={0.82} />
        </mesh>
      )}
    </group>
  );
}

export function Bellows3D({ state }: { state: SetupVisualState }) {
  return (
    <group>
      <BellowsStack x={-5.65} phaseOffset={0} state={state} />
      <BellowsStack x={5.65} phaseOffset={Math.PI * 0.72} state={state} />
      <Reservoir x={-3.75} state={state} />
      <Reservoir x={3.75} state={state} />
      <OutlinedRod
        start={[-6.65, -4.65, -0.55]}
        end={[6.65, -4.65, -0.55]}
        radius={0.095}
        fillColor={SCENE_COLORS.rearGraySoft}
        edgeColor={SCENE_COLORS.rearGray}
        opacity={0.045}
        edgeOpacity={0.32}
      />
    </group>
  );
}
