# Orquesta Desktop Interaction Retention

Measured on 2026-07-19T08:09:08.479Z with the packaged Windows x64 app and the 35-agent fixture. Six identical batches exercised map pan, wheel zoom, native agent-detail open/close, Fit, and zoom controls. CDP garbage collection was used only for diagnosis, not to change product behavior.

| Sample | Total working set | Renderer | GPU | JS heap used | DOM counter | Live DOM | Event listeners |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline after 30s + GC | 350.77 MiB | 99.84 MiB | 111.96 MiB | 4.17 MiB | 1153 | 783 | 217 |
| batch 1 immediate | 418.16 MiB | 156.10 MiB | 122.66 MiB | 6.60 MiB | 1227 | 783 | 1354 |
| batch 1 after GC | 383.78 MiB | 122.79 MiB | 121.58 MiB | 4.75 MiB | 1153 | 783 | 217 |
| batch 2 immediate | 413.80 MiB | 151.20 MiB | 123.11 MiB | 8.43 MiB | 1525 | 783 | 7463 |
| batch 2 after GC | 389.40 MiB | 128.59 MiB | 121.32 MiB | 4.82 MiB | 1153 | 783 | 217 |
| batch 3 immediate | 420.12 MiB | 156.66 MiB | 123.90 MiB | 7.04 MiB | 1530 | 783 | 7658 |
| batch 3 after GC | 395.29 MiB | 132.40 MiB | 123.34 MiB | 4.91 MiB | 1153 | 783 | 217 |
| batch 4 immediate | 420.96 MiB | 155.34 MiB | 126.22 MiB | 6.72 MiB | 1525 | 783 | 7463 |
| batch 4 after GC | 396.76 MiB | 133.09 MiB | 124.26 MiB | 4.93 MiB | 1153 | 783 | 217 |
| batch 5 immediate | 418.96 MiB | 154.53 MiB | 124.79 MiB | 7.04 MiB | 1523 | 783 | 7618 |
| batch 5 after GC | 397.71 MiB | 134.74 MiB | 123.32 MiB | 4.94 MiB | 1153 | 783 | 217 |
| batch 6 immediate | 424.68 MiB | 158.29 MiB | 126.61 MiB | 6.20 MiB | 1518 | 783 | 7423 |
| batch 6 after GC | 402.07 MiB | 136.51 MiB | 125.76 MiB | 4.94 MiB | 1153 | 783 | 217 |
| recovery 1m | 390.18 MiB | 130.86 MiB | 122.16 MiB | 4.94 MiB | 1153 | 783 | 217 |
| recovery 1m after GC | 390.12 MiB | 130.86 MiB | 122.10 MiB | 4.94 MiB | 1153 | 783 | 217 |

- Final retained total working set: 39.36 MiB
- Working-set growth after the first warmed interaction batch: 6.34 MiB
- Final retained Renderer working set: 31.03 MiB
- Final retained GPU working set: 10.14 MiB
- Final retained JS heap after forced collection: 0.77 MiB
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
