const mebibyte = 1_048_576;
const selectedProjectMemoryLimitMib = 450;

export function formatBytes(bytes) {
  return `${(bytes / mebibyte).toFixed(2)} MiB`;
}

export function hasEagerCodexRuntime(processes = []) {
  return processes.some((process) => (
    String(process.name ?? '').toLowerCase() === 'codex.exe'
    || /\bcodex(?:\.exe)?\b.*\bapp-server\b/iu.test(String(process.commandLine ?? ''))
  ));
}

export function evaluateDesktopGates({ coldStartMs, noProjectWorkingSetBytes, selectedProjectWorkingSetBytes, selectedProjectProcessCount, selectedProjectProcessMetrics, leakGrowthBytes }) {
  const gates = {
    coldStart: coldStartMs <= 4_000,
    noProjectIdleWorkingSet: noProjectWorkingSetBytes <= 400 * mebibyte,
    selectedProjectIdleWorkingSet: selectedProjectWorkingSetBytes <= selectedProjectMemoryLimitMib * mebibyte
  };
  if (Number.isFinite(selectedProjectProcessCount)) gates.selectedProjectIdleProcessCount = selectedProjectProcessCount <= 6;
  if (Array.isArray(selectedProjectProcessMetrics)) gates.selectedProjectRuntimeIsolation = !hasEagerCodexRuntime(selectedProjectProcessMetrics);
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
- Selected-project idle working set: ${formatBytes(measurement.selectedProjectWorkingSetBytes)} after ${Math.round(measurement.idleWaitMs / 1000)} seconds (limit ${selectedProjectMemoryLimitMib} MiB) — ${gates.selectedProjectIdleWorkingSet ? 'PASS' : 'FAIL'}
- ui_core_footprint_bytes: ${formatBytes(measurement.ui_core_footprint_bytes)}
- codex_runtime_footprint_bytes: ${formatBytes(measurement.codex_runtime_footprint_bytes)}
- total_footprint_bytes: ${formatBytes(measurement.total_footprint_bytes)}
- Electron process count without a project: ${measurement.noProjectProcessCount}
- Electron process count with a selected project: ${measurement.selectedProjectProcessCount} (limit 6) — ${gates.selectedProjectIdleProcessCount ? 'PASS' : 'FAIL'}
- Eager Codex App Server process while idle: ${gates.selectedProjectRuntimeIsolation ? 'absent — PASS' : 'present — FAIL'}
- Result: ${passed ? 'PASS' : 'FAIL'}

Package footprint is reported as evidence, not used as a pass/fail gate. The no-project run proves lazy project/Core startup; the selected-project run records the idle repository baseline.

The selected-project memory budget was rebaselined from the V4 400 MiB ceiling to 450 MiB after the permanent session-rotation, execution-kernel, inspection, conversation-projection, and project-structure layers were added. The larger ceiling is valid only together with the six-process ceiling and the fail gate for an eagerly started Codex App Server; this prevents the budget change from hiding runtime startup regressions.
`;
}
