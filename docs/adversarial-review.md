# Adversarial review — 2026-07-23

A deep adversarial review of the Phase 1–4 code, run as five independent
reviewers each tasked to _break_ one subsystem and produce runnable repros,
with every high-severity finding independently reproduced before it was acted
on. The key premise: the same author wrote the code and the tests, so a green
suite proves only self-consistency — findings were verified against the DICOM
standard (PS3.5/PS3.10) and DCMTK (`dcmdump`/`dcmconv`) as external oracles.

Legend: **Fixed** (PR merged) · **Documented** (tracked below, not yet fixed).

## Fixed (high-severity)

### Writer — silent write corruption (PR #14)

- **W1 (critical)** — a defined-length value over `0xFFFF` under a short-form
  explicit VR (e.g. a large LUT written as `US`) encoded its length field as
  `length mod 65536` with **no error**; the internal `position === total`
  assert can't catch it because sizing uses the true byte count. The corrupt
  file even reparsed `ok=true`. `checkLengthField` now throws.
- **W6** — a VR not exactly 2 characters defeated header sizing; two such
  errors could cancel and emit a corrupt stream. `checkExplicitVr` now rejects.

### Tokenizer — silent data loss on malformed input (PR #15)

The attack surface SECURITY.md flags. All shared one root cause: child
constructs bounded by the whole stream rather than their enclosing
item/sequence, plus an incomplete delimiter-terminator set.

- **#1/#3/#7** — a stray/mis-set `FFFE,E00D`/`E0DD` was read as an element and
  the item swallowed every following root element to EOF. Delimitation items
  are now structural terminators at element boundaries in any item frame.
- **#4** — `scanUnknown` ate siblings to end-of-stream when its delimiter was
  missing; now bounded by `frame.bound`.
- **#5** — an item length overrunning its sequence pulled the sequence's
  siblings into the item; items are now bounded by their enclosing sequence.
- **#2** — a defined-length encapsulated BOT overrunning the value read the
  next element's bytes as offset entries; now bounded by the value end.
- **#6** — trailing padding after an early scan return surfaced as phantom
  elements; defined-length encapsulated now resumes exactly at the value end.

### Security — uncatchable OOM (PR #16)

The throw/hang halves of the "`parse()` never crashes" invariant held (800K
fuzz iterations, zero uncaught throws; all timing linear). The OOM half did not.

- **S1 (high)** — an undefined-length sequence of empty items allocated a full
  `DicomDataSet` + `Map` per 8-byte item (~50× heap; a 40 MB input → ~189 MB
  heap, `ok=true`). New `maxElements` cap (default 1,000,000) returns a
  `limit-exceeded` error with partial results; salvage is guarded so the unwind
  path can't re-throw.
- **S2 (high)** — the default inflate cap (1 GiB) plus `spliceInflated`'s
  second full-size copy let a sub-MB deflated file peak at ~2.75 GB. Default
  lowered to 256 MiB.
- **S3** — `spliceInflated` allocation wrapped → `DicomError`, not `RangeError`.

### Charset — wrong clinical text (PR #17)

Cross-checked against `dcmconv`.

- **C1 (high)** — JIS X 0212 (`ESC $ ( D`) decoded to `U+FFFD` + ASCII garbage
  because WHATWG `iso-2022-jp` lacks the 0212 escape; now framed as euc-jp SS3.
- **C2 (high)** — one decoder per inter-escape segment let a G0 escape wipe an
  active G1 designation (katakana/Cyrillic after a G0 switch → mojibake).
  Rewritten with separate G0/G1 registers, routing by byte range (GL→G0,
  GR→G1). All 12 PS3.5 Annex H/I/J vectors still pass.
- **C3** — `parseDA`/`parseTM` with `validate=true` false-accepted
  digit-prefixed garbage (`'120000.5x'` also mis-scaled the fraction);
  structural regexes now gate before the range checks.

### Diagnostics + compat (this PR)

- **W2/W3/W5** — duplicate tags, odd value lengths, and non-multiple-of-4 basic
  offset tables were accepted silently (`ok=true`, zero warnings), making
  serializability unpredictable. They now emit `duplicate-tag` / `odd-length` /
  `length-adjusted` warnings.
- **A2** — the compat façade's `pick()` routed every tag `< 0x00030000` to the
  meta dataset, so a group 0000/0001 element in the main dataset read back
  `undefined`; now routed only when the tag actually lives in meta.
- **A1/A3/A4/A5/A6** — added to the compat `divergences` doc block.

## Documented (lower-severity / infra — not yet fixed)

These are tracked for follow-up; none is a data-corruption or DoS risk.

- **W2 semantics** — duplicate tags still collapse to the last value (Map
  semantics, matching legacy); the warning makes it visible but round-trip of a
  duplicate-tag file is still lossy. A multimap model would be a larger change.
- **W7** — `serializeParsed` accepts a partial/`stopAt` parse and silently
  truncates output; consider requiring `result.ok` or an explicit opt-in.
- **C4** — `isProbableUtf8Mislabel` / `CharsetContext.singleByte` are exported
  but unwired (no UTF-8 mislabel promotion in the parse path). Either wire a
  `utf8MislabelPromote` option or drop the dead surface.
- **C5** — a multi-valued `ISO_IR 100\ISO 2022 IR 87` (invalid but seen in the
  wild) degrades to whole-value Latin-1; DCMTK normalizes `ISO_IR xxx` →
  `ISO 2022 IR xxx`. Aliasing would recover these.
- **Test infrastructure (B1, highest)** — the 199-file legacy differential, the
  `dcmdump` writer-acceptance suite, and the benchmark all `skipIf` in CI
  (hardcoded local corpus / chocolatey paths). CI runs only `test:coverage` on
  ubuntu, so those acceptance gates never run in CI. Vendoring a small
  multi-configuration corpus subset + a DCMTK container would close this.
- **Test depth (B2/B3/B4)** — the differential comparator is shallow (VR only
  when both define it; leaf offsets only; 6 tag values); the sample corpus is a
  JPEG2000 monoculture (no implicit/BE/deflated/charset files); and the
  from-model numeric writers (SS/SL/FL/FD/OD) plus `createJpegBasicOffsetTable`
  multi-frame loop have thin coverage (the byte-identical round trip copies raw
  bytes, so it can't exercise from-model number encoding).

## Reproduction

Per-subsystem repros were written to the session scratchpad during the review
(`rev-tokenizer/`, `rev-security/`, `rev-writer/`, `rev-charset/`,
`rev-compat/`) and each fixed finding now has a regression test in the suite
(search the test files for the review IDs, e.g. `review #1-#7`, `S1/S2/S3`,
`C1/C2/C3`, `W1/W6`).
