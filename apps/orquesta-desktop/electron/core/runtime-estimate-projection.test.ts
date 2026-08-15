import { describe, expect, test } from 'vitest';
import { projectRuntimeEstimate } from './runtime-estimate-projection';

describe('runtime estimate projection', () => {
  test('projects validated task clocks and external-gate evidence', () => {
    expect(projectRuntimeEstimate({
      source: 'agent_decomposed',
      runtime: {
        agent_active_minutes: { p50: 18, p80: 42 },
        elapsed_minutes: { p50: 22, p80: 55 },
        human_intervention_minutes: { p50: 0, p80: 5 }
      },
      calibration: { mode: 'historical', sample_count: 12 },
      external_gates: [
        { status: 'known_wait', blocks_done_signal: true, known_wait_minutes: 4 },
        { status: 'unknown_wait', blocks_done_signal: true, known_wait_minutes: null }
      ],
      uncertainty_drivers: ['test_latency'],
      confidence: 0.74
    })).toEqual({
      source: 'agent_decomposed',
      agentActiveMinutes: { p50: 18, p80: 42 },
      elapsedMinutes: { p50: 22, p80: 55 },
      humanInterventionMinutes: { p50: 0, p80: 5 },
      confidence: 0.74,
      calibrationMode: 'historical',
      calibrationSampleCount: 12,
      externalGateCount: 2,
      unknownBlockingGateCount: 1,
      uncertaintyDrivers: ['test_latency']
    });
  });

  test('rejects malformed or inverted runtime clocks', () => {
    expect(projectRuntimeEstimate(null)).toBeNull();
    expect(projectRuntimeEstimate({
      runtime: {
        agent_active_minutes: { p50: 10, p80: 20 },
        elapsed_minutes: { p50: 8, p80: 18 },
        human_intervention_minutes: { p50: 0, p80: 1 }
      }
    })).toBeNull();
  });
});
