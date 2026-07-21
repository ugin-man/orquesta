import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Group } from 'three';
import type { SetupVisualState } from '../setup-visual-types';
import {
  GEAR_LAYOUT,
  getScenePhaseState,
  isPhaseEmphasized,
  type GearLayoutItem,
  type Vec3Tuple,
} from './sceneLayout';
import { createGearGeometry } from './geometry';
import { EdgeOutlinedMesh } from './EdgeOutlinedMesh';
import { getPhaseVisual, SCENE_COLORS } from './materials';
import { OutlinedBox, OutlinedCylinder, OutlinedRod } from './ScenePrimitives';

interface Gear3DProps {
  item: GearLayoutItem;
  state: SetupVisualState;
  rearDepth?: number;
}

function Gear3D({ item, state, rearDepth = 1.25 }: Gear3DProps) {
  const rotorRef = useRef<Group>(null);
  const phaseState = useMemo(() => getScenePhaseState(state), [state]);
  const visual = getPhaseVisual(phaseState, item.phaseId);
  const geometry = useMemo(
    () => createGearGeometry(item.radius, item.thickness, item.teeth),
    [item.radius, item.teeth, item.thickness],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame((_, delta) => {
    if (!rotorRef.current || state.reducedMotion || !visual.running) return;
    rotorRef.current.rotation.z += delta * item.speed * (item.clockwise ? -1 : 1);
  });

  const spokes = item.teeth >= 22 ? 8 : 6;
  const axlePosition: Vec3Tuple = [item.position[0], item.position[1], item.position[2] - rearDepth * 0.52];

  return (
    <group>
      <OutlinedCylinder
        radius={item.radius * 0.115}
        height={rearDepth}
        position={axlePosition}
        rotation={[Math.PI / 2, 0, 0]}
        fillColor={SCENE_COLORS.rearGraySoft}
        edgeColor={SCENE_COLORS.rearGray}
        opacity={0.09}
        edgeOpacity={0.5}
        radialSegments={16}
      />
      <OutlinedBox
        size={[item.radius * 0.86, item.radius * 0.25, 0.3]}
        position={[item.position[0], item.position[1] - item.radius - 0.24, item.position[2] - rearDepth]}
        fillColor={SCENE_COLORS.rearGraySoft}
        edgeColor={SCENE_COLORS.rearGray}
        opacity={0.06}
        edgeOpacity={0.44}
      />

      <group ref={rotorRef} position={item.position}>
        <EdgeOutlinedMesh
          geometry={geometry}
          fillColor={visual.fill}
          edgeColor={visual.edge}
          opacity={visual.opacity}
          edgeOpacity={visual.running ? 0.96 : 0.5}
          edgeThreshold={7}
        />
        <OutlinedCylinder
          radius={item.radius * 0.9}
          height={item.thickness * 0.24}
          position={[0, 0, 0]}
          rotation={[Math.PI / 2, 0, 0]}
          fillColor={visual.fill}
          edgeColor={visual.edge}
          opacity={visual.opacity * 0.72}
          edgeOpacity={visual.running ? 0.7 : 0.34}
          radialSegments={28}
        />
        {Array.from({ length: spokes }, (_, index) => {
          const angle = (Math.PI * 2 * index) / spokes;
          return (
            <group key={index} rotation={[0, 0, angle]}>
              <OutlinedBox
                size={[item.radius * 0.58, item.radius * 0.105, item.thickness * 1.08]}
                position={[item.radius * 0.31, 0, 0]}
                fillColor={visual.fill}
                edgeColor={visual.edge}
                opacity={visual.opacity * 0.8}
                edgeOpacity={visual.running ? 0.8 : 0.4}
              />
              <OutlinedCylinder
                radius={item.radius * 0.05}
                height={item.thickness * 1.08}
                position={[item.radius * 0.56, 0, 0]}
                rotation={[Math.PI / 2, 0, 0]}
                fillColor={visual.fill}
                edgeColor={visual.edge}
                opacity={visual.opacity * 0.65}
                edgeOpacity={visual.running ? 0.74 : 0.34}
                radialSegments={12}
              />
            </group>
          );
        })}
        <OutlinedCylinder
          radius={item.radius * 0.24}
          height={item.thickness * 1.3}
          position={[0, 0, 0]}
          rotation={[Math.PI / 2, 0, 0]}
          fillColor={visual.running ? SCENE_COLORS.graphiteSoft : SCENE_COLORS.rearGraySoft}
          edgeColor={visual.edge}
          opacity={visual.running ? 0.22 : 0.09}
          edgeOpacity={visual.running ? 0.92 : 0.48}
          radialSegments={22}
        />
        <OutlinedCylinder
          radius={item.radius * 0.115}
          height={item.thickness * 1.44}
          position={[0, 0, 0.02]}
          rotation={[Math.PI / 2, 0, 0]}
          fillColor={SCENE_COLORS.paperBright}
          edgeColor={visual.edge}
          opacity={0.16}
          edgeOpacity={visual.running ? 0.78 : 0.38}
          radialSegments={18}
        />
        {isPhaseEmphasized(phaseState, item.phaseId) && (
          <mesh position={[item.radius * 0.58, 0, item.thickness * 0.7]}>
            <sphereGeometry args={[0.065, 12, 8]} />
            <meshBasicMaterial color={SCENE_COLORS.mint} />
          </mesh>
        )}
      </group>
    </group>
  );
}

const LOWER_GEAR_LAYOUT: GearLayoutItem[] = [
  { id: 'lower-a', phaseId: 2, position: [-0.75, -4.18, 0.7], radius: 0.42, thickness: 0.28, teeth: 15, clockwise: true, speed: 1.4 },
  { id: 'lower-b', phaseId: 2, position: [0.12, -4.08, 0.7], radius: 0.58, thickness: 0.32, teeth: 18, clockwise: false, speed: 1.0 },
  { id: 'lower-c', phaseId: 2, position: [1.15, -4.02, 0.7], radius: 0.46, thickness: 0.3, teeth: 16, clockwise: true, speed: 1.22 },
  { id: 'lower-d', phaseId: 2, position: [2.18, -3.86, 0.7], radius: 0.72, thickness: 0.34, teeth: 22, clockwise: false, speed: 0.82 },
  { id: 'lower-e', phaseId: 2, position: [3.1, -3.98, 0.7], radius: 0.42, thickness: 0.28, teeth: 15, clockwise: true, speed: 1.34 },
  { id: 'lower-f', phaseId: 2, position: [3.86, -3.58, 0.7], radius: 0.54, thickness: 0.3, teeth: 18, clockwise: false, speed: 1.08 },
];

function InputMotor({ state }: { state: SetupVisualState }) {
  const phaseState = useMemo(() => getScenePhaseState(state), [state]);
  const running = getPhaseVisual(phaseState, 1).running;
  const rotor = useRef<Group>(null);
  const position: Vec3Tuple = [4.18, 6.4, 0.82];

  useFrame((_, delta) => {
    if (!rotor.current || state.reducedMotion || !running) return;
    rotor.current.rotation.z -= delta * 0.68;
  });

  return (
    <group position={position}>
      <OutlinedCylinder
        radius={0.34}
        height={0.44}
        position={[0, 0, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        fillColor={running ? SCENE_COLORS.graphiteSoft : SCENE_COLORS.rearGraySoft}
        edgeColor={running ? SCENE_COLORS.graphite : SCENE_COLORS.rearGray}
        opacity={running ? 0.18 : 0.08}
        edgeOpacity={running ? 0.9 : 0.45}
        radialSegments={28}
      />
      <group ref={rotor} position={[0, 0, 0.26]}>
        {Array.from({ length: 8 }, (_, index) => {
          const angle = (Math.PI * 2 * index) / 8;
          return (
            <OutlinedBox
              key={index}
              size={[0.34, 0.065, 0.085]}
              position={[Math.cos(angle) * 0.26, Math.sin(angle) * 0.26, 0]}
              rotation={[0, 0, angle]}
              fillColor={SCENE_COLORS.graphiteSoft}
              edgeColor={running ? SCENE_COLORS.graphite : SCENE_COLORS.rearGray}
              opacity={0.14}
              edgeOpacity={running ? 0.88 : 0.42}
            />
          );
        })}
      </group>
      <OutlinedRod
        start={[0, -0.55, 0]}
        end={[-0.03, -1.05, 0]}
        radius={0.08}
        fillColor={SCENE_COLORS.graphiteSoft}
        edgeColor={running ? SCENE_COLORS.graphite : SCENE_COLORS.rearGray}
        opacity={running ? 0.16 : 0.06}
        edgeOpacity={running ? 0.88 : 0.42}
      />
    </group>
  );
}

export function GearTrain3D({ state }: { state: SetupVisualState }) {
  const phaseState = useMemo(() => getScenePhaseState(state), [state]);
  const phaseTwoVisual = getPhaseVisual(phaseState, 2);
  const outputGear = GEAR_LAYOUT[GEAR_LAYOUT.length - 1]!;

  return (
    <group>
      <group>
        <OutlinedBox
          size={[0.28, 8.6, 0.34]}
          position={[3.5, 2.0, -0.82]}
          fillColor={SCENE_COLORS.rearGraySoft}
          edgeColor={SCENE_COLORS.rearGray}
          opacity={0.05}
          edgeOpacity={0.36}
        />
        <OutlinedBox
          size={[0.28, 9.1, 0.34]}
          position={[4.75, 2.15, -0.82]}
          fillColor={SCENE_COLORS.rearGraySoft}
          edgeColor={SCENE_COLORS.rearGray}
          opacity={0.05}
          edgeOpacity={0.36}
        />
        {[5.0, 3.35, 1.72, 0.1, -1.35].map((y) => (
          <OutlinedBox
            key={y}
            size={[1.62, 0.13, 0.2]}
            position={[4.13, y, -0.86]}
            fillColor={SCENE_COLORS.rearGraySoft}
            edgeColor={SCENE_COLORS.rearGray}
            opacity={0.04}
            edgeOpacity={0.28}
          />
        ))}
      </group>

      <InputMotor state={state} />
      {GEAR_LAYOUT.map((item) => (
        <Gear3D key={item.id} item={item} state={state} rearDepth={1.55} />
      ))}

      <OutlinedRod
        start={[outputGear.position[0] - 0.15, outputGear.position[1], 0.65]}
        end={[3.05, -3.55, 0.7]}
        radius={0.05}
        fillColor={phaseTwoVisual.emphasized ? SCENE_COLORS.mint : SCENE_COLORS.rearGraySoft}
        edgeColor={phaseTwoVisual.emphasized ? SCENE_COLORS.mintDark : SCENE_COLORS.rearGray}
        opacity={phaseTwoVisual.emphasized ? 0.22 : 0.06}
        edgeOpacity={phaseTwoVisual.emphasized ? 0.62 : 0.3}
      />

      {LOWER_GEAR_LAYOUT.map((item) => (
        <Gear3D key={item.id} item={item} state={state} rearDepth={1.1} />
      ))}

      <OutlinedRod
        start={[-1.2, -4.2, 0.62]}
        end={[4.35, -3.62, 0.62]}
        radius={0.065}
        fillColor={SCENE_COLORS.rearGraySoft}
        edgeColor={SCENE_COLORS.rearGray}
        opacity={0.05}
        edgeOpacity={0.3}
      />
      <OutlinedRod
        start={[-1.2, -4.56, -0.42]}
        end={[4.35, -4.0, -0.42]}
        radius={0.055}
        fillColor={SCENE_COLORS.rearGraySoft}
        edgeColor={SCENE_COLORS.rearGray}
        opacity={0.04}
        edgeOpacity={0.26}
      />
    </group>
  );
}
