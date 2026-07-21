import type { SetupVisualPhaseId } from '../setup-visual-types';
import type { ScenePhaseState } from './sceneLayout';

export const SCENE_COLORS = {
  paper: '#f4f1ea',
  paperBright: '#fbfaf6',
  graphite: '#22211d',
  graphiteSoft: '#4f4c45',
  rearGray: '#918d84',
  rearGraySoft: '#b7b2a8',
  metalLight: '#aaa69e',
  metalMid: '#817d75',
  mint: '#56bd98',
  mintDark: '#218467',
  blocked: '#b45f58',
} as const;

export interface PhaseVisual {
  running: boolean;
  emphasized: boolean;
  blocked: boolean;
  edge: string;
  fill: string;
  rear: string;
  opacity: number;
}

export const getPhaseVisual = (
  phaseState: ScenePhaseState,
  phaseId: SetupVisualPhaseId,
): PhaseVisual => {
  const running = phaseState.running.includes(phaseId);
  const emphasized = phaseState.emphasized.includes(phaseId);
  const blocked = phaseState.blocked === phaseId;

  if (blocked) {
    return {
      running: false,
      emphasized: false,
      blocked: true,
      edge: SCENE_COLORS.blocked,
      fill: SCENE_COLORS.blocked,
      rear: SCENE_COLORS.rearGray,
      opacity: 0.1,
    };
  }

  if (running) {
    return {
      running: true,
      emphasized,
      blocked: false,
      edge: SCENE_COLORS.graphite,
      fill: SCENE_COLORS.graphiteSoft,
      rear: SCENE_COLORS.rearGray,
      opacity: emphasized ? 0.16 : 0.12,
    };
  }

  return {
    running: false,
    emphasized: false,
    blocked: false,
    edge: SCENE_COLORS.rearGray,
    fill: SCENE_COLORS.rearGraySoft,
    rear: SCENE_COLORS.rearGraySoft,
    opacity: 0.055,
  };
};
