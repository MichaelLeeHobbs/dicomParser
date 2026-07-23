# dicomParser Fork — Scope Document

Date: 2026-07-22 · Status: ACCEPTED (decisions locked 2026-07-22)
Upstream: `cornerstonejs/dicomParser` @ 1.8.21 (MIT, dormant since Oct 2023, 121k weekly downloads)

**Locked decisions**: npm name `@ubercode/dicom-parser` · true GitHub fork of
cornerstonejs/dicomParser · charset decoding lives in the fork core · **DICOM writing is in scope
for v1** (parse + serialize).

**Companion documents**: [docs/upstream-triage.md](docs/upstream-triage.md) (the full 45-item
upstream issue/PR triage behind §5) · [docs/porting-notes.md](docs/porting-notes.md) (legacy
behavior map, preserve-vs-fix list, assets to port from dcmtk.js, toolchain gotchas) ·
[docs/TypeScript Coding Standard for Mission-Critical Systems.md](docs/TypeScript%20Coding%20Standard%20for%20Mission-Critical%20Systems.md)
(governing standard, copied from dcmtk.js).

## 0. Progress tracker

| Phase                              | Status                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0 — Scaffold                       | **DONE** 2026-07-22 (PR #1)            | Toolchain, CI (Node 20/22/24 green), publish workflow, SECURITY.md + private vuln reporting, `2.0.0-alpha.0` published to npm (manual bootstrap publish)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 1 — Core tokenizer                 | **DONE** 2026-07-22 (PRs #3-#7)        | Byte layer → element headers → iterative tokenizer → P10/inflate/parse → accessors+value parsers. Legacy karma suite ported to Vitest (~270 tests incl. real-fixture gate over testImages/); coverage ≥ thresholds. Landed fix-by-design: #281 SV/UV/OV, delimiter model #244/#143/#266, stopAt ≥ #104/#268/#52, typed errors + partial results #46/#203/#277, #114 private policy, inflate strategy #270/#125/#109, headerless #48, #107 clear error, #253 indexed AT, #146 NUL-truncation fix (charset decoding itself still Phase 2). Deferred to Phase 2: full CP-246 (#141), TS-driven encapsulation (#59/#60), charset decoding (#146), typed pixel accessors (#73), frame-extraction utils + createJPEGBasicOffsetTable, elementToString/dataSetToJS. |
| 2 — Backlog items 1-12             | **DONE** 2026-07-23 (PRs #8-#9)        | Item 3 CP-246 + #114/#245 policy (speculative sequence fallback), item 4 charset (dcmtk.js port + PS3.5 H/I/J fixtures, parse-integrated), item 9 lenient modes (#48 Phase 1; #59/#60 TS-driven defined-length encapsulation), item 11 pixel helpers + nativePixelDataView (#73), item 12 fuzz suite (fast-check: mutation/truncation/hostile-deflate/random-streams) + deflate-bomb cap. Items 1/2/5/6/8/10 landed in Phase 1; item 7 docs side in Phase 5.                                                                                                                                                                                                                                                                                                 |
| 3 — Writer                         | **DONE** 2026-07-23 (PR #10)           | Write model + iterative two-pass encoder, writeFile/meta generation/deflated output, modifyDataSet edit model, serializeParsed. Gates green: byte-identical round trip across the whole testImages corpus, write→parse→write idempotence, dcmdump accepts output (local DCMTK, auto-skips in CI). BE is read-only by design.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 4 — Compat façade                  | **DONE** 2026-07-23 (PR #10)           | '/compat' subpath: v1 parseDicom/DataSet surface over the core (vrCallback/inflater/TransferSyntaxUID/untilTag, meta merged, v1 accessors). Oracle #2 green: 199-file dcmtk.js corpus tag-for-tag vs dicom-parser@1.8.21 (local suite, CI-skipped). Remaining external gate: swap inside dcmtk.js + its DCMTK differential (Phase 6 territory, needs dcmtk.js repo change).                                                                                                                                                                                                                                                                                                                                                                                  |
| 5 — Fuzz/perf/docs                 | **DONE** 2026-07-23 (PR #11)           | Fuzz landed with Phase 2 (item 12). Perf gate: compat façade ~17% faster than 1.8.21 (docs/benchmark.md; comparative gate local, absolute budget in CI). Docs: README (parse+write quick starts, charset table, lenient modes, codec handoff), docs/migration-v1.md, CHANGELOG.md, examples/, TypeDoc site + Pages workflow (needs Pages enabled in repo settings once). Browser-mode smoke suite still open (§9).                                                                                                                                                                                                                                                                                                                                           |
| 6 — Release + dcmtk.js swap        | **PREPARED** (blocked on manual steps) | Version staged at 2.0.0-rc.1, CHANGELOG ready, pack dry-run clean. Blockers (docs/release-runbook.md): npm Trusted Publishing not configured; tag pushes withheld per instruction; dcmtk.js swap + 198-file DCMTK differential + d-dart soak are cross-repo/user-gated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 7 — Upstream v2.0 offer (optional) | **DRAFTED** (decision pending)         | docs/upstream-offer-draft.md holds the proposed #214 comment; posting is the user's call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Outstanding manual step: configure npm Trusted Publishing for this repo + `publish.yml` on
npmjs.com (possible now that the package exists). Until then, tag-push publishes will fail at
the `npm publish` step. Known cosmetic issue: npm forced `latest` → `2.0.0-alpha.0` on first
publish (unavoidable; self-corrects at `2.0.0` final).

## 1. Mission

A ground-up TypeScript remake of dicomParser: modern toolchain, real types, resolution of the
entire upstream open backlog (33 issues + 12 PRs, triaged below), **plus a serializer — the fork
reads and writes DICOM**, which upstream never did (top community ask in #214 after ESM/TS).
Ship as an independent package; keep the door open for upstream adoption as their v2.0 — realistic,
because upstream's own "Version 2.0 Discussion" (#214) asks for exactly what this fork delivers:
ESM, TypeScript, discriminated element types, Error-based error handling, and writing.

Primary consumer: `@ubercode/dcmtk`'s `dicom2json` engine (replaces `dicom-parser@1.8.21`),
which removes its one known limitation (explicit-VR SV/UV/OV) and its charset layer's upstream
gaps. Writing additionally opens a pure-JS path for dcmtk.js tag modification (today: dcmodify
binary) — a later dcmtk.js decision, not a commitment here.

## 2. Sizing

Upstream is small: **~2,550 lines of source** (24 modules + util), ~3,240 lines of karma/mocha
browser tests. Estimated fork size with the writer: 5.5-7k lines of TS source, 9-12k lines of
tests (ported + new + round-trip). Roughly double a parse-only fork — the writer itself is
moderate (~1.5-2k lines), but round-trip verification is a large test surface.

## 3. Decisions (proposed)

| Decision     | Proposal                                                                                                                                          | Notes                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| npm name     | `@ubercode/dicom-parser` (available; also free: `dicom-parser-ts`, `dicom-tokenizer`)                                                             | Scoped avoids squatting concerns; unscoped `dicom-parser-ts` is more discoverable                                                             |
| Repo         | New standalone repo, GitHub fork of cornerstonejs/dicomParser                                                                                     | True GitHub fork preserves history + makes an upstream PR possible later                                                                      |
| License      | MIT, retain Chris Hafey's copyright notice + add fork notice                                                                                      | Required by MIT; also good citizenship                                                                                                        |
| Language     | TypeScript 7.0 (GA 2026-07-08, native compiler)                                                                                                   | `erasableSyntaxOnly`, max strictness — same posture as dcmtk.js                                                                               |
| Build        | **tsdown** (Rolldown-based; the Vite ecosystem's library bundler — Vite lib mode itself is being rebased onto it)                                 | ESM-first dual ESM+CJS, DTS from source. Directly resolves upstream #270/#214                                                                 |
| Tests        | Vitest (Node) + Vitest browser mode for a browser smoke suite                                                                                     | Resolves upstream #252 (Node tests)                                                                                                           |
| Lint/format  | ESLint 10 flat + Prettier, `--max-warnings 0`                                                                                                     | Same as dcmtk.js/pino-cloudwatch-ts                                                                                                           |
| CI/publish   | Copy dcmtk.js workflows: tag-driven, npm Trusted Publishing (OIDC) + provenance, dist-tag derivation, GitHub Release creation, packageManager pin | Just proven end-to-end on rc.2                                                                                                                |
| Security     | SECURITY.md + GitHub private vulnerability reporting **on day one**                                                                               | Upstream #282: a researcher holds an **undisclosed vuln** against the code we're reimplementing — fuzzing is a hard requirement, not a nicety |
| Runtime deps | Zero (preserve upstream's core property)                                                                                                          | Node build uses `node:zlib`; browser uses `DecompressionStream('deflate-raw')` with optional injected inflate                                 |
| Standards    | dcmtk.js mission-critical standard applies (Result-style errors, no recursion, bounded loops, 95% coverage)                                       | The parser is the most attacker-exposed code in the stack                                                                                     |

## 4. Architecture

Two layers, cleanly separated:

**Core (new API)** — `parse(bytes, options)` returning a typed result:

- **Discriminated-union element model** (upstream #257/#278/#279): `kind: 'value' | 'sequence' | 'encapsulated' | 'unknown'` — kills the 8-optional-fields `Element` interface and its bug class.
- **Typed errors + partial results** (upstream #46/#203/#277): parse failures return/carry the partially-parsed dataset and a warnings list; truncated PACS files salvage everything up to the failure point. Never throw strings.
- **Exact byte accounting**: every element/item records offsets incl. delimiters, with one documented representation (`hadUndefinedLength`, delimiter positions) so consumers can reconstruct byte ranges (upstream #143/#244).
- **Strict by default, opt-in lenient modes** (matches upstream philosophy, serves real files):
  `stopAt: {tag, inclusive}` with ≥ semantics · `transferSyntax` override for headerless datasets ·
  TS-driven encapsulation detection · delimiter-length tolerance.

**Compat façade (`compat` export)** — the upstream v1 surface (`parseDicom`, `DataSet` with
`string()/uint16()/...` accessors, `elements` keyed `xggggeeee`, `vrCallback`, `inflater`) as a
thin wrapper over the core. This is what lets dcmtk.js (and, if they want it, upstream +
dicom-image-loader) adopt with minimal churn, and is the "acceptable as their v2" story:
new API forward, v1 shim for migration.

## 5. Requirements backlog (from full upstream triage — all 45 open items dispositioned)

Ranked work items (each closes the listed upstream items):

1. **64-bit VRs UV/SV/OV with BigInt accessors** — port PR #280; fixes #281 (live data-corruption:
   one UV tag derails the whole parse) and removes dcmtk.js's known limitation.
2. **Unified undefined-length + delimiter handling** — #244, #143, #181, #266: delimiters
   (FFFE,E00D/E0DD) consumed structurally, always zero-length regardless of encoded length
   (warn, don't crash), one documented representation. Upstream's biggest correctness debt.
3. **CP-246 + private-element policy** — #141, #114, #245: UN+undefined-length → implicit-VR SQ;
   UN+defined-length → SQ only when dictionary/vrCallback says so; never heuristically
   sequence-parse private implicit elements; opt-in private sequence parsing. One policy, three
   long-standing issues.
4. **Charset-aware string decoding** — #146: honor SpecificCharacterSet incl. ISO 2022 escapes,
   fix the truncate-at-0x00 bug, expose raw bytes alongside decoded strings. We port dcmtk.js's
   proven `_charset.ts` + PS3.5 Annex H/I/J fixtures down into the fork. No mainstream JS parser
   does this — the healthcare differentiator.
5. **Partial-parse robustness / error model** — port PR #203 concept + #46/#277 (see Architecture).
6. **`stopAt` done right** — port PR #268 (≥ comparison, fixes #104 buffer overrun) + PR #52
   (inclusive/exclusive). Enables fast metadata-only parsing (medfusion-style `untilTag` use).
7. **Element model + generated docs** — #257, #278, #279, #151: discriminated unions + TSDoc +
   TypeDoc site. Kills the entire types/docs backlog.
8. **Modern module/inflate strategy** — #270, #125, #109: ESM-first, `node:zlib` /
   `DecompressionStream`, optional injected inflate. Kills the pako global-sniffing crash class.
9. **Lenient-mode options** — #48 (headerless datasets, first-class), #59/#60 (defined-length
   encapsulated pixel data via TS-driven detection + override hook).
10. **AT multi-value accessor** — #253 (small): `attributeTag(tag, index)` + plural accessor.
11. **Typed pixel-data access** — #73-class support burden: accessors returning correctly
    constructed typed-array views so users never hand-build from `dataOffset/length`.
12. **Security + fuzz posture** — #282, #252: SECURITY.md day one; fast-check structured fuzzing +
    corpus mutation targeting length/offset/deflate paths (where the undisclosed vuln most likely
    lives); Node test suite.

**Confirmed non-goals** (matching upstream philosophy): pixel decompression codecs (#264),
attribute-level encryption (#113 — surface (0400,0500) intact, nothing more), GE private transfer
syntax 1.2.840.113619.5.2 (#107 — recognize the UID, emit a clear unsupported error), the legacy
toolchain PRs (#265, #262, #239, #56, #147 — all obsoleted by the rewrite), semantic-release (#237).

13. **DICOM writer (in scope for v1)** — upstream #214's differentiator ask. Scope:
    - Serialize a dataset to Part-10: preamble + DICM + generated meta group (with correct group
      length), explicit/implicit VR LE (write path defaults to explicit LE; BE read-only),
      deflated output via the same inflate/deflate strategy.
    - Sequences: defined-length by default, undefined-length preserved when round-tripping a
      dataset that used it; encapsulated pixel data written as fragment pass-through (no codec
      work — fragments in, fragments out).
    - Element edit model: create/modify/delete elements with VR-aware value encoding (string
      padding rules, even lengths, numeric encoding, charset-aware string encoding — the encode
      side of item 4).
    - **Round-trip guarantee**: parse → serialize with no modifications is byte-identical for
      conformant files (exact-byte-accounting from item 2 is the enabler); parse → modify →
      serialize → parse is semantically identical.
    - Non-goals for the writer: transcoding between transfer syntaxes with pixel data conversion,
      creating encapsulated pixel data from raw frames (codec territory).

## 6. Verification strategy (the fork's acceptance gates)

Three independent oracles — stronger than upstream ever had:

1. **Ported upstream test suite** (3.2k lines, karma/mocha → Vitest) — behavioral continuity.
2. **Differential harness from dcmtk.js**: all 198 sample files parsed by fork vs
   `dicom-parser@1.8.21` (tag-for-tag, except where the fork deliberately fixes upstream) **and**
   vs DCMTK via the existing `dicom2json` integration suite once dcmtk.js swaps engines.
3. **PS3.5 fixtures**: charset examples (Annex H/I/J), synthetic P10 builder (already written:
   `test/helpers/p10.ts` — explicit/implicit, BE, deflated, nested SQ, encapsulated), plus new
   fixtures for every backlog item (UV/SV/OV, CP-246, delimiter pathologies from #266/#244).
4. **Fuzzing** (fast-check + corpus mutation) with crash/hang/OOM as failure — required by #282.
   The writer doubles as a fuzz generator: serialize random valid datasets → parse → compare.
5. **Performance gate**: ≥ upstream on bulk-parse benchmark (the #54/#56 concern, done properly).
6. **Round-trip gates (writer)**: byte-identical re-serialization of unmodified conformant files
   across the 198-sample corpus; DCMTK `dcmftest`/`dcmdump` accepts every file the writer emits;
   modify-round-trip semantic equality.

## 7. Phases

| Phase | Deliverable                                                                                                                        | Gate                                                                                  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 0     | Repo scaffold: fork, toolchain, CI/publish, SECURITY.md, LICENSE w/ attribution                                                    | CI green on empty lib                                                                 |
| 1     | Core tokenizer rewrite (byte readers, explicit/implicit, sequences w/ delimiter model, encapsulated, P10 header, inflate strategy) | Ported upstream tests pass                                                            |
| 2     | Backlog items 1-12                                                                                                                 | New fixtures + differential vs upstream (documented divergences only)                 |
| 3     | Writer (item 13): serializer + edit model + round-trip machinery                                                                   | Round-trip gates green (byte-identical corpus, DCMTK accepts output)                  |
| 4     | Compat façade                                                                                                                      | dcmtk.js's `_p10ToJson` runs on `compat` unchanged; 198-file DCMTK differential green |
| 5     | Fuzz + perf + docs (TypeDoc, migration guide, examples incl. deflated)                                                             | Fuzz clean (incl. writer-generated corpus), perf ≥ upstream, docs published           |
| 6     | Release `2.0.0-rc.1` → swap into dcmtk.js behind the existing `engine` option → soak → `2.0.0` final                               | d-dart soak clean                                                                     |
| 7     | (Optional) Upstream outreach: offer as v2.0 with migration guide + compat layer                                                    | —                                                                                     |

## 8. dcmtk.js integration plan

- Swap `dicom-parser` → fork's `compat` export inside `_p10ToJson` (zero API change for dcmtk.js
  consumers; the `engine`/`dcmtkFallback` machinery already provides the safety net).
- Then, incrementally: move dcmtk.js's charset decoding down into the fork (single implementation),
  adopt the fork's native discriminated-union API in `_p10ToJson`, and drop the
  explicit-SV/UV/OV known-limitation note from docs/CHANGELOG.

## 9. Definition of done for 2.0.0 (project completeness, pino-cloudwatch-ts parity)

The phases cover the code; 2.0.0 final additionally requires all of the following. Check items
off here as they land.

**Documentation**

- [x] README: badges (npm version/downloads, CI, license), install, quick-start for parse AND
      write, API overview, migration-from-`dicom-parser` guide (or link), charset support table,
      lenient-mode options, codec handoff recipe (fragments → external decoder)
- [x] Generated API docs (TypeDoc): site builds (`pnpm run docs`) + Pages workflow added — enable GitHub Pages (Actions source) in repo settings for publishing; TSDoc on every public symbol
- [x] `docs/migration-v1.md` — v1 → v2 mapping incl. compat-façade usage and divergence list
- [x] Examples: Node parse, Node write/round-trip, browser parse (bundler), deflated TS,
      metadata-only fast path (`stopAt`)
- [x] CHANGELOG.md (Keep a Changelog; started at first beta), legacy-CHANGELOG.md retained

**Quality gates (all enforced in CI)**

- [x] Coverage ≥ 95/90/95/95 with the full ported upstream suite + new fixture suites
- [x] Fuzz suite (fast-check + corpus mutation) in CI — crash/hang/OOM = fail
- [x] Bulk-parse benchmark vs recorded baseline (docs/benchmark.md; ~17% faster than 1.8.21) — comparative gate local (`pnpm run bench`), absolute budget in CI
- [x] Round-trip gates: byte-identical re-serialization corpus (CI) + DCMTK accepts writer output (local dcmdump suite, auto-skips in CI)
- [ ] Browser smoke suite (Vitest browser mode) — parse + DecompressionStream path

**Release engineering**

- [ ] npm Trusted Publishing configured (repo + publish.yml) — no tokens anywhere
- [ ] Provenance badge visible on npm after first CI-driven publish
- [ ] `latest` dist-tag correct after 2.0.0 final (overwrites the forced alpha `latest`)
- [ ] Version lineage documented: 2.x here vs upstream 1.x; deprecation guidance for
      `dicom-parser` consumers

**Repo hygiene**

- [ ] `legacy/` and `legacy-test/` deleted (port complete); testImages/ retained
- [ ] CONTRIBUTING.md (dev setup, gates, fixture-adding guide, security-sensitive areas)
- [ ] Issue templates (bug w/ sample-file guidance, feature); PR template with gate checklist
- [ ] Branch protection on master (CI required)

**Ecosystem**

- [ ] dcmtk.js swapped and soaking in d-dart (Phase 6 gate)
- [ ] Upstream outreach decision made and, if pursued, PR/issue opened referencing #214 (Phase 7)
