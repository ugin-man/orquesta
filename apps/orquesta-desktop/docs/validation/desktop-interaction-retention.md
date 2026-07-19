# Orquesta Desktop Interaction Retention

Measured on 2026-07-19T04:11:52.904Z with the packaged Windows x64 app and the 35-agent fixture. Six identical batches exercised map pan, wheel zoom, native agent-detail open/close, Fit, and zoom controls. CDP garbage collection was used only for diagnosis, not to change product behavior.

| Sample | Total working set | Renderer | GPU | JS heap used | DOM counter | Live DOM | Event listeners |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline after 30s + GC | 348.92 MiB | 96.39 MiB | 110.56 MiB | 4.09 MiB | 1111 | 744 | 209 |
| batch 1 immediate | 408.14 MiB | 147.41 MiB | 117.76 MiB | 6.28 MiB | 1488 | 744 | 7551 |
| batch 1 after GC | 378.91 MiB | 118.97 MiB | 116.96 MiB | 4.65 MiB | 1111 | 744 | 209 |
| batch 2 immediate | 409.01 MiB | 147.82 MiB | 118.05 MiB | 5.78 MiB | 1483 | 744 | 7434 |
| batch 2 after GC | 384.90 MiB | 125.15 MiB | 116.61 MiB | 4.71 MiB | 1111 | 744 | 209 |
| batch 3 immediate | 411.54 MiB | 150.54 MiB | 117.82 MiB | 6.57 MiB | 1488 | 744 | 7590 |
| batch 3 after GC | 390.34 MiB | 130.30 MiB | 116.85 MiB | 4.80 MiB | 1111 | 744 | 209 |
| batch 4 immediate | 412.71 MiB | 150.79 MiB | 118.67 MiB | 6.82 MiB | 1483 | 744 | 7395 |
| batch 4 after GC | 391.91 MiB | 130.72 MiB | 117.94 MiB | 4.82 MiB | 1111 | 744 | 209 |
| batch 5 immediate | 413.91 MiB | 151.48 MiB | 119.45 MiB | 7.60 MiB | 1481 | 744 | 7550 |
| batch 5 after GC | 394.39 MiB | 133.00 MiB | 118.42 MiB | 4.84 MiB | 1111 | 744 | 209 |
| batch 6 immediate | 414.71 MiB | 151.21 MiB | 120.34 MiB | 7.02 MiB | 1476 | 744 | 7433 |
| batch 6 after GC | 395.88 MiB | 133.97 MiB | 118.74 MiB | 4.84 MiB | 1111 | 744 | 209 |
| recovery 1m | 387.75 MiB | 129.83 MiB | 117.11 MiB | 4.84 MiB | 1111 | 744 | 209 |
| recovery 1m after GC | 387.97 MiB | 130.07 MiB | 117.11 MiB | 4.84 MiB | 1111 | 744 | 209 |

- Final retained total working set: 39.05 MiB
- Working-set growth after the first warmed interaction batch: 9.06 MiB
- Final retained Renderer working set: 33.68 MiB
- Final retained GPU working set: 6.55 MiB
- Final retained JS heap after forced collection: 0.74 MiB
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

The process working set is reported separately from reachable JavaScript heap. Of the final 39.05 MiB increase, Renderer accounts for 33.68 MiB and GPU for 6.55 MiB; Main and network are slightly below baseline. Chromium may retain this reserved rendering/V8 capacity instead of returning it to Windows immediately. It is therefore honest to call the memory retained, but repeated batches plateau and post-GC heap, DOM nodes, listeners, and process count stay bounded. The evidence does not show unfinished interaction work or an accumulating product leak.
