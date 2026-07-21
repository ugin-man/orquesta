import { useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { SetupVisualPhaseId, SetupVisualState } from '../setup-visual-types';
import type { Locale } from '../../i18n/messages';
import { getSetupCopy } from '../setup-localization';
import { phaseActivityAttributes } from '../phase-activity';
import { PIPE_RANKS, SOUNDING_VOICE_INDICES } from './sceneLayout';
import { GearTrain3D } from './GearTrain3D';
import { Mechanics3D } from './Mechanics3D';
import { Bellows3D } from './Bellows3D';
import { Airflow3D } from './Airflow3D';
import { OrganPipes3D } from './OrganPipes3D';
import { OrganFrame3D } from './OrganFrame3D';
import { MechanicalSpine3D } from './MechanicalSpine3D';
import { LowerEngine3D } from './LowerEngine3D';
import { BackdropPanels3D } from './BackdropPanels3D';
import { SCENE_COLORS } from './materials';

const PHASE_IDS: SetupVisualPhaseId[] = [1, 2, 3, 4, 5, 6];

const supportsWebGL = (): boolean => {
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    typeof window.WebGLRenderingContext === 'undefined'
  ) {
    return false;
  }
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
};

interface CameraPreset {
  position: [number, number, number];
  lookAt: [number, number, number];
  fov: number;
  pointerPositionScale: [number, number];
  pointerLookScale: [number, number];
}

const CAMERA_PRESETS: Record<SetupVisualPhaseId | 'complete' | 'blocked', CameraPreset> = {
  1: {
    position: [5.4, 4.8, 22.5],
    lookAt: [4.1, 4.0, 0.75],
    fov: 21.5,
    pointerPositionScale: [0.1, 0.07],
    pointerLookScale: [0.07, 0.05],
  },
  2: {
    position: [4.7, 4.3, 23.5],
    lookAt: [3.7, 2.3, 0.6],
    fov: 22.8,
    pointerPositionScale: [0.11, 0.075],
    pointerLookScale: [0.075, 0.055],
  },
  3: {
    position: [3.9, 3.8, 25.0],
    lookAt: [2.7, 0.0, 0.42],
    fov: 24.2,
    pointerPositionScale: [0.12, 0.08],
    pointerLookScale: [0.085, 0.06],
  },
  4: {
    position: [2.9, 3.4, 26.5],
    lookAt: [1.5, -1.1, 0.3],
    fov: 25.8,
    pointerPositionScale: [0.13, 0.09],
    pointerLookScale: [0.095, 0.07],
  },
  5: {
    position: [1.8, 3.2, 28.0],
    lookAt: [0.55, -0.2, 0.16],
    fov: 27.0,
    pointerPositionScale: [0.15, 0.1],
    pointerLookScale: [0.11, 0.08],
  },
  6: {
    position: [0.25, 3.55, 33.4],
    lookAt: [0, 1.0, 0],
    fov: 30.4,
    pointerPositionScale: [0.24, 0.15],
    pointerLookScale: [0.145, 0.105],
  },
  complete: {
    position: [0.25, 3.55, 33.4],
    lookAt: [0, 1.0, 0],
    fov: 30.4,
    pointerPositionScale: [0.22, 0.14],
    pointerLookScale: [0.135, 0.095],
  },
  blocked: {
    position: [7.7, 4.05, 21.8],
    lookAt: [0.8, -0.18, 0],
    fov: 30,
    pointerPositionScale: [0.1, 0.08],
    pointerLookScale: [0.08, 0.05],
  },
};

const getCameraPresetKey = (
  state: SetupVisualState,
): SetupVisualPhaseId | 'complete' | 'blocked' => {
  if (state.lifecycle === 'complete') return 'complete';
  if (state.lifecycle === 'blocked') return 'blocked';
  return state.activePhaseId ?? 6;
};

function FixedCamera({ state }: { state: SetupVisualState }) {
  const { camera, pointer } = useThree();
  const perspectiveCamera = camera as THREE.PerspectiveCamera;
  const initializedRef = useRef(false);

  const basePosition = useRef(new THREE.Vector3());
  const targetBasePosition = useRef(new THREE.Vector3());
  const targetPosition = useRef(new THREE.Vector3());

  const baseLookAt = useRef(new THREE.Vector3());
  const targetBaseLookAt = useRef(new THREE.Vector3());
  const targetLookAt = useRef(new THREE.Vector3());
  const currentLookAt = useRef(new THREE.Vector3());

  const fovRef = useRef(perspectiveCamera.fov);
  const targetFovRef = useRef(perspectiveCamera.fov);

  const pointerPositionScaleRef = useRef<[number, number]>([0, 0]);
  const targetPointerPositionScaleRef = useRef<[number, number]>([0, 0]);
  const pointerLookScaleRef = useRef<[number, number]>([0, 0]);
  const targetPointerLookScaleRef = useRef<[number, number]>([0, 0]);

  const presetKey = getCameraPresetKey(state);
  const preset = useMemo(() => CAMERA_PRESETS[presetKey], [presetKey]);

  useLayoutEffect(() => {
    const [px, py, pz] = preset.position;
    const [lx, ly, lz] = preset.lookAt;

    targetBasePosition.current.set(px, py, pz);
    targetBaseLookAt.current.set(lx, ly, lz);
    targetFovRef.current = preset.fov;
    targetPointerPositionScaleRef.current = [...preset.pointerPositionScale];
    targetPointerLookScaleRef.current = [...preset.pointerLookScale];

    if (!initializedRef.current) {
      initializedRef.current = true;
      basePosition.current.copy(targetBasePosition.current);
      baseLookAt.current.copy(targetBaseLookAt.current);
      currentLookAt.current.copy(targetBaseLookAt.current);
      perspectiveCamera.position.copy(targetBasePosition.current);
      perspectiveCamera.fov = preset.fov;
      perspectiveCamera.lookAt(currentLookAt.current);
      perspectiveCamera.updateProjectionMatrix();
      fovRef.current = preset.fov;
      pointerPositionScaleRef.current = [...preset.pointerPositionScale];
      pointerLookScaleRef.current = [...preset.pointerLookScale];
    }
  }, [perspectiveCamera, preset]);

  useFrame(() => {
    const influence = state.reducedMotion ? 0 : 1;
    const transitionDamping = state.reducedMotion ? 0.22 : 0.1;
    const pointerDamping = state.reducedMotion ? 0.22 : 0.14;
    const fovDamping = state.reducedMotion ? 0.28 : 0.12;

    basePosition.current.lerp(targetBasePosition.current, transitionDamping);
    baseLookAt.current.lerp(targetBaseLookAt.current, transitionDamping);

    pointerPositionScaleRef.current[0] += (targetPointerPositionScaleRef.current[0] - pointerPositionScaleRef.current[0]) * pointerDamping;
    pointerPositionScaleRef.current[1] += (targetPointerPositionScaleRef.current[1] - pointerPositionScaleRef.current[1]) * pointerDamping;
    pointerLookScaleRef.current[0] += (targetPointerLookScaleRef.current[0] - pointerLookScaleRef.current[0]) * pointerDamping;
    pointerLookScaleRef.current[1] += (targetPointerLookScaleRef.current[1] - pointerLookScaleRef.current[1]) * pointerDamping;

    targetPosition.current.set(
      basePosition.current.x + pointer.x * pointerPositionScaleRef.current[0] * influence,
      basePosition.current.y + pointer.y * pointerPositionScaleRef.current[1] * influence,
      basePosition.current.z,
    );
    targetLookAt.current.set(
      baseLookAt.current.x + pointer.x * pointerLookScaleRef.current[0] * influence,
      baseLookAt.current.y + pointer.y * pointerLookScaleRef.current[1] * influence,
      baseLookAt.current.z,
    );

    perspectiveCamera.position.lerp(targetPosition.current, transitionDamping);
    currentLookAt.current.lerp(targetLookAt.current, transitionDamping);
    fovRef.current += (targetFovRef.current - fovRef.current) * fovDamping;
    perspectiveCamera.fov = fovRef.current;
    perspectiveCamera.lookAt(currentLookAt.current);
    perspectiveCamera.updateProjectionMatrix();
  });

  return null;
}

function TechnicalFloor({ phaseId }: { phaseId: SetupVisualPhaseId | 'complete' | 'blocked' }) {
  const opacity = phaseId === 6 || phaseId === 'complete' ? 0.14 : 0.08;
  const material = useMemo(
    () => new THREE.LineBasicMaterial({
      color: SCENE_COLORS.rearGray,
      transparent: true,
      opacity,
      depthWrite: false,
    }),
    [opacity],
  );
  const geometry = useMemo(() => {
    const points: THREE.Vector3[] = [];
    for (let index = -10; index <= 10; index += 1) {
      points.push(new THREE.Vector3(index, -5.82, -4));
      points.push(new THREE.Vector3(index, -5.82, 4));
    }
    for (let index = -4; index <= 4; index += 1) {
      points.push(new THREE.Vector3(-10, -5.82, index));
      points.push(new THREE.Vector3(10, -5.82, index));
    }
    return new THREE.BufferGeometry().setFromPoints(points);
  }, []);

  return <lineSegments geometry={geometry} material={material} />;
}

function SceneContents({ state }: { state: SetupVisualState }) {
  const presetKey = getCameraPresetKey(state);
  const accentLight =
    presetKey === 1 || presetKey === 2
      ? [9, 8, 11]
      : presetKey === 3 || presetKey === 4
        ? [3, 7, 12]
        : [6, 10, 15];

  return (
    <>
      <FixedCamera state={state} />
      <ambientLight intensity={1.82} color="#fffdfa" />
      <directionalLight position={accentLight as [number, number, number]} intensity={1.02} color="#fffefa" />
      <directionalLight position={[-7, 4, 9]} intensity={0.38} color="#d9e3df" />
      <group position={[0, -0.38, 0]} scale={1.0}>
        <TechnicalFloor phaseId={presetKey} />
        <BackdropPanels3D />
        <OrganFrame3D />
        <MechanicalSpine3D state={state} />
        <OrganPipes3D state={state} />
        <Bellows3D state={state} />
        <LowerEngine3D state={state} />
        <Mechanics3D state={state} />
        <Airflow3D state={state} />
        <GearTrain3D state={state} />
      </group>
    </>
  );
}

function SceneSemanticManifest({ state }: { state: SetupVisualState }) {
  let pipeNumber = 0;
  return (
    <div className="setup-scene-semantic-manifest" aria-hidden="true">
      {PHASE_IDS.map((phaseId) => (
        <span key={phaseId} {...phaseActivityAttributes(state, phaseId)} />
      ))}
      <span data-component="gear-train" />
      <span data-component="organ-pipes" />
      <span data-component="organ-architecture" />
      <span data-component="mechanical-spine" />
      <span data-component="airflow-system" />
      {PIPE_RANKS.flatMap((rank) =>
        rank.heights.map((_, index) => {
          pipeNumber += 1;
          const voiceActive = SOUNDING_VOICE_INDICES[rank.id].includes(index);
          return (
            <span
              key={`${rank.id}-${index}`}
              data-pipe-id={`${rank.id}-${index + 1}`}
              data-pipe-number={pipeNumber}
              data-voice-active={String(voiceActive)}
              data-motion-axis={voiceActive ? 'vertical' : undefined}
            />
          );
        }),
      )}
      {SOUNDING_VOICE_INDICES.front.map((index) => (
        <span
          key={`voice-${index}`}
          data-emission-path={`voice-${index + 1}`}
          data-motion-axis="vertical"
        />
      ))}
      {Array.from({ length: 11 }, (_, index) => (
        <span key={index} data-airflow-path={`branch-${index + 1}`} data-motion-axis="vertical" />
      ))}
    </div>
  );
}

export function SetupOrganScene({ state, active = true, locale = 'ja' }: {
  state: SetupVisualState;
  active?: boolean;
  locale?: Locale;
}) {
  const copy = getSetupCopy(locale);
  const canRender = supportsWebGL();
  const initialPreset = CAMERA_PRESETS[getCameraPresetKey(state)];

  return (
    <div
      className="setup-organ-scene"
      data-renderer="three-webgl"
      role="img"
      aria-label={copy.organAria}
    >
      <SceneSemanticManifest state={state} />
      {canRender ? (
        <Canvas
          className="setup-organ-canvas"
          dpr={[1, 1.5]}
          frameloop={active ? 'always' : 'never'}
          camera={{
            fov: initialPreset.fov,
            near: 0.1,
            far: 100,
            position: initialPreset.position,
          }}
          gl={{
            antialias: true,
            alpha: true,
            powerPreference: 'high-performance',
          }}
          onCreated={({ gl }) => {
            gl.setClearColor(0x000000, 0);
            gl.outputColorSpace = THREE.SRGBColorSpace;
            gl.toneMapping = THREE.NoToneMapping;
          }}
        >
          <SceneContents state={state} />
        </Canvas>
      ) : (
        <div className="setup-organ-webgl-fallback">
          <strong>{copy.organFallbackTitle}</strong>
          <span>{copy.organFallbackBody}</span>
        </div>
      )}
    </div>
  );
}
