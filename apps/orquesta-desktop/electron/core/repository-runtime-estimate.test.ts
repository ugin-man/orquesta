import { describe, expect, test } from 'vitest';
import { projectSnapshotFromDocuments } from './repository-reader';

describe('repository runtime estimate projection', () => {
  test('projects a canonical task runtime estimate for Desktop', () => {
    const snapshot = projectSnapshotFromDocuments({
      rootPath: 'C:\work\runtime-estimate',
      documents: {
        agents: { agents: [] },
        tasks: {
          tasks: [{
            task_id: 'T-ETA',
            title: 'Estimate the bounded task',
            state: 'queued',
            runtime_estimate: {
              source: 'profile_inferred',
              runtime: {
                agent_active_minutes: { p50: 14, p80: 36 },
                elapsed_minutes: { p50: 16, p80: 40 },
                human_intervention_minutes: { p50: 0, p80: 4 }
              },
              calibration: { mode: 'cold_start', sample_count: 0 },
              external_gates: [{ status: 'unknown_wait', blocks_done_signal: true, known_wait_minutes: null }],
              uncertainty_drivers: ['cold_start_calibration'],
              confidence: 0.3
            }
          }]
        }
      }
    });

    expect(snapshot.tasks[0].runtimeEstimate).toMatchObject({
      source: 'profile_inferred',
      agentActiveMinutes: { p50: 14, p80: 36 },
      elapsedMinutes: { p50: 16, p80: 40 },
      humanInterventionMinutes: { p50: 0, p80: 4 },
      confidence: 0.3,
      calibrationMode: 'cold_start',
      calibrationSampleCount: 0,
      unknownBlockingGateCount: 1
    });
  });
});
