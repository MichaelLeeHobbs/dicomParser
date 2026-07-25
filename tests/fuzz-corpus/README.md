# Fuzz crash-regression corpus

Every file here is an input that must parse without throwing. `tests/fuzz.test.ts`
replays all of them — and every truncation of each — on every run, so a fixed
crash cannot silently come back.

## Curated seeds

Reproduce with `node scripts/generateFuzzSeeds.mjs tests/fuzz-corpus`:

| Seed                                         | Why it is here                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `encapsulated-undefined-length-fragment.bin` | fork #67 — a fragment item with a `0xFFFFFFFF` length                  |
| `nonzero-sequence-delimiter-length.bin`      | upstream #266 — a delimitation item whose length field is `0xFFFFFFFF` |
| `sequence-item-overruns-eof.bin`             | a defined-length item declaring far past end of data                   |
| `truncated-meta-group.bin`                   | the file meta group cut mid-value                                      |
| `value-length-overruns-eof.bin`              | an element length overrunning end of data                              |
| `corrupt-deflate-stream.bin`                 | a bit-flipped deflate payload under the deflated transfer syntax       |
| `empty.bin`, `prefix-only.bin`               | degenerate inputs (no bytes; `DICM` with nothing after it)             |

## Adding a counterexample

The nightly job (`.github/workflows/fuzz.yml`) runs with `FUZZ_ARTIFACT_DIR`
set, so a failing input is uploaded as a `fuzz-counterexamples` artifact.
Download it, drop the `.bin` into this directory, and commit it with the fix —
never a bare seed number, which does not survive a generator change.

Report the underlying defect privately (SECURITY.md), not in a public issue.
