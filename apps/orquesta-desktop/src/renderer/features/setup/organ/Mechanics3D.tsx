import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Group } from 'three';
import type { SetupVisualState } from '../setup-visual-types';
import { getScenePhaseState } from './sceneLayout';
import { getPhaseVisual, SCENE_COLORS } from './materials';
import { EdgeOutlinedMesh } from './EdgeOutlinedMesh';
import { OutlinedBox, OutlinedCylinder, OutlinedRod } from './ScenePrimitives';

const CRANK_CENTER = new THREE.Vector3(0.8, -3.45, 0.58);
const PISTON_Y = -4.25;
const PISTON_Z = 0.58;

const updateUnitRod = (group: Group, start: THREE.Vector3, end: THREE.Vector3) => {
  const direction = end.clone().sub(start);
  const length = direction.length();
  group.position.copy(start.clone().add(end).multiplyScalar(0.5));
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  group.scale.set(1, length, 1);
};

export function Mechanics3D({ state }: { state: SetupVisualState }) {
  const phaseState = useMemo(() => getScenePhaseState(state), [state]);
  const visual = getPhaseVisual(phaseState, 3);
  const crankRef = useRef<Group>(null);
  const rodRef = useRef<Group>(null);
  const pistonRef = useRef<Group>(null);
  const angleRef = useRef(0);

  const crankGeometry = useMemo(() => new THREE.CylinderGeometry(0.68, 0.68, 0.38, 30), []);
  const rodGeometry = useMemo(() => new THREE.CylinderGeometry(0.075, 0.075, 1, 12), []);
  useEffect(
    () => () => {
      crankGeometry.dispose();
      rodGeometry.dispose();
    },
    [crankGeometry, rodGeometry],
  );

  useFrame((_, delta) => {
    if (!crankRef.current || !rodRef.current || !pistonRef.current) return;
    if (visual.running && !state.reducedMotion) angleRef.current -= delta * 1.75;
    else if (!visual.running) angleRef.current += (0 - angleRef.current) * 0.12;

    const angle = angleRef.current;
    crankRef.current.rotation.z = angle;
    const pin = CRANK_CENTER.clone().add(
      new THREE.Vector3(Math.cos(angle) * 0.48, Math.sin(angle) * 0.48, 0.07),
    );
    const pistonX = -0.52 + Math.cos(angle) * 0.24;
    const pistonEnd = new THREE.Vector3(pistonX, PISTON_Y, PISTON_Z);
    updateUnitRod(rodRef.current, pin, pistonEnd);
    pistonRef.current.position.x = pistonX;
  });

  return (
    <group>
      <OutlinedRod
        start={[4.62, -1.24, 0.68]}
        end={[2.55, -2.4, 0.62]}
        radius={0.09}
        fillColor={visual.fill}
        edgeColor={visual.edge}
        opacity={visual.opacity}
        edgeOpacity={visual.running ? 0.92 : 0.46}
      />
      <OutlinedRod
        start={[2.55, -2.4, 0.62]}
        end={[CRANK_CENTER.x, CRANK_CENTER.y, CRANK_CENTER.z]}
        radius={0.09}
        fillColor={visual.fill}
        edgeColor={visual.edge}
        opacity={visual.opacity}
        edgeOpacity={visual.running ? 0.92 : 0.46}
      />
      <OutlinedRod
        start={[2.55, -2.4, -0.5]}
        end={[CRANK_CENTER.x, CRANK_CENTER.y, -0.5]}
        radius={0.075}
        fillColor={SCENE_COLORS.rearGraySoft}
        edgeColor={SCENE_COLORS.rearGray}
        opacity={0.055}
        edgeOpacity={0.4}
      />

      <group position={CRANK_CENTER.toArray()}>
        <OutlinedCylinder
          radius={0.18}
          height={1.8}
          position={[0, 0, -0.74]}
          rotation={[Math.PI / 2, 0, 0]}
          fillColor={SCENE_COLORS.rearGraySoft}
          edgeColor={SCENE_COLORS.rearGray}
          opacity={0.055}
          edgeOpacity={0.42}
          radialSegments={16}
        />
        <group ref={crankRef}>
          <group rotation={[Math.PI / 2, 0, 0]}>
            <EdgeOutlinedMesh
              geometry={crankGeometry}
              fillColor={visual.fill}
              edgeColor={visual.edge}
              opacity={visual.opacity}
              edgeOpacity={visual.running ? 0.94 : 0.46}
            />
          </group>
          <OutlinedBox
            size={[0.84, 0.14, 0.4]}
            position={[0.26, 0, 0.04]}
            fillColor={visual.fill}
            edgeColor={visual.edge}
            opacity={visual.opacity}
            edgeOpacity={visual.running ? 0.88 : 0.42}
          />
          <OutlinedCylinder
            radius={0.11}
            height={0.56}
            position={[0.48, 0, 0.1]}
            rotation={[Math.PI / 2, 0, 0]}
            fillColor={visual.fill}
            edgeColor={visual.edge}
            opacity={visual.running ? 0.21 : 0.075}
            edgeOpacity={visual.running ? 0.94 : 0.46}
            radialSegments={14}
          />
          {visual.emphasized && (
            <mesh position={[0.48, 0, 0.42]}>
              <sphereGeometry args={[0.065, 12, 8]} />
              <meshBasicMaterial color={SCENE_COLORS.mint} />
            </mesh>
          )}
        </group>
      </group>

      <group ref={rodRef}>
        <EdgeOutlinedMesh
          geometry={rodGeometry}
          fillColor={visual.fill}
          edgeColor={visual.edge}
          opacity={visual.opacity}
          edgeOpacity={visual.running ? 0.92 : 0.42}
        />
      </group>

      <group>
        <OutlinedBox
          size={[2.45, 1.5, 1.28]}
          position={[-0.8, -4.25, 0.04]}
          fillColor={visual.fill}
          edgeColor={visual.edge}
          opacity={visual.opacity * 0.74}
          edgeOpacity={visual.running ? 0.82 : 0.4}
        />
        <OutlinedBox
          size={[2.72, 0.18, 1.48]}
          position={[-0.8, -3.4, -0.08]}
          fillColor={SCENE_COLORS.rearGraySoft}
          edgeColor={SCENE_COLORS.rearGray}
          opacity={0.045}
          edgeOpacity={0.36}
        />
        <group ref={pistonRef} position={[-0.52, PISTON_Y, PISTON_Z]}>
          <OutlinedBox
            size={[0.42, 0.62, 0.62]}
            position={[0, 0, 0]}
            fillColor={visual.fill}
            edgeColor={visual.edge}
            opacity={visual.running ? 0.2 : 0.07}
            edgeOpacity={visual.running ? 0.9 : 0.42}
          />
        </group>
        <OutlinedRod
          start={[-2.02, -4.0, 0.22]}
          end={[-2.72, -4.0, 0.22]}
          radius={0.12}
          fillColor={visual.fill}
          edgeColor={visual.edge}
          opacity={visual.opacity}
          edgeOpacity={visual.running ? 0.78 : 0.38}
        />
        <OutlinedRod
          start={[0.42, -4.45, 0.22]}
          end={[1.18, -4.45, 0.22]}
          radius={0.12}
          fillColor={visual.fill}
          edgeColor={visual.edge}
          opacity={visual.opacity}
          edgeOpacity={visual.running ? 0.78 : 0.38}
        />
      </group>

      {[-1.9, 0.35, 2.2].map((x) => (
        <OutlinedBox
          key={x}
          size={[0.18, 2.35, 0.2]}
          position={[x, -4.1, -0.82]}
          fillColor={SCENE_COLORS.rearGraySoft}
          edgeColor={SCENE_COLORS.rearGray}
          opacity={0.04}
          edgeOpacity={0.32}
        />
      ))}
    </group>
  );
}
