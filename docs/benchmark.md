# Performance baseline

PLAN.md §6.5 gate: bulk parsing at least on par with `dicom-parser@1.8.21`.

## Recorded baseline — 2026-07-23

Machine: Windows 10, Node 24, local dev box. Workload: CT1_UNC explicit LE (526 KB) +
implicit LE + fragmented JPEG-LS encapsulated, parsed together per iteration; median of
100 iterations after 10 warmups (`tests/benchmark.test.ts`).

| Parser | median / iteration |
| --- | --- |
| `dicom-parser@1.8.21` (`parseDicom`) | 0.524 ms |
| fork, compat façade (`compat.parseDicom`) | **0.433 ms** (~17% faster) |

The compat number includes the façade conversion overhead; the core `parse()` alone is
faster still.

## How the gate runs

- `pnpm run bench` — runs both benchmark tests.
- CI runs an absolute-budget sanity check only (shared runners are too noisy for
  comparative benchmarks); the comparative fork-vs-legacy assertion (fork ≤ 1.25× legacy)
  runs on any non-CI machine with `pnpm run bench`.
- Re-record this file when the workload or hardware changes materially.
