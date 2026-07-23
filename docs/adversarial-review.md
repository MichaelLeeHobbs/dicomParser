# Adversarial review — 2026-07-23

A deep adversarial review of the Phase 1–4 code, run as five independent
reviewers each tasked to _break_ one subsystem and produce runnable repros,
with every high-severity finding independently reproduced before it was acted
on. The key premise: the same author wrote the code and the tests, so a green
suite proves only self-consistency — findings were verified against the DICOM
standard (PS3.5/PS3.10) and DCMTK (`dcmdump`/`dcmconv`) as external oracles.

Legend: **Fixed** (PR merged) · **Documented** (deliberately not fixed).
All findings are now either fixed or documented-by-design — see the follow-up
round below (PRs #20–#23) for the second pass that closed the remaining items.

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

### Follow-up round (fixed 2026-07-23, PRs #20–#23)

A second design → implement → adversarial-verify pass (three of the four fixes
delegated to worktree-isolated agents, then verified by four reviewers that
each reproduced a real gap before merge):

- **W7 (#20)** — `serializeParsed` silently truncated when handed a partial or
  `stopAt` parse. Now refuses (typed `invalid-argument`) unless
  `{ allowPartial: true }`. The verify pass found the first cut missed
  warning-only truncation (a value clamped at EOF, `ok=true`); the guard now
  also refuses `unexpected-eof` / `missing-item-delimiter` /
  `missing-sequence-delimiter` / `length-adjusted` while letting benign
  `duplicate-tag` / `odd-length` through.
- **C4 (#23)** — the `isProbableUtf8Mislabel` / `singleByte` surface is wired:
  parse-time detection over charset-affected VRs under single-byte contexts,
  one `utf8-mislabel` warning per tag, opt-in `utf8MislabelPromote` consulted by
  the lazy decoder via a per-dataset promoted set. Detection is always-on,
  promotion off by default. Known limitation (documented in the option's
  TSDoc): the heuristic is ambiguous for short all-caps single-byte values
  (e.g. Cyrillic `ЮГ` is also valid UTF-8) — kept the proven dcmtk.js heuristic
  rather than a length floor that would miss legitimately short mislabeled
  names; promotion opt-in means the default cost is only an advisory warning.
- **C5 (#23)** — a bare `ISO_IR n` in a code-extension value is normalized to
  `ISO 2022 IR n` (DCMTK behavior, PS3.5 C.12.1.1.2), membership-gated so
  single-valued terms are untouched; a `nonstandard-charset` warning (deduped
  per value) records it.
- **B1 (#22)** — the acceptance oracles now run in CI: the fork-vs-`1.8.21`
  differential runs against the in-repo `testImages/` in the default job, and a
  new `acceptance` job apt-installs DCMTK and runs the `dcmdump` writer gate
  with `REQUIRE_DCMTK=1` (a missing binary fails red, not green-by-skip). Paths
  are env-configurable (`DCMDUMP`, `DICOM_DIFF_CORPUS`); the 198-file external
  corpus stays a local deep gate.
- **B2/B3 (#22)** — the differential comparator is deepened (iterative;
  recurses items, compares fragment offset/position/length, the full basic
  offset table, VR wherever legacy defines it, and leaf value bytes) and now
  runs against the diverse in-repo corpus (BE/implicit/deflated/encapsulated).
  Verify pass caught deflated files getting smoke-only coverage (legacy needs a
  Buffer, not a Uint8Array); they now deep-compare at the value-accessor level
  (legacy's A3 preamble re-parse precludes a tag-for-tag compare there).
- **B4 (#21)** — from-model numeric writers (SS/SL/FL/FD/OD/OF/OW/OL/OB/AT/
  SV/UV, explicit and implicit) now have byte-exact round-trip tests (the
  byte-identical corpus round-trip copies raw bytes, so it never exercised
  them), plus `createJpegBasicOffsetTable` multi-frame and implicit
  `scanUnknown`-via-`vrLookup` coverage. Coverage rose to 96.5/94.2/98.0/96.6.

## Documented (deliberately not fixed)

- **W2 semantics** — duplicate tags collapse to the last value (Map semantics,
  matching legacy `dicom-parser`, which the compat façade must mirror). The
  `duplicate-tag` warning makes it visible; round-trip of a duplicate-tag file
  is still lossy. A multimap model would break the v1 one-element-per-tag
  contract (and the 198-file differential) for a non-conformant edge case, so
  this is left as-is by design. A strict-reject option could be added on request.
- **C4 heuristic** — see above; the short-value UTF-8/single-byte ambiguity is
  inherent and documented rather than papered over.

## Reproduction

Per-subsystem repros were written to the session scratchpad during the review
(`rev-tokenizer/`, `rev-security/`, `rev-writer/`, `rev-charset/`,
`rev-compat/`) and each fixed finding now has a regression test in the suite
(search the test files for the review IDs, e.g. `review #1-#7`, `S1/S2/S3`,
`C1/C2/C3`, `W1/W6`).
