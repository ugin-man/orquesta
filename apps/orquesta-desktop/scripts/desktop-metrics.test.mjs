import assert from 'node:assert/strict';
import { createMeasurementReport, evaluateDesktopGates, formatBytes, selectProcessTree } from './desktop-metrics.mjs';

assert.equal(formatBytes(1_048_576), '1.00 MiB');
assert.deepEqual(evaluateDesktopGates({
  coldStartMs: 3_999,
  noProjectWorkingSetBytes: 399 * 1_048_576,
  selectedProjectWorkingSetBytes: 400 * 1_048_576,
  leakGrowthBytes: 75 * 1_048_576
}), {
  coldStart: true,
  noProjectIdleWorkingSet: true,
  selectedProjectIdleWorkingSet: true,
  leakWorkingSetGrowth: true
});
assert.equal('footprint' in evaluateDesktopGates({
  coldStartMs: 1,
  noProjectWorkingSetBytes: 1,
  selectedProjectWorkingSetBytes: 1
}), false);
assert.deepEqual(evaluateDesktopGates({
  coldStartMs: 4_001,
  noProjectWorkingSetBytes: 401 * 1_048_576,
  selectedProjectWorkingSetBytes: 401 * 1_048_576,
  leakGrowthBytes: 76 * 1_048_576
}), {
  coldStart: false,
  noProjectIdleWorkingSet: false,
  selectedProjectIdleWorkingSet: false,
  leakWorkingSetGrowth: false
});

const report = createMeasurementReport({
  measuredAt: '2026-07-18T00:00:00.000Z',
  executablePath: 'C:/Orquesta/Orquesta.exe',
  interactionIsolation: 'native mouse input disabled before idle timing',
  coldStartMs: 1_234,
  idleWaitMs: 60_000,
  noProjectWorkingSetBytes: 180 * 1_048_576,
  selectedProjectWorkingSetBytes: 200 * 1_048_576,
  ui_core_footprint_bytes: 180 * 1_048_576,
  codex_runtime_footprint_bytes: 120 * 1_048_576,
  total_footprint_bytes: 300 * 1_048_576,
  noProjectProcessCount: 4,
  selectedProjectProcessCount: 5
});
assert.match(report, /Cold start: 1234 ms/);
assert.match(report, /No-project idle working set: 180\.00 MiB/);
assert.match(report, /Selected-project idle working set: 200\.00 MiB/);
assert.match(report, /ui_core_footprint_bytes: 180\.00 MiB/);
assert.match(report, /codex_runtime_footprint_bytes: 120\.00 MiB/);
assert.match(report, /total_footprint_bytes: 300\.00 MiB/);
assert.match(report, /Input isolation: native mouse input disabled before idle timing/);
assert.doesNotMatch(report, /footprint.*limit/i);
assert.match(report, /Result: PASS/);

assert.deepEqual(selectProcessTree([
  { processId: 10, parentProcessId: 1 },
  { processId: 11, parentProcessId: 10 },
  { processId: 12, parentProcessId: 11 },
  { processId: 20, parentProcessId: 1 }
], 10).map((process) => process.processId), [10, 11, 12]);

console.log('desktop metrics tests passed');
