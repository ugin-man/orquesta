const mebibyte = 1_048_576;

export function formatBytes(bytes) {
  return `${(bytes / mebibyte).toFixed(2)} MiB`;
}

export function evaluateDesktopGates({ coldStartMs, footprintBytes, workingSetBytes }) {
  return {
    coldStart: coldStartMs <= 4_000,
    footprint: footprintBytes <= 350 * mebibyte,
    idleWorkingSet: workingSetBytes <= 400 * mebibyte
  };
}

export function selectProcessTree(processes, rootProcessId) {
  const selectedIds = new Set([rootProcessId]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const process of processes) {
      if (!selectedIds.has(process.processId) && selectedIds.has(process.parentProcessId)) {
        selectedIds.add(process.processId);
        changed = true;
      }
    }
  }

  return processes.filter((process) => selectedIds.has(process.processId));
}

export function createMeasurementReport(measurement) {
  const gates = evaluateDesktopGates(measurement);
  const passed = Object.values(gates).every(Boolean);

  return `# Orquesta Desktop Foundation Validation

Measured on ${measurement.measuredAt} using the packaged Windows x64 application.

- Executable: \`${measurement.executablePath}\`
- Cold start: ${Math.round(measurement.coldStartMs)} ms (limit 4000 ms) — ${gates.coldStart ? 'PASS' : 'FAIL'}
- Idle working set: ${formatBytes(measurement.workingSetBytes)} after ${Math.round(measurement.idleWaitMs / 1000)} seconds (limit 400 MiB) — ${gates.idleWorkingSet ? 'PASS' : 'FAIL'}
- Application footprint: ${formatBytes(measurement.footprintBytes)} (limit 350 MiB) — ${gates.footprint ? 'PASS' : 'FAIL'}
- Electron process count at idle: ${measurement.processCount}
- Result: ${passed ? 'PASS' : 'FAIL'}

This Foundation measurement uses the packaged renderer fixture. Codex App Server and project repository integration are not running yet.
`;
}
