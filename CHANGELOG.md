# Changelog

All notable changes to this project are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The legacy 1.x history is
preserved in [legacy-CHANGELOG.md](./legacy-CHANGELOG.md).

## [Unreleased]

Start of the 2.1 line (`2.1.0-alpha.0` on `master`). 2.0.0 final will be cut
from the `v2.0.0-rc.3` tag once the downstream soak passes.

### Added

- `parsePartial` / `parsePartialAsync`: classify a byte prefix as `complete`,
  `needMoreBytes`, or `malformed` — distinguishing truncation from corruption on
  partial buffers (#34). The `needMoreBytes` arm carries `{ offset, totalNeeded }`
  where `totalNeeded` is the smallest total input length that could let parsing
  advance (sized from declared lengths; derived from untrusted input — cap it),
  so an ingest loop's follow-up read is sized, not guessed, and re-calling with
  `totalNeeded` bytes always makes progress. This also resolves the truncation
  asymmetry where a truncated defined-length value looked `ok` with only a
  warning while a truncated header failed: under `parsePartial` both are
  `needMoreBytes`. Interior anomalies (bounded by declared lengths inside the
  input) are tolerated exactly as `parse` tolerates them; the tolerant `parse`
  behavior is unchanged. Truncation of a deflated payload itself is not
  distinguishable and reports `malformed`.
- `ByteStream` gained a `strictEof` option and `DicomError` a `totalNeeded`
  field (truncation evidence) plus a `truncated` code, supporting the above.

## [2.0.0-rc.3] — 2026-07-24

A correctness fix for `parseHeadAsync` on malformed encapsulated PixelData, found
while adopting rc.2 in `@ubercode/dcmtk` (dcmtk.js).

### Fixed

- `parseHeadAsync` no longer breaks head/full identity on malformed encapsulated
  PixelData. The fragment hop was lenient — it treated an undefined-length
  (`0xFFFFFFFF`) fragment item as length 0 and kept scanning, accepted any tag as
  a fragment, and clamped a truncated chain to EOF in silence — so `HeadResult.ok`
  could be `true` for a file `parse()` rejects. The hop is now a strict recognizer
  of the exact no-warning happy path (a `FFFE,E000` basic offset table that is a
  multiple of 4, defined-length `FFFE,E000` fragments within bound, a zero-length
  `FFFE,E0DD` terminator); anything else falls back to the tokenizer-backed copy
  path, so the head result reproduces the whole-file parse's ok/warnings/error
  exactly. Well-formed streams still fast-skip by hopping item headers (#67).

## [2.0.0-rc.2] — 2026-07-24

Post-rc.1 field-review follow-up: the bounded head-read API that unblocks the
`@ubercode/dcmtk` (dcmtk.js) swap, plus the `/compat` surface it needs.

### Added

- **Bounded / streaming head-read** (`parseHeadAsync`): parses a Part-10 file's
  metadata over a `RangeReader` (`{ read(offset, length), size }` — an in-memory
  buffer, an `fs` descriptor, or S3 ranged GETs) while **skipping bulk value bytes**
  (PixelData and other OB/OW/OD/OF/OL/OV values, plus explicit UN and vrLookup-bulk
  implicit values). Skipped values are reported in `HeadResult.bulk` as
  file-absolute ranges to fetch on demand; every other element parses exactly as a
  whole-file `parse`. ~83% fewer bytes read across the fixture corpus (98%+ on
  pixel-data-dominant files). Deflated transfer syntax is read whole (not seekable).
  The core home for dcmtk.js's bounded head-read (fork #59; unblocks the swap, #58).
  Each `BulkRange` also carries the VR the walker saw (`vr` — explicit from the
  file, or `vrLookup`'s answer for implicit) and an `encapsulated` flag, so a
  consumer can reconstruct a skipped element's JSON (`{ vr }`, DCMTK-normalizing
  encapsulated PixelData to `OB`) without re-reading the header bytes (#64).
- `readPart10Header` (and `Part10Header`) are now exported from `/compat` and the
  `dicomParser` namespace. Note it returns the **core `Part10Header`**
  (`dataSetPosition`/`transferSyntax`/`meta`), not v1's meta `DataSet` — a
  deliberate shape divergence documented in `docs/migration-v1.md` (#58).

## [2.0.0-rc.1] — 2026-07-24

The ground-up TypeScript rewrite over `dicom-parser` 1.8.21, plus the post-rewrite
field-review and DCMTK-comparison hardening pass.

### Changed

- **Breaking (vs alpha):** the core `stopAt.inclusive` default is now `false`
  (exclusive). A metadata fast path (`parse(bytes, { stopAt: { tag: PixelData } })`)
  no longer parses the triggering element when the flag is omitted; pass
  `inclusive: true` to include it. The v1 `/compat` façade pins `true`, so v1
  fidelity is unaffected (review §3).

### Added

- `isValidUid(value)` — validates a UID against the PS3.5 §9.1 grammar
  (dot-separated leading-zero-free numeric components, length 1–64). Stricter than
  a `[0-9.]` check: rejects empty components, leading/trailing dots and leading
  zeros — relevant when UIDs are used as filesystem/object-store keys (field
  review W7).
- `DicomDataSet.strings` / `floatStrings` / `intStrings` — bulk multi-value
  accessors that return every backslash-separated value at once, so a VM > 1 read
  no longer loops an index (field review W13).
- `isDicomError(value)` — a duck-type guard (exported) that is robust across the
  dual ESM/CJS build, where `instanceof DicomError` can fail. `parse`/`parseAsync`
  use it internally for the injected-inflater return-vs-rethrow decision (review §3).
- `TAG_SPECIFIC_CHARACTER_SET` is now re-exported from the package index (review §3).

- A header-only benchmark (`stopAt` / `untilTag` over a header-dense file, fork vs
  legacy) — the production hot path the bulk parse bench did not exercise
  (review D5). `docs/benchmark.md` corrected: CI runs no benchmarks (all are
  `BENCH=1`-gated).
- `serializeParsed` now accepts `{ allowPartial }` and refuses (typed
  `invalid-argument`) a failed, `stopAt`-terminated, or truncation-warned parse
  by default, so it can no longer silently emit a truncated file (review W7).
- `ParseOptions.utf8MislabelPromote` — decode values detected as mislabeled
  UTF-8 under a single-byte charset as UTF-8; a `utf8-mislabel` warning is
  emitted regardless (review C4). Exported `isCharsetAffectedVr`.
- A bare `ISO_IR n` term in a code-extension `SpecificCharacterSet` is
  normalized to `ISO 2022 IR n` (DCMTK-compatible) with a `nonstandard-charset`
  warning (review C5).
- CI now runs the acceptance oracles: the fork-vs-`dicom-parser@1.8.21`
  differential over the in-repo corpus, and a DCMTK `dcmdump` writer-acceptance
  job (review B1). Deepened differential comparator; from-model numeric-writer
  round-trip coverage (review B2/B3/B4).
- A **DCMTK `dcm2xml` read differential** as an independent CI oracle: the fork is
  compared element-for-element against DCMTK's XML dump over the corpus (tag set,
  byte length, VR, string/integer values). `dcm2xml` is used deliberately over
  `dcm2json` (which transcodes charsets and hangs on compressed pixel data). Runs
  in the DCMTK acceptance job under `REQUIRE_DCMTK=1`.

### Fixed

- ISO 2022 code extensions now reset the G0/G1 designations to the initial state at
  a value/line delimiter (`\`, `HT`, `LF`, `FF`, `CR`) when a single-byte charset is
  active, so a non-conformant value that omits its reset escape no longer leaks a
  designated single-byte set (e.g. Cyrillic) into the next value. Suppressed while a
  multi-byte G0 set (JIS X 0208/0212) is active, where a `0x5C` is a character byte —
  matching DCMTK's `checkDelimiters` (`dcspchrs.cc`; PS3.5 C.12.1.1.2).
- Encapsulated pixel data wrongly closed by an item delimiter (`FFFE,E00D`) instead
  of a sequence delimiter (`FFFE,E0DD`) no longer surfaces the stray delimiter as a
  phantom zero-length fragment; it terminates the pixel sequence cleanly with a
  `missing-sequence-delimiter` warning (parity with the sequence path and DCMTK's
  `EC_ItemEnd` handling).
- An unrecognized explicit VR consisting of two uppercase letters is now read with
  the 4-byte extended-length form (a _future_ VR) instead of the 2-byte short form.
  The DICOM committee reserved all future VRs to the extended-length form, so the
  old short-form assumption would mis-read the length field of any future long-form
  VR and derail the rest of the stream. Other unrecognized codes keep the 2-byte
  form. Matches DCMTK (`DcmVR::setVR` → `EVR_UNKNOWN`/`EVR_UNKNOWN2B`).
- An undefined-length sequence closed by an item delimiter (`FFFE,E00D`) instead
  of a sequence delimiter (`FFFE,E0DD`) — a known scanner quirk — now recovers and
  keeps reading the rest of the stream (with a `missing-sequence-delimiter`
  warning) instead of derailing into a `malformed` error and dropping every
  element after the sequence. Matches DCMTK's `dcmReplaceWrongDelimitationItem`
  behavior (verified against DCMTK `dcmdata` source).
- `package.json` `exports` now nests `types` under the `import`/`require`
  conditions, so CJS TypeScript consumers resolve the emitted `.d.cts` files
  instead of the ESM-flavored `.d.ts` (fixes TS1479 "masquerading as ESM"). An
  `attw` (`@arethetypeswrong/cli`) check is wired into CI and `prepublishOnly`
  (review D3).
- `engines.node` raised to `>=20.16`: the synchronous inflate path needs
  `process.getBuiltinModule` (Node ≥ 20.16), so deflated files fail with
  `no-inflater` on 20.0–20.15 despite zlib existing (review §3).
- Corrected the deflate-bomb default-cap documentation (TSDoc + README) to 256 MiB
  to match `DEFAULT_MAX_INFLATED_BYTES`; a test now pins the value (review §3).
- The `/compat` façade's `version` now tracks the package `VERSION` instead of a
  hardcoded `'2.0.0'` that would drift each release (review §3).
- The file meta group now carries a default charset context, so meta string reads
  use the fast decode path instead of the per-byte fallback (review §3).
- `writeFile` now rejects a transfer-syntax / pixel-data mismatch: encapsulated
  (fragmented) pixel data requires a compressed transfer syntax, and native pixel
  data requires a native one. A tag-morph flow (parse a JPEG, `modifyDataSet`,
  `writeFile` defaulting to Explicit LE) can no longer silently emit a
  non-conformant file with fragments under a native syntax (review D2).
- `nativePixelDataView` now byte-swaps 16-bit big-endian pixel data to host order
  instead of returning byte-swapped samples for Explicit VR Big Endian files
  (review §3).
- `createJpegBasicOffsetTable`'s end-of-image probe no longer reads before a
  fragment's start for fragments shorter than 2 bytes (review §3).
- A present-but-empty `(0008,0005)` now declares the default repertoire (PS3.5),
  distinct from an absent element: a nested item with an empty SpecificCharacterSet
  resets to the default instead of inheriting the parent charset, and an empty
  root declaration wins over the `charset.assume` option (review §3).
- The file meta group now honors a caller's `maxElements`/`maxDepth`, so a hostile
  group-2 amplification payload is bounded by a memory-constrained caller's limit
  rather than only the built-in default (review §3).
- `parse()` no longer throws when a speculative sequence fallback crosses
  `maxElements`: the `limit-exceeded` raised while adding the opaque fallback value
  is caught at `run()`'s recovery call site and surfaced as a partial-result error
  — even when the fallback is the last element read — instead of escaping the
  never-throws contract or being silently suppressed (review §3 + Copilot review).
- Undefined-length encapsulated pixel data nested in a sequence item is now
  bounded by its enclosing item, not the whole stream — a missing `FFFE,E0DD` can
  no longer make the fragment scan swallow a following sibling's bytes (review §3).
- A defined-length sequence item ending at its exact bound no longer consumes an
  ancestor's item-delimitation item (`FFFE,E00D`). The bound-completion check now
  runs before the delimiter peek, so a conformant nested structure (a
  defined-length item flush against an enclosing undefined-length item's
  delimiter) can no longer be mis-tokenized into structural corruption — one item
  swallowing its sibling, with data misattributed and only soft warnings (MedFusion
  field review D1).

### Added (the rewrite baseline)

- **DICOM writing** (upstream #214's top ask): `writeFile`, `encodeDataSet`,
  `serializeParsed` (byte-identical round trips for conformant LE files),
  `modifyDataSet` edit model, generated file meta group with correct group length,
  deflated output.
- **Discriminated-union element model** (`kind: 'value' | 'sequence' | 'encapsulated' |
'unknown'`) with exact byte accounting (`startOffset`/`dataOffset`/`endOffset`) — #257/#278.
- **Typed errors with partial results**: `parse()` returns a `ParseResult`; failures carry
  a `DicomError` plus everything parsed before the failure — #46/#203/#277.
- **SV/UV/OV support** with BigInt accessors — fixes the #280/#281 parse derailment.
- **Charset-aware strings**: SpecificCharacterSet incl. ISO 2022 CJK escape walking,
  decode-then-split, `charset: { assume, fallback }` options — #146.
- **CP-246**: `UN` + undefined length as implicit SQ; `UN` + defined length via
  `vrLookup` returning `'SQ'`, with safe binary fallback — #141/#114/#245.
- **TS-driven encapsulation detection** for defined-length pixel data — #59/#60.
- **`stopAt` with ≥ semantics** and `inclusive` control — #104/#268/#52.
- **Headerless dataset parsing** via `transferSyntax` — #48.
- **Modern inflate strategy**: `node:zlib` / `DecompressionStream('deflate-raw')` /
  injected inflater; deflate-bomb cap (`maxInflatedBytes`) — #270/#125/#109.
- **Pixel-data helpers**: `readEncapsulatedImageFrame`,
  `readEncapsulatedPixelDataFromFragments`, `createJpegBasicOffsetTable`,
  `nativePixelDataView` — #73/#264 ergonomics.
- **v1 compat façade** (`@ubercode/dicom-parser/compat`): the upstream API surface,
  validated tag-for-tag against `dicom-parser@1.8.21` across a 199-file corpus.
- **Fuzz suite** (fast-check): arbitrary bytes, corpus mutation, hostile deflate,
  random element streams — #282 posture; ESM+CJS dual build, Node test suite — #270/#252.

### Fixed (relative to 1.8.21)

- Delimitation items no longer surface as dataset elements — #244/#143.
- Non-zero delimitation-item lengths are tolerated (warning) instead of crashing — #266.
- Misdetected implicit sequences fall back to opaque values instead of derailing the
  file — #114.
- `string()` no longer truncates at embedded NUL bytes — #146.
- Indexed `attributeTag` for multi-valued AT — #253.
- Indexed accessor reads are bounds-checked against the element length.

### Changed (the rewrite baseline)

- Version lineage continues as 2.x; the 1.x API lives under `/compat`.
- Explicit big endian is read-only (retired by DICOM); the write path is little-endian.

## [2.0.0-alpha.0] — 2026-07-22

- Phase 0 scaffold: toolchain (TypeScript 7, tsdown, Vitest, ESLint 10), CI
  (Node 20/22/24), publish workflow (OIDC trusted publishing), SECURITY.md with private
  vulnerability reporting. No public API yet.
