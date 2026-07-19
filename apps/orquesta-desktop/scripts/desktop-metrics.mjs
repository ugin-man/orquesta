const mebibyte = 1_048_576;

export function formatBytes(bytes) {
  return `${(bytes / mebibyte).toFixed(2)} MiB`;
}

export function evaluateDesktopGates({ coldStartMs, noProjectWorkingSetBytes, selectedProjectWorkingSetBytes, leakGrowthBytes }) {
  const gates = {
    coldStart: coldStartMs <= 4_000,
    noProjectIdleWorkingSet: noProjectWorkingSetBytes <= 400 * mebibyte,
    selectedProjectIdleWorkingSet: selectedProjectWorkingSetBytes <= 400 * mebibyte
  };
  if (Number.isFinite(leakGrowthBytes)) gates.leakWorkingSetGrowth = leakGrowthBytes <= 75 * mebibyte;
  return gates;
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
- Input isolation: ${measurement.interactionIsolation ?? 'not recorded'}
- Cold start: ${Math.round(measurement.coldStartMs)} ms (limit 4000 ms) — ${gates.coldStart ? 'PASS' : 'FAIL'}
- No-project idle working set: ${formatBytes(measurement.noProjectWorkingSetBytes)} after ${Math.round(measurement.idleWaitMs / 1000)} seconds (limit 400 MiB) — ${gates.noProjectIdleWorkingSet ? 'PASS' : 'FAIL'}
- Selected-project idle working set: ${formatBytes(measurement.selectedProjectWorkingSetBytes)} after ${Math.round(measurement.idleWaitMs / 1000)} seconds (limit 400 MiB) — ${gates.selectedProjectIdleWorkingSet ? 'PASS' : 'FAIL'}
- ui_core_footprint_bytes: ${formatBytes(measurement.ui_core_footprint_bytes)}
- codex_runtime_footprint_bytes: ${formatBytes(measurement.codex_runtime_footprint_bytes)}
- total_footprint_bytes: ${formatBytes(measurement.total_footprint_bytes)}
- Electron process count without a project: ${measurement.noProjectProcessCount}
- Electron process count with a selected project: ${measurement.selectedProjectProcessCount}
- Result: ${passed ? 'PASS' : 'FAIL'}

Package footprint is reported as evidence, not used as a pass/fail gate. The no-project run proves lazy project/Core startup; the selected-project run records the idle repository baseline.
`;
}
