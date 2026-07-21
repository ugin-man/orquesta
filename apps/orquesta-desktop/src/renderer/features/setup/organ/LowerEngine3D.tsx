import { useMemo } from 'react';
import type { SetupVisualState } from '../setup-visual-types';
import { getScenePhaseState, isPhaseRunning } from './sceneLayout';
import { getPhaseVisual, SCENE_COLORS } from './materials';
import { OutlinedBox, OutlinedCylinder, OutlinedRod } from './ScenePrimitives';

const lowerXs = [-3.95, -3.15, -2.35, -1.55, -0.75, 0, 0.75, 1.55, 2.35, 3.15, 3.95];
const upperXs = [-3.45, -2.3, -1.15, 0, 1.15, 2.3, 3.45];

export function LowerEngine3D({ state }: { state: SetupVisualState }) {
  const phaseState = useMemo(() => getScenePhaseState(state), [state]);
  const mechanics = getPhaseVisual(phaseState, 3);
  const airflow = getPhaseVisual(phaseState, 5);
  const pressurized = isPhaseRunning(phaseState, 5);

  return (
    <group position={[0, 1.0, 1.05]} scale={[1.12, 1.24, 1]}>
      <OutlinedBox
        size={[10.4, 0.28, 1.85]}
        position={[0, -5.18, -0.08]}
        fillColor={SCENE_COLORS.rearGraySoft}
        edgeColor={SCENE_COLORS.graphiteSoft}
        opacity={0.075}
        edgeOpacity={0.5}
      />
      <OutlinedBox
        size={[9.85, 0.2, 1.55]}
        position={[0, -4.78, -0.02]}
        fillColor={SCENE_COLORS.paperBright}
        edgeColor={SCENE_COLORS.graphiteSoft}
        opacity={0.12}
        edgeOpacity={0.54}
      />

      {[-4.58, -3.98, -3.38, -2.78].map((y, index) => (
        <OutlinedRod
          key={y}
          start={[-4.55, y, 0.15 + index * 0.06]}
          end={[4.55, y, 0.15 + index * 0.06]}
          radius={index === 1 || index === 2 ? 0.105 : 0.075}
          fillColor={index === 2 && pressurized ? SCENE_COLORS.mint : mechanics.fill}
          edgeColor={index === 2 && pressurized ? SCENE_COLORS.mintDark : mechanics.edge}
          opacity={index === 2 && pressurized ? 0.3 : 0.12}
          edgeOpacity={index === 2 && pressurized ? 0.74 : 0.5}
        />
      ))}

      {lowerXs.map((x, index) => (
        <group key={`lower-${x}`} position={[x, -4.02 + (index % 2) * 0.09, 0.42]}>
          <OutlinedCylinder
            radius={0.14 + (index % 3) * 0.025}
            height={0.78 + (index % 2) * 0.16}
            position={[0, 0.25, 0]}
            fillColor={mechanics.fill}
            edgeColor={mechanics.edge}
            opacity={0.18}
            edgeOpacity={mechanics.running ? 0.72 : 0.38}
            radialSegments={14}
          />
          <OutlinedCylinder
            radius={0.085}
            height={0.3}
            position={[0, 0.84, 0]}
            fillColor={SCENE_COLORS.paperBright}
            edgeColor={mechanics.edge}
            opacity={0.16}
            edgeOpacity={mechanics.running ? 0.58 : 0.3}
            radialSegments={12}
          />
          <OutlinedBox
            size={[0.42, 0.11, 0.42]}
            position={[0, -0.23, 0]}
            fillColor={SCENE_COLORS.rearGraySoft}
            edgeColor={SCENE_COLORS.graphiteSoft}
            opacity={0.1}
            edgeOpacity={0.42}
          />
          {pressurized && index % 2 === 0 && (
            <mesh position={[0, 0.98, 0.16]}>
              <sphereGeometry args={[0.043, 10, 8]} />
              <meshBasicMaterial color={SCENE_COLORS.mint} transparent opacity={0.82} />
            </mesh>
          )}
        </group>
      ))}

      {upperXs.map((x, index) => (
        <group key={`upper-${x}`} position={[x, -2.95 + (index % 2) * 0.11, 0.28]}>
          <OutlinedBox
            size={[0.78, 0.86 + (index % 3) * 0.12, 0.82]}
            position={[0, 0, 0]}
            fillColor={index % 2 === 0 ? mechanics.fill : airflow.fill}
            edgeColor={index % 2 === 0 ? mechanics.edge : airflow.edge}
            opacity={0.16}
            edgeOpacity={mechanics.running ? 0.62 : 0.34}
          />
          <OutlinedCylinder
            radius={0.16}
            height={0.76}
            position={[0, 0.7, 0.18]}
            fillColor={SCENE_COLORS.paperBright}
            edgeColor={SCENE_COLORS.graphiteSoft}
            opacity={0.12}
            edgeOpacity={0.42}
            radialSegments={14}
          />
        </group>
      ))}

      <OutlinedCylinder
        radius={0.76}
        height={0.54}
        position={[0, -2.52, 0.18]}
        fillColor={mechanics.fill}
        edgeColor={mechanics.edge}
        opacity={0.2}
        edgeOpacity={mechanics.running ? 0.74 : 0.38}
        radialSegments={24}
      />
      <OutlinedCylinder
        radius={0.34}
        height={1.2}
        position={[0, -1.98, 0.24]}
        fillColor={pressurized ? SCENE_COLORS.mint : SCENE_COLORS.graphiteSoft}
        edgeColor={pressurized ? SCENE_COLORS.mintDark : SCENE_COLORS.graphite}
        opacity={pressurized ? 0.26 : 0.12}
        edgeOpacity={pressurized ? 0.68 : 0.44}
        radialSegments={18}
      />

      {[-4.2, -3.15, -2.1, -1.05, 1.05, 2.1, 3.15, 4.2].map((x, index) => (
        <group key={`distribution-${x}`} position={[x, -1.88 + (index % 2) * 0.12, 0.38]}>
          <OutlinedCylinder
            radius={0.12}
            height={0.86}
            position={[0, 0, 0]}
            fillColor={index % 3 === 0 && pressurized ? SCENE_COLORS.mint : airflow.fill}
            edgeColor={index % 3 === 0 && pressurized ? SCENE_COLORS.mintDark : airflow.edge}
            opacity={index % 3 === 0 && pressurized ? 0.24 : 0.15}
            edgeOpacity={pressurized ? 0.58 : 0.34}
            radialSegments={14}
          />
          <OutlinedRod
            start={[-0.26, 0.32, 0]}
            end={[0.26, 0.32, 0]}
            radius={0.045}
            fillColor={mechanics.fill}
            edgeColor={mechanics.edge}
            opacity={0.15}
            edgeOpacity={mechanics.running ? 0.54 : 0.3}
          />
        </group>
      ))}

      {[-3.9, -2.6, -1.3, 0, 1.3, 2.6, 3.9].map((x, index) => (
        <group key={`regulator-${x}`} position={[x, -1.12 + (index % 2) * 0.08, 0.5]}>
          <OutlinedCylinder
            radius={0.18}
            height={0.54}
            position={[0, 0, 0]}
            fillColor={index % 2 === 0 && pressurized ? SCENE_COLORS.mint : airflow.fill}
            edgeColor={index % 2 === 0 && pressurized ? SCENE_COLORS.mintDark : airflow.edge}
            opacity={index % 2 === 0 && pressurized ? 0.24 : 0.15}
            edgeOpacity={pressurized ? 0.56 : 0.32}
            radialSegments={16}
          />
          <OutlinedRod
            start={[-0.28, 0, 0]}
            end={[0.28, 0, 0]}
            radius={0.045}
            fillColor={mechanics.fill}
            edgeColor={mechanics.edge}
            opacity={0.14}
            edgeOpacity={mechanics.running ? 0.5 : 0.28}
          />
        </group>
      ))}

      {[-4.25, -2.85, -1.42, 0, 1.42, 2.85, 4.25].map((x, index) => (
        <OutlinedRod
          key={`brace-${x}`}
          start={[x, -5.08, -0.7]}
          end={[x + (index % 2 === 0 ? 0.3 : -0.3), -1.48, -0.7]}
          radius={0.045}
          fillColor={SCENE_COLORS.rearGraySoft}
          edgeColor={SCENE_COLORS.rearGray}
          opacity={0.05}
          edgeOpacity={0.28}
        />
      ))}
    </group>
  );
}
