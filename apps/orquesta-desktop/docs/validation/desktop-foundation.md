# Orquesta Desktop Foundation Validation

Measured on 2026-08-07T02:31:50.569Z using the packaged Windows x64 application.

- Executable: `C:\Users\example\OneDrive\ドキュメント\Orquesta\.worktrees\release-candidate\apps\orquesta-desktop\out\Orquesta-win32-x64\Orquesta.exe`
- Input isolation: native mouse input disabled before idle timing
- Cold start: 752 ms (limit 4000 ms) — PASS
- No-project idle working set: 330.11 MiB after 60 seconds (limit 400 MiB) — PASS
- Selected-project idle working set: 416.57 MiB after 60 seconds (limit 450 MiB) — PASS
- ui_core_footprint_bytes: 313.40 MiB
- codex_runtime_footprint_bytes: 390.28 MiB
- total_footprint_bytes: 703.68 MiB
- Electron process count without a project: 5
- Electron process count with a selected project: 6 (limit 6) — PASS
- Eager Codex App Server process while idle: absent — PASS
- Result: PASS

Package footprint is reported as evidence, not used as a pass/fail gate. The no-project run proves lazy project/Core startup; the selected-project run records the idle repository baseline.

The selected-project memory budget was rebaselined from the V4 400 MiB ceiling to 450 MiB after the permanent session-rotation, execution-kernel, inspection, conversation-projection, and project-structure layers were added. The larger ceiling is valid only together with the six-process ceiling and the fail gate for an eagerly started Codex App Server; this prevents the budget change from hiding runtime startup regressions.
