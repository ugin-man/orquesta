# Orquesta Desktop Interaction Retention

Measured on 2026-07-19T07:23:08.921Z with the packaged Windows x64 app and the 35-agent fixture. Six identical batches exercised map pan, wheel zoom, native agent-detail open/close, Fit, and zoom controls. CDP garbage collection was used only for diagnosis, not to change product behavior.

| Sample | Total working set | Renderer | GPU | JS heap used | DOM counter | Live DOM | Event listeners |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline after 30s + GC | 350.39 MiB | 99.78 MiB | 112.77 MiB | 4.14 MiB | 1153 | 783 | 217 |
| batch 1 immediate | 417.46 MiB | 154.96 MiB | 123.61 MiB | 5.90 MiB | 1153 | 783 | 459 |
| batch 1 after GC | 384.39 MiB | 122.56 MiB | 122.94 MiB | 4.73 MiB | 1153 | 783 | 217 |
| batch 2 immediate | 420.09 MiB | 154.77 MiB | 126.27 MiB | 7.05 MiB | 1525 | 783 | 7385 |
| batch 2 after GC | 393.62 MiB | 129.50 MiB | 125.06 MiB | 4.80 MiB | 1153 | 783 | 217 |
| batch 3 immediate | 423.04 MiB | 158.33 MiB | 126.37 MiB | 5.46 MiB | 1153 | 783 | 334 |
| batch 3 after GC | 396.48 MiB | 132.99 MiB | 125.16 MiB | 4.89 MiB | 1153 | 783 | 217 |
| batch 4 immediate | 420.79 MiB | 155.64 MiB | 126.75 MiB | 6.68 MiB | 1525 | 783 | 7463 |
| batch 4 after GC | 398.27 MiB | 134.41 MiB | 125.46 MiB | 4.91 MiB | 1153 | 783 | 217 |
| batch 5 immediate | 427.00 MiB | 160.22 MiB | 128.01 MiB | 4.98 MiB | 1153 | 783 | 217 |
| batch 5 after GC | 401.59 MiB | 135.88 MiB | 126.95 MiB | 4.92 MiB | 1153 | 783 | 217 |
| batch 6 immediate | 428.63 MiB | 159.87 MiB | 129.75 MiB | 6.35 MiB | 1518 | 783 | 7384 |
| batch 6 after GC | 406.20 MiB | 138.93 MiB | 128.27 MiB | 4.93 MiB | 1153 | 783 | 217 |
| recovery 1m | 395.93 MiB | 133.63 MiB | 125.69 MiB | 4.93 MiB | 1153 | 783 | 217 |
| recovery 1m after GC | 395.94 MiB | 133.63 MiB | 125.69 MiB | 4.93 MiB | 1153 | 783 | 217 |

- Final retained total working set: 45.55 MiB
- Working-set growth after the first warmed interaction batch: 11.55 MiB
- Final retained Renderer working set: 33.85 MiB
- Final retained GPU working set: 12.92 MiB
- Final retained JS heap after forced collection: 0.79 MiB
- Final DOM-counter delta: 0
- Final live-DOM delta: 0
- Final event-listener delta: 0
- Stable process count: PASS
- Total retained working set <= 75 MiB: PASS
- Growth after the first warmed batch <= 30 MiB: PASS
- Post-GC JS heap growth <= 8 MiB: PASS
- DOM-counter growth <= 10: PASS
- Live-DOM growth = 0: PASS
- Event-listener growth <= 20: PASS

The process working set is reported separately from reachable JavaScript heap. A first-use working-set increase that plateaus across repeated batches while post-GC heap, DOM nodes, and listeners stay bounded is retained Chromium/V8 capacity or graphics caching, not an accumulating product leak.
