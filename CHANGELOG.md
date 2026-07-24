# Changelog

All notable changes to this project are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The legacy 1.x history is
preserved in [legacy-CHANGELOG.md](./legacy-CHANGELOG.md).

## [Unreleased]

### Fixed

- A present-but-empty `(0008,0005)` now declares the default repertoire (PS3.5),
  distinct from an absent element: a nested item with an empty SpecificCharacterSet
  resets to the default instead of inheriting the parent charset, and an empty
  root declaration wins over the `charset.assume` option (review §3).
- The file meta group now honors a caller's `maxElements`/`maxDepth`, so a hostile
  group-2 amplification payload is bounded by a memory-constrained caller's limit
  rather than only the built-in default (review §3).
- `parse()` no longer throws when a speculative sequence fallback crosses
  `maxElements`: adding the single opaque fallback value is guarded like the
  salvage path, so the limit surfaces as a partial result with a `limit-exceeded`
  error on the next read instead of escaping the never-throws contract (review §3).
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

### Added

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

## [2.0.0-rc.1] — unreleased

The ground-up TypeScript rewrite. Highlights over `dicom-parser` 1.8.21:

### Added

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

### Changed

- Version lineage continues as 2.x; the 1.x API lives under `/compat`.
- Explicit big endian is read-only (retired by DICOM); the write path is little-endian.

## [2.0.0-alpha.0] — 2026-07-22

- Phase 0 scaffold: toolchain (TypeScript 7, tsdown, Vitest, ESLint 10), CI
  (Node 20/22/24), publish workflow (OIDC trusted publishing), SECURITY.md with private
  vulnerability reporting. No public API yet.
