import type {
  RuntimeCalibrationMode,
  RuntimeEstimateRangeUi,
  RuntimeEstimateSource,
  RuntimeEstimateUiModel
} from '../../src/contracts/runtime-estimate-ui';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function integerNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim()] : [])
    : [];
}

function range(value: unknown): RuntimeEstimateRangeUi | null {
  const raw = object(value);
  const p50 = finiteNonNegative(raw?.p50);
  const p80 = finiteNonNegative(raw?.p80);
  return p50 !== null && p80 !== null && p80 >= p50 ? { p50, p80 } : null;
}

function source(value: unknown): RuntimeEstimateSource {
  return value === 'agent_decomposed' || value === 'profile_inferred' ? value : 'unknown';
}

function calibrationMode(value: unknown): RuntimeCalibrationMode {
  return value === 'cold_start' || value === 'hybrid' || value === 'historical' ? value : 'unknown';
}

export function projectRuntimeEstimate(value: unknown): RuntimeEstimateUiModel | null {
  const raw = object(value);
  const runtime = object(raw?.runtime);
  const agentActiveMinutes = range(runtime?.agent_active_minutes);
  const elapsedMinutes = range(runtime?.elapsed_minutes);
  const humanInterventionMinutes = range(runtime?.human_intervention_minutes);
  if (!raw || !runtime || !agentActiveMinutes || !elapsedMinutes || !humanInterventionMinutes) return null;
  if (elapsedMinutes.p50 < agentActiveMinutes.p50 || elapsedMinutes.p80 < agentActiveMinutes.p80) return null;

  const calibration = object(raw.calibration);
  const externalGates = Array.isArray(raw.external_gates)
    ? raw.external_gates.flatMap((item) => object(item) ?? [])
    : [];
  const confidence = finiteNonNegative(raw.confidence);

  return {
    source: source(raw.source),
    agentActiveMinutes,
    elapsedMinutes,
    humanInterventionMinutes,
    confidence: confidence !== null && confidence <= 1 ? confidence : null,
    calibrationMode: calibrationMode(calibration?.mode),
    calibrationSampleCount: integerNonNegative(calibration?.sample_count),
    externalGateCount: externalGates.length,
    unknownBlockingGateCount: externalGates.filter((gate) => (
      gate.status === 'unknown_wait' && gate.blocks_done_signal !== false
    )).length,
    uncertaintyDrivers: stringArray(raw.uncertainty_drivers)
  };
}
