export type SetupVisualPhaseId = 1 | 2 | 3 | 4 | 5 | 6;

export type SetupVisualPhaseStatus = 'complete' | 'active' | 'waiting' | 'blocked';

export type SetupVisualLifecycle = 'running' | 'complete' | 'blocked';

export interface SetupVisualPhase {
  id: SetupVisualPhaseId;
  code: string;
  title: string;
  subtitle: string;
  status: SetupVisualPhaseStatus;
  progress: number;
}

export interface SetupVisualLogEntry {
  id: string;
  time: string;
  message: string;
  state: 'ok' | 'running' | 'waiting' | 'blocked';
  stateLabel: string;
}

export interface SetupVisualState {
  activePhaseId: SetupVisualPhaseId | null;
  lifecycle: SetupVisualLifecycle;
  phases: SetupVisualPhase[];
  overallProgress: number;
  reducedMotion: boolean;
  connection: {
    status: 'connected' | 'connecting' | 'disconnected';
    label: string;
    detail: string;
  };
  logs: SetupVisualLogEntry[];
}

export interface MechanismRenderProps {
  phaseStatuses: Record<SetupVisualPhaseId, SetupVisualPhaseStatus>;
  activePhaseId: SetupVisualPhaseId | null;
}
