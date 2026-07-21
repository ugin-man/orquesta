import type { SetupVisualPhaseId, SetupVisualState } from '../setup-visual-types';
import { getPhaseActivity } from '../phase-activity';

export type Vec3Tuple = [number, number, number];

const SVG_CENTER_X = 596;
const SVG_CENTER_Y = 410;
const WORLD_SCALE = 0.018;

export const svgToWorld = (x: number, y: number, z = 0): Vec3Tuple => [
  Number(((x - SVG_CENTER_X) * WORLD_SCALE).toFixed(4)),
  Number(((SVG_CENTER_Y - y) * WORLD_SCALE).toFixed(4)),
  z,
];


export interface SpineLayout {
  position: Vec3Tuple;
  height: number;
  coreRadius: number;
  shellWidth: number;
}

export const SPINE_LAYOUT: SpineLayout = {
  position: [0, 2.05, 1.12],
  height: 13.2,
  coreRadius: 0.34,
  shellWidth: 1.18,
};

export interface GearLayoutItem {
  id: string;
  phaseId: SetupVisualPhaseId;
  position: Vec3Tuple;
  radius: number;
  thickness: number;
  teeth: number;
  clockwise: boolean;
  speed: number;
}

export const GEAR_LAYOUT: GearLayoutItem[] = [
  {
    id: 'drive-top',
    phaseId: 1,
    position: [4.18, 5.18, 1.0],
    radius: 0.88,
    thickness: 0.38,
    teeth: 24,
    clockwise: true,
    speed: 0.74,
  },
  {
    id: 'drive-upper',
    phaseId: 2,
    position: [4.12, 3.54, 0.98],
    radius: 1.02,
    thickness: 0.4,
    teeth: 28,
    clockwise: false,
    speed: 0.86,
  },
  {
    id: 'drive-middle',
    phaseId: 2,
    position: [4.18, 1.9, 0.94],
    radius: 0.94,
    thickness: 0.38,
    teeth: 24,
    clockwise: true,
    speed: 0.81,
  },
  {
    id: 'drive-lower',
    phaseId: 2,
    position: [4.08, 0.3, 0.9],
    radius: 0.86,
    thickness: 0.36,
    teeth: 22,
    clockwise: false,
    speed: 0.92,
  },
  {
    id: 'output-pinion',
    phaseId: 2,
    position: [3.72, -1.16, 0.86],
    radius: 0.58,
    thickness: 0.32,
    teeth: 16,
    clockwise: true,
    speed: 1.3,
  },
];

export interface PipeRankLayout {
  id: 'back' | 'middle' | 'front';
  z: number;
  baseY: number;
  startX: number;
  spacing: number;
  radiusScale: number;
  positions: number[];
  heights: number[];
}

export const PIPE_HEIGHT_SCALE = 0.014;

export const PIPE_RANKS: PipeRankLayout[] = [
  {
    id: 'back',
    z: -0.8,
    baseY: -0.78,
    startX: -4.2,
    spacing: 0.55,
    radiusScale: 0.74,
    positions: [-5.95, -5.55, -5.15, -4.55, -4.1, -3.65, -2.1, -1.55, -1.0, 0, 1.0, 1.55, 2.1, 4.85, 5.45],
    heights: [292, 326, 360, 330, 278, 252, 296, 392, 448, 492, 448, 392, 296, 252, 278],
  },
  {
    id: 'middle',
    z: 0,
    baseY: -0.66,
    startX: -4.55,
    spacing: 0.55,
    radiusScale: 0.88,
    positions: [-6.05, -5.65, -5.25, -4.75, -4.3, -3.85, -2.45, -1.9, -1.35, -0.7, 0, 0.7, 1.35, 1.9, 2.45, 4.95, 5.55],
    heights: [326, 366, 406, 370, 304, 278, 326, 424, 492, 544, 492, 424, 326, 278, 304, 370, 406],
  },
  {
    id: 'front',
    z: 0.8,
    baseY: -0.54,
    startX: -5.05,
    spacing: 0.55,
    radiusScale: 1.03,
    positions: [-6.15, -5.75, -5.35, -4.8, -4.35, -3.9, -2.2, -1.65, -1.1, 0, 0.55, 1.1, 1.65, 2.2, 4.7, 5.1, 5.55, 5.9, 6.2],
    heights: [360, 400, 440, 400, 330, 300, 350, 480, 540, 590, 540, 480, 350, 300, 330, 400, 440, 400, 360],
  },
];


export const SOUNDING_VOICE_INDICES: Record<PipeRankLayout['id'], number[]> = {
  front: [0, 2, 4, 7, 9, 11, 14, 16, 18],
  middle: [1, 4, 7, 9, 12, 15],
  back: [2, 7, 9, 12],
};

export interface ScenePhaseState {
  running: SetupVisualPhaseId[];
  emphasized: SetupVisualPhaseId[];
  blocked: SetupVisualPhaseId | null;
}

const PHASE_IDS: SetupVisualPhaseId[] = [1, 2, 3, 4, 5, 6];

export const getScenePhaseState = (
  state: SetupVisualState,
): ScenePhaseState => {
  const running = PHASE_IDS.filter((phaseId) => getPhaseActivity(state, phaseId).running);
  const emphasized = PHASE_IDS.filter(
    (phaseId) => getPhaseActivity(state, phaseId).emphasis === 'current',
  );
  const blocked =
    PHASE_IDS.find((phaseId) => getPhaseActivity(state, phaseId).emphasis === 'blocked') ?? null;

  return { running, emphasized, blocked };
};

export const isPhaseRunning = (
  phaseState: ScenePhaseState,
  phaseId: SetupVisualPhaseId,
): boolean => phaseState.running.includes(phaseId);

export const isPhaseEmphasized = (
  phaseState: ScenePhaseState,
  phaseId: SetupVisualPhaseId,
): boolean => phaseState.emphasized.includes(phaseId);
