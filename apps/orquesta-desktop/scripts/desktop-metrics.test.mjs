import assert from 'node:assert/strict';
import { createMeasurementReport, evaluateDesktopGates, formatBytes, selectProcessTree } from './desktop-metrics.mjs';

assert.equal(formatBytes(1_048_576), '1.00 MiB');
assert.deepEqual(evaluateDesktopGates({
  coldStartMs: 3_999,
  footprintBytes: 349 * 1_048_576,
  workingSetBytes: 399 * 1_048_576
}), {
  coldStart: true,
  footprint: true,
  idleWorkingSet: true
});

const report = createMeasurementReport({
  measuredAt: '2026-07-18T00:00:00.000Z',
  executablePath: 'C:/Orquesta/Orquesta.exe',
  coldStartMs: 1_234,
  idleWaitMs: 60_000,
  workingSetBytes: 200 * 1_048_576,
  footprintBytes: 300 * 1_048_576,
  processCount: 5
});
assert.match(report, /Cold start: 1234 ms/);
assert.match(report, /Idle working set: 200\.00 MiB/);
assert.match(report, /Result: PASS/);

assert.deepEqual(selectProcessTree([
  { processId: 10, parentProcessId: 1 },
  { processId: 11, parentProcessId: 10 },
  { processId: 12, parentProcessId: 11 },
  { processId: 20, parentProcessId: 1 }
], 10).map((process) => process.processId), [10, 11, 12]);

console.log('desktop metrics tests passed');
