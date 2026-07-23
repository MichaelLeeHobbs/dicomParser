# Porting Notes — knowledge transfer for the rewrite

Everything a fresh session needs that is not obvious from the legacy source. Compiled 2026-07-22
from the `@ubercode/dcmtk` `dicom2json` project (which shipped a production JSON-model layer on
top of `dicom-parser@1.8.21`) and from the Phase 0 scaffold work.

## Legacy module map (`legacy/`, ~2,550 lines)

| Legacy module                                                                                              | Role                                        | Rewrite notes                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `byteArrayParser.js`, `littleEndianByteArrayParser.js`, `bigEndianByteArrayParser.js`                      | endian-specific primitive reads             | Replace with `DataView`-based readers; one implementation, endianness as parameter                                                           |
| `byteStream.js`                                                                                            | position-tracked reader over the byte array | Keep the concept; add transfer-syntax awareness (upstream PR #60 idea)                                                                       |
| `readTag.js`                                                                                               | tag → `'xggggeeee'` string                  | Decide tag representation early (see below)                                                                                                  |
| `readDicomElementExplicit.js` / `readDicomElementImplicit.js`                                              | element readers                             | The explicit reader's `getDataLengthSizeInBytesForVR` long-form list is missing SV/UV/OV — the #281 corruption bug lives here                |
| `readSequenceElementExplicit/Implicit.js`, `readSequenceItem.js`                                           | SQ parsing                                  | Source of the delimiter-leakage bugs (#244/#143); rewrite consumes delimiters structurally                                                   |
| `findAndSetUNElementLength.js`, `findItemDelimitationItem.js`                                              | UN/undefined-length scanning                | CP-246 handling (#141) replaces ad-hoc UN scanning                                                                                           |
| `readEncapsulatedPixelData*.js`, `findEndOfEncapsulatedPixelData.js`, `util/createJPEGBasicOffsetTable.js` | encapsulated pixel data + fragments/BOT     | Keep fragment/BOT model; add TS-driven encapsulation detection (#59)                                                                         |
| `readPart10Header.js`                                                                                      | preamble/DICM/meta group                    | Meta is always explicit LE; tolerate missing preamble; `TransferSyntaxUID` option for headerless (#48)                                       |
| `parseDicom.js`                                                                                            | entry: header → dataset, deflate branch     | Deflate: `node:zlib` (Node) / `DecompressionStream('deflate-raw')` (browser) / injected inflate — kills the pako global-sniffing (#270/#125) |
| `dataSet.js`                                                                                               | accessors (`string`, `uint16`, …)           | Becomes the v1 compat façade in Phase 4; new core exposes the discriminated-union model                                                      |
| `alloc.js`, `sharedCopy.js`                                                                                | buffer helpers                              | Mostly obsolete with `Uint8Array.prototype.subarray`                                                                                         |
| `util/*` (`parseDA`, `parseTM`, `elementToString`, `dataSetToJS`)                                          | conveniences                                | Port `parseDA`/`parseTM` with tests; reconsider the rest                                                                                     |

## Legacy behaviors: preserve vs. fix

Learned by building and differential-testing dcmtk.js's `_p10ToJson` against 198 real files:

**Preserve (v1 compat façade must match):**

- `elements` keyed `'x' + 8 lowercase hex` (`x00100010`).
- `element.vr` present only when explicit (or supplied by `vrCallback` for implicit).
- `vrCallback(tag)` receives the `'xggggeeee'` tag; its return is stored as the element VR and
  influences implicit SQ detection.
- `inflater(byteArray, position)` contract: receives full file bytes + offset where deflated data
  begins; returns header-bytes + inflated concatenated.
- `dataSet.string()` trims trailing whitespace.
- Undefined-length elements get `hadUndefinedLength: true`; encapsulated pixel data gets
  `items` + `fragments` + `basicOffsetTable`.

**Fix in the core (documented divergences for the façade):**

- Explicit-VR SV/UV/OV mis-tokenized (short-form length read → parse derailment) — upstream #281.
- FFFE,E00D item delimiters surface as elements inside undefined-length items (dcmtk.js filters
  group FFFE as a workaround in `_p10ToJson.ts` — the fork fixes it at the source).
- Delimitation items must be treated as zero-length regardless of encoded length (#266).
- `string()` truncates at the first 0x00 byte — wrong for multi-byte charsets (#146).
- `untilTag` exact-match (#104) → `stopAt` with ≥ semantics.
- Thrown strings/objects → typed errors with partial datasets.
- Private implicit elements heuristically parsed as SQ (#114) → dictionary/callback-gated only.
- Real-file quirk to handle: encapsulated pixel data written with explicit VR `OW` — normalize to
  OB (DCMTK does the same; seen in dcmtk.js's `ttfm.dcm` sample).

## Assets to port from `@ubercode/dcmtk` (repo: `C:\Users\mhobb\WebstormProjects\dcmtk.js`)

| Asset                                        | Path (in dcmtk.js)                                                           | Use here                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Charset decoder + PS3.5 Annex H/I/J fixtures | `src/tools/_charset.ts`, `src/tools/_charset.test.ts`                        | Port into core (backlog item 4). Covers all single-byte ISO_IR sets, UTF-8, GB18030/GBK, Shift_JIS, ISO 2022 escape walking (JP IR 13/87, KR IR 149, CN IR 58). Note: JIS X 0201 katakana correctly decodes to HALFWIDTH forms (`ﾔﾏﾀﾞ`) — not a bug. Decode-then-split avoids delimiter-byte collisions in multi-byte encodings. |
| Synthetic P10 builder                        | `test/helpers/p10.ts`                                                        | Port as a test utility (explicit/implicit, LE/BE, defined-length SQ, encapsulated, deflated, meta group with correct group length)                                                                                                                                                                                               |
| Differential + perf integration suite        | `test/integration/tools/dicom2json.integration.test.ts`                      | External acceptance gate at Phase 4: dcmtk.js swaps `dicom-parser` → this fork's compat façade and its 198-file DCMTK differential must stay green                                                                                                                                                                               |
| Sample corpus                                | `dicomSamples/` (198 good files + `bad/`)                                    | Do NOT copy into this repo (size/PHI hygiene) — reference cross-repo for local differential runs; `testImages/` here covers CI                                                                                                                                                                                                   |
| Tag dictionary                               | `src/data/dictionary.json` (4,902 entries) + `scripts/generateDictionary.ts` | The fork core stays dictionary-free (consumer supplies VR lookup, as upstream's `vrCallback`); dcmtk.js keeps supplying its dictionary. Revisit only if CP-246 UX demands a built-in minimal SQ list.                                                                                                                            |

`testImages/` (retained from upstream, in this repo) includes explicit-BE/LE, implicit-LE, and
deflated variants of CT1_UNC — enough for CI-level fixture tests without the external corpus.

## Tag representation decision (make early, Phase 1)

Legacy uses `'xggggeeee'` strings everywhere. Candidates for the core: numeric
`(group << 16) | element` (fast compares, needed for `stopAt` ≥), branded string, or a small
struct. Recommendation: numeric internally, formatted strings at API boundaries; the compat
façade re-exposes `'xggggeeee'`.

## Differential-testing caveats (so you don't chase ghosts)

- dcm2xml (DCMTK) **renumbers private tag blocks** in its XML output and omits group 0002 —
  when comparing against DCMTK, exclude private (odd-group) tags and group 0002, or compare via
  `dcmdump` instead (which reports true tags).
- FL comparisons need a relative epsilon (~1e-5) — float32→decimal→float64 round-trips differ.
- npm `latest` currently points at `2.0.0-alpha.0` (npm forces `latest` on a package's first
  publish); self-corrects at `2.0.0` final.

## Toolchain gotchas (already encoded in the scaffold; do not "fix" them back)

- typescript-eslint does not support TS 7.0 (no stable API until TS 7.1 — their issue #10940).
  `typescript@^6` is installed for tooling; `ts7` (aliased `typescript@7.0.2`) drives
  `pnpm run typecheck`. Flip to a single TS 7.1+ once typescript-eslint supports it.
- tsdown on Node 20 needs the `unrun` devDep to load `tsdown.config.ts` (Node 22+ is native).
- `tsconfig.json` needs `"types": ["node"]` under bundler resolution or `node:*` imports fail.
- pnpm version comes from `packageManager` ONLY — adding `version:` to pnpm/action-setup in
  workflows makes the action error out.
- Config files (`*.config.ts`) are deliberately outside `tsconfig.json`'s include — with
  `skipLibCheck: false`, tsdown's own d.mts references optional peers (`publint`) and fails
  typecheck otherwise.
