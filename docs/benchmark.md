# Performance baseline

PLAN.md §6.5 gate: bulk parsing at least on par with `dicom-parser@1.8.21`.

## Recorded baseline — 2026-07-23

Machine: Windows 10, Node 24, local dev box. Workload: CT1_UNC explicit LE (526 KB) +
implicit LE + fragmented JPEG-LS encapsulated, parsed together per iteration; median of
100 iterations after 10 warmups (`tests/benchmark.test.ts`).

| Parser                                    | median / iteration         |
| ----------------------------------------- | -------------------------- |
| `dicom-parser@1.8.21` (`parseDicom`)      | 0.524 ms                   |
| fork, compat façade (`compat.parseDicom`) | **0.433 ms** (~17% faster) |

The compat number includes the façade conversion overhead; the core `parse()` alone is
faster still.

## Header-only workload (the production hot path)

The bulk numbers above are dominated by a single O(1) seek over each file's pixel payload,
so they say little about header extraction — which is the real ingest hot path
(`parse(bytes, { stopAt })` / `parseDicom(bytes, { untilTag })` on every C-STORE). Measured
over a synthetic header-dense file (400 small elements + a 512 KB pixel element; median of
200):

| Path                                              | median / iteration |
| ------------------------------------------------- | ------------------ |
| fork core (`parse`, `stopAt` PixelData exclusive) | **~0.13 ms**       |
| `dicom-parser@1.8.21` (`untilTag`)                | ~0.21 ms           |
| fork compat façade (`untilTag`)                   | ~0.23 ms           |

Core `parse` beats legacy on header extraction; the compat façade is slightly slower than
legacy because it also converts the tree to v1 shapes — adopt the core API on the hot path
(see `docs/migration-v1.md`). `stopAt` ≈ full parse for this file because the only thing
past the stop tag is one O(1)-seek element.

## How the gate runs

- `pnpm run bench` — runs every benchmark test (sets `BENCH=1`).
- **CI does not run the benchmarks.** All benchmark assertions are gated behind `BENCH=1`
  (shared runners and v8 coverage are too noisy for timing), so they run only under
  `pnpm run bench` on a non-CI machine. Correctness on the fixtures is covered by
  `tests/fixtures.test.ts`; these tests are a local regression tripwire, not a CI gate.
- Re-record this file when the workload or hardware changes materially.
