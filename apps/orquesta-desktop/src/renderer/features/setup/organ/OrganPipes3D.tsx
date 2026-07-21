import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Group } from 'three';
import type { SetupVisualState } from '../setup-visual-types';
import {
  PIPE_HEIGHT_SCALE,
  PIPE_RANKS,
  SOUNDING_VOICE_INDICES,
  getScenePhaseState,
  isPhaseEmphasized,
  isPhaseRunning,
  type PipeRankLayout,
} from './sceneLayout';
import { createOrganPipeBodyGeometry, createOrganPipeFootGeometry } from './geometry';
import { EdgeOutlinedMesh } from './EdgeOutlinedMesh';
import { getPhaseVisual, SCENE_COLORS } from './materials';
import { OutlinedBox, OutlinedCylinder } from './ScenePrimitives';

interface Pipe3DProps {
  rank: PipeRankLayout;
  heightRaw: number;
  index: number;
  state: SetupVisualState;
}

function Pipe3D({ rank, heightRaw, index, state }: Pipe3DProps) {
  const phaseState = useMemo(() => getScenePhaseState(state), [state]);
  const visual = getPhaseVisual(phaseState, 6);
  const sounding = isPhaseRunning(phaseState, 6) && SOUNDING_VOICE_INDICES[rank.id].includes(index);
  const emphasized = isPhaseEmphasized(phaseState, 6);
  const resonator = useRef<Group>(null);

  const totalHeight = heightRaw * PIPE_HEIGHT_SCALE;
  const footHeight = 0.88;
  const bodyHeight = Math.max(1.52, totalHeight - footHeight);
  const x = rank.positions[index] ?? rank.startX + rank.spacing * index;
  const baseY = rank.baseY;
  const mouthY = baseY + footHeight;
  const centerIndex = Math.floor((rank.heights.length - 1) / 2);
  const isTower = index <= 2 || index >= rank.heights.length - 3 || Math.abs(index - centerIndex) <= 1;
  const radius = (0.075 + heightRaw / 3000) * rank.radiusScale * (isTower ? 1.06 : 0.98);
  const rankOpacity = rank.id === 'front' ? 1 : rank.id === 'middle' ? 0.38 : 0.15;
  const pipeFill = visual.running ? SCENE_COLORS.metalLight : SCENE_COLORS.rearGraySoft;
  const pipeOpacity = visual.running ? 0.32 * rankOpacity : 0.035 * rankOpacity;

  const bodyGeometry = useMemo(() => createOrganPipeBodyGeometry(radius, bodyHeight), [bodyHeight, radius]);
  const footGeometry = useMemo(() => createOrganPipeFootGeometry(radius, footHeight), [footHeight, radius]);

  useEffect(
    () => () => {
      bodyGeometry.dispose();
      footGeometry.dispose();
    },
    [bodyGeometry, footGeometry],
  );

  useFrame(({ clock }) => {
    if (!resonator.current) return;
    if (state.reducedMotion || !sounding) {
      resonator.current.scale.y += (1 - resonator.current.scale.y) * 0.18;
      return;
    }
    const phase = clock.elapsedTime * 2.3 + index * 0.28 + rank.z * 0.7;
    const target = 1.03 + (Math.sin(phase) * 0.5 + 0.5) * 0.14;
    resonator.current.scale.y += (target - resonator.current.scale.y) * 0.16;
  });

  return (
    <group position={[x, 0, rank.z]}>
      <group position={[0, baseY + footHeight / 2, 0]}>
        <EdgeOutlinedMesh
          geometry={footGeometry}
          fillColor={pipeFill}
          edgeColor={visual.edge}
          opacity={pipeOpacity * 0.86}
          edgeOpacity={visual.running ? (rank.id === 'front' ? 0.64 : rank.id === 'middle' ? 0.24 : 0.09) : 0.2}
          edgeThreshold={17}
        />
      </group>

      <group position={[0, baseY + footHeight * 0.14, radius * 0.48]}>
        <OutlinedBox
          size={[radius * 0.7, footHeight * 0.24, radius * 0.16]}
          position={[0, 0, 0]}
          fillColor={SCENE_COLORS.graphiteSoft}
          edgeColor={visual.running ? SCENE_COLORS.graphite : SCENE_COLORS.rearGray}
          opacity={visual.running ? 0.22 : 0.08}
          edgeOpacity={visual.running ? 0.86 : 0.38}
        />
      </group>

      <group ref={resonator} position={[0, mouthY, 0]}>
        <group position={[0, bodyHeight / 2, 0]}>
          <EdgeOutlinedMesh
            geometry={bodyGeometry}
            fillColor={pipeFill}
            edgeColor={visual.edge}
            opacity={pipeOpacity}
            edgeOpacity={
              visual.running
                ? rank.id === 'front'
                  ? 0.62
                  : rank.id === 'middle'
                    ? 0.46
                    : 0.32
                : rank.id === 'front'
                  ? 0.52
                  : 0.3
            }
            edgeThreshold={17}
          />
        </group>

        <OutlinedCylinder
          radius={radius * 1.03}
          height={0.048}
          position={[0, bodyHeight - 0.02, 0]}
          fillColor={SCENE_COLORS.paperBright}
          edgeColor={visual.edge}
          opacity={0.18 * rankOpacity}
          edgeOpacity={visual.running ? 0.64 : 0.32}
          radialSegments={18}
        />

        {sounding && emphasized && (
          <mesh position={[0, bodyHeight * 0.56, 0]}>
            <cylinderGeometry args={[0.024, 0.024, bodyHeight * 0.9, 10]} />
            <meshBasicMaterial color={SCENE_COLORS.mint} transparent opacity={0.74} />
          </mesh>
        )}
      </group>

      <OutlinedBox
        size={[radius * 1.2, 0.16, 0.075]}
        position={[0, mouthY + bodyHeight * 0.105, radius + 0.028]}
        fillColor={SCENE_COLORS.graphite}
        edgeColor={visual.running ? SCENE_COLORS.graphite : SCENE_COLORS.rearGray}
        opacity={visual.running ? 0.32 : 0.11}
        edgeOpacity={visual.running ? 0.92 : 0.48}
      />
      <OutlinedBox
        size={[radius * 0.76, 0.065, 0.055]}
        position={[0, mouthY + bodyHeight * 0.06, radius + 0.068]}
        fillColor={SCENE_COLORS.paperBright}
        edgeColor={visual.edge}
        opacity={0.14}
        edgeOpacity={visual.running ? 0.64 : 0.28}
      />
      <OutlinedCylinder
        radius={radius * 0.58}
        height={0.084}
        position={[0, baseY - 0.02, 0]}
        fillColor={SCENE_COLORS.paperBright}
        edgeColor={visual.edge}
        opacity={0.22}
        edgeOpacity={visual.running ? 0.78 : 0.42}
        radialSegments={16}
      />
    </group>
  );
}

function VoiceParticles({
  x,
  topY,
  z,
  index,
  state,
}: {
  x: number;
  topY: number;
  z: number;
  index: number;
  state: SetupVisualState;
}) {
  const refs = useRef<Array<THREE.Mesh | null>>([]);
  const phaseState = useMemo(() => getScenePhaseState(state), [state]);
  const visible = isPhaseRunning(phaseState, 6) && isPhaseEmphasized(phaseState, 6);

  useFrame(({ clock }) => {
    refs.current.forEach((sphere, particleIndex) => {
      if (!sphere) return;
      sphere.visible = visible;
      if (!visible || state.reducedMotion) {
        sphere.position.y = topY + 0.25 + particleIndex * 0.4;
        return;
      }
      const cycle = (clock.elapsedTime * 0.48 + index * 0.11 + particleIndex * 0.29) % 1;
      sphere.position.y = topY + 0.2 + cycle * 1.95;
      sphere.scale.setScalar(0.68 + Math.sin(cycle * Math.PI) * 0.5);
    });
  });

  return (
    <group>
      {[0, 1, 2].map((particleIndex) => (
        <mesh
          key={particleIndex}
          ref={(element) => {
            refs.current[particleIndex] = element;
          }}
          position={[x, topY + 0.25 + particleIndex * 0.38, z]}
        >
          <sphereGeometry args={[0.048 - particleIndex * 0.008, 10, 8]} />
          <meshBasicMaterial color={SCENE_COLORS.mint} transparent opacity={0.76} />
        </mesh>
      ))}
    </group>
  );
}

function WindChest3D({ state }: { state: SetupVisualState }) {
  const phaseState = useMemo(() => getScenePhaseState(state), [state]);
  const visual = getPhaseVisual(phaseState, 5);
  const chests = [
    { id: 'left', x: -4.7, width: 3.25 },
    { id: 'center', x: 0, width: 5.0 },
    { id: 'right', x: 5.25, width: 2.65 },
  ];
  return (
    <group>
      {chests.map((chest) => (
        <group key={chest.id} position={[chest.x, -1.04, 0]}>
          <OutlinedBox
            size={[chest.width, 0.48, 2.2]}
            position={[0, 0, 0]}
            fillColor={visual.fill}
            edgeColor={visual.edge}
            opacity={visual.opacity * 0.58}
            edgeOpacity={visual.running ? 0.58 : 0.28}
          />
          <OutlinedBox
            size={[chest.width * 0.9, 0.12, 1.82]}
            position={[0, 0.3, 0]}
            fillColor={SCENE_COLORS.paperBright}
            edgeColor={visual.edge}
            opacity={0.08}
            edgeOpacity={visual.running ? 0.38 : 0.18}
          />
        </group>
      ))}
      <OutlinedBox
        size={[12.2, 0.14, 0.34]}
        position={[0, -1.44, -0.82]}
        fillColor={SCENE_COLORS.rearGraySoft}
        edgeColor={SCENE_COLORS.rearGray}
        opacity={0.035}
        edgeOpacity={0.22}
      />
    </group>
  );
}

function PipeApron({ state }: { state: SetupVisualState }) {
  const phaseState = useMemo(() => getScenePhaseState(state), [state]);
  const visual = getPhaseVisual(phaseState, 5);
  return (
    <group>
      {[{x: -4.7, w: 3.1}, {x: 0, w: 4.8}, {x: 5.25, w: 2.55}].map((section) => (
        <OutlinedBox
          key={section.x}
          size={[section.w, 0.24, 0.32]}
          position={[section.x, -0.62, 1.12]}
          fillColor={SCENE_COLORS.rearGraySoft}
          edgeColor={visual.edge}
          opacity={0.065}
          edgeOpacity={0.3}
        />
      ))}
      {[-5.8, -5.15, -4.5, -3.85, -2.1, -1.4, -0.7, 0, 0.7, 1.4, 2.1, 4.8, 5.45].map((x) => (
        <OutlinedBox
          key={x}
          size={[0.09, 0.42, 0.24]}
          position={[x, -0.42, 1.14]}
          fillColor={SCENE_COLORS.rearGraySoft}
          edgeColor={SCENE_COLORS.rearGray}
          opacity={0.05}
          edgeOpacity={0.24}
        />
      ))}
    </group>
  );
}

export function OrganPipes3D({ state }: { state: SetupVisualState }) {
  return (
    <group>
      <WindChest3D state={state} />
      <PipeApron state={state} />
      {PIPE_RANKS.map((rank) => (
        <group key={rank.id}>
          {rank.heights.map((height, index) => (
            <Pipe3D
              key={`${rank.id}-${index}`}
              rank={rank}
              heightRaw={height}
              index={index}
              state={state}
            />
          ))}
        </group>
      ))}
      {PIPE_RANKS[2]!.heights.map((height, index) => {
        if (!SOUNDING_VOICE_INDICES.front.includes(index)) return null;
        const rank = PIPE_RANKS[2]!;
        const x = rank.positions[index] ?? rank.startX + rank.spacing * index;
        const topY = rank.baseY + height * PIPE_HEIGHT_SCALE;
        return (
          <VoiceParticles
            key={index}
            x={x}
            topY={topY}
            z={rank.z + 0.03}
            index={index}
            state={state}
          />
        );
      })}
    </group>
  );
}
