import { useMemo } from 'react';
import type { SetupVisualState } from '../setup-visual-types';
import { getScenePhaseState, isPhaseRunning, SPINE_LAYOUT } from './sceneLayout';
import { SCENE_COLORS } from './materials';
import { OutlinedBox, OutlinedCylinder, OutlinedRod, OutlinedTube } from './ScenePrimitives';

const ringYs = [-2.45, -1.35, -0.2, 1.05, 2.35, 3.65, 4.9, 6.05];

export function MechanicalSpine3D({ state }: { state: SetupVisualState }) {
  const phaseState = useMemo(() => getScenePhaseState(state), [state]);
  const powered = isPhaseRunning(phaseState, 2);
  const pressurized = isPhaseRunning(phaseState, 5);
  const [x, y, z] = SPINE_LAYOUT.position;

  return (
    <group position={[x, y, z]}>
      <OutlinedCylinder
        radius={SPINE_LAYOUT.coreRadius * 1.52}
        height={SPINE_LAYOUT.height}
        position={[0, 0, -0.46]}
        fillColor={SCENE_COLORS.rearGraySoft}
        edgeColor={SCENE_COLORS.rearGray}
        opacity={0.045}
        edgeOpacity={0.32}
        radialSegments={24}
        openEnded
      />
      <OutlinedCylinder
        radius={SPINE_LAYOUT.coreRadius}
        height={SPINE_LAYOUT.height * 0.97}
        position={[0, -0.04, 0.02]}
        fillColor={SCENE_COLORS.graphiteSoft}
        edgeColor={SCENE_COLORS.graphite}
        opacity={0.095}
        edgeOpacity={0.62}
        radialSegments={22}
      />
      <OutlinedCylinder
        radius={0.075}
        height={SPINE_LAYOUT.height * 0.93}
        position={[0, -0.08, 0.38]}
        fillColor={pressurized ? SCENE_COLORS.mint : SCENE_COLORS.rearGraySoft}
        edgeColor={pressurized ? SCENE_COLORS.mintDark : SCENE_COLORS.rearGray}
        opacity={pressurized ? 0.48 : 0.06}
        edgeOpacity={pressurized ? 0.86 : 0.28}
        radialSegments={12}
      />

      {ringYs.map((ringY, index) => (
        <group key={ringY} position={[0, ringY, 0]}>
          <OutlinedCylinder
            radius={index % 3 === 0 ? 0.62 : 0.52}
            height={0.18}
            position={[0, 0, 0]}
            fillColor={SCENE_COLORS.paperBright}
            edgeColor={powered ? SCENE_COLORS.graphite : SCENE_COLORS.rearGray}
            opacity={0.12}
            edgeOpacity={powered ? 0.64 : 0.34}
            radialSegments={20}
          />
          <OutlinedBox
            size={[SPINE_LAYOUT.shellWidth, 0.12, 0.34]}
            position={[0, 0, -0.26]}
            fillColor={SCENE_COLORS.paperBright}
            edgeColor={SCENE_COLORS.rearGray}
            opacity={0.055}
            edgeOpacity={0.28}
          />
        </group>
      ))}

      <OutlinedTube
        points={[
          [-0.3, -5.35, 0.32],
          [-0.3, -3.5, 0.42],
          [-0.18, -1.2, 0.44],
          [0.06, 1.1, 0.46],
          [0.02, 3.65, 0.44],
          [0, 5.25, 0.4],
        ]}
        radius={0.055}
        fillColor={pressurized ? SCENE_COLORS.mint : SCENE_COLORS.rearGraySoft}
        edgeColor={pressurized ? SCENE_COLORS.mintDark : SCENE_COLORS.rearGray}
        opacity={pressurized ? 0.36 : 0.035}
        edgeOpacity={pressurized ? 0.78 : 0.24}
        radialSegments={8}
        tubularSegments={56}
      />

      {[-3.15, -1.55, 0.15, 1.8, 3.35].map((branchY, index) => {
        const side = index % 2 === 0 ? -1 : 1;
        return (
          <OutlinedRod
            key={branchY}
            start={[0.02, branchY, -0.2]}
            end={[side * (1.2 + index * 0.16), branchY + 0.38, -0.48]}
            radius={0.05}
            fillColor={SCENE_COLORS.rearGraySoft}
            edgeColor={SCENE_COLORS.rearGray}
            opacity={0.045}
            edgeOpacity={0.3}
          />
        );
      })}

      <OutlinedCylinder
        radius={0.78}
        height={0.34}
        position={[0, -5.55, -0.04]}
        fillColor={SCENE_COLORS.graphiteSoft}
        edgeColor={SCENE_COLORS.graphite}
        opacity={0.11}
        edgeOpacity={0.64}
        radialSegments={24}
      />
      <OutlinedCylinder
        radius={0.58}
        height={0.46}
        position={[0, 5.7, -0.02]}
        fillColor={SCENE_COLORS.paperBright}
        edgeColor={SCENE_COLORS.rearGray}
        opacity={0.1}
        edgeOpacity={0.5}
        radialSegments={20}
      />
    </group>
  );
}
