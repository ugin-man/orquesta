export type RuntimeEstimateSource = 'agent_decomposed' | 'profile_inferred' | 'unknown';
export type RuntimeCalibrationMode = 'cold_start' | 'hybrid' | 'historical' | 'unknown';

export interface RuntimeEstimateRangeUi {
  p50: number;
  p80: number;
}

export interface RuntimeEstimateUiModel {
  source: RuntimeEstimateSource;
  agentActiveMinutes: RuntimeEstimateRangeUi;
  elapsedMinutes: RuntimeEstimateRangeUi;
  humanInterventionMinutes: RuntimeEstimateRangeUi;
  confidence: number | null;
  calibrationMode: RuntimeCalibrationMode;
  calibrationSampleCount: number | null;
  externalGateCount: number;
  unknownBlockingGateCount: number;
  uncertaintyDrivers: string[];
}

declare module './orquesta-ui' {
  interface TaskUiModel {
    runtimeEstimate?: RuntimeEstimateUiModel | null;
  }
}
