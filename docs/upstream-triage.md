# Upstream Triage — cornerstonejs/dicomParser open issues & PRs

Snapshot: 2026-07-22 · 45 open items (12 PRs, 33 issues) · This document is the raw requirements
input behind PLAN.md's ranked backlog. Each item carries a disposition for this fork:

- **fixed-by-design** — a modern TS rewrite naturally resolves it
- **explicit-work-item** — needs deliberate implementation
- **port-the-PR** — the PR contains a real fix/feature to reimplement
- **wontfix/stale** — out of scope or obsolete

---

## Part 1 — Open Pull Requests (12)

### #280 — feat: Support for VR type "UV" (Unsigned 64-bit Very Long)

- Opened 2026, @PolarsBear — +305/−7, 10 files
- Implements the UV VR (64-bit unsigned, DICOM 2019a PS3.5 §6.2) using `BigInt`. Without it, a UV element's 32-bit length field is misread, permanently offsetting the parse and corrupting everything after the tag (companion issue #281).
- Category: missing-VR-or-feature
- **Disposition: port-the-PR.** A rewrite must handle all post-2019 VRs: UV, SV (signed 64-bit), OV (other 64-bit). Use `BigInt`/`BigUint64Array` accessors — no back-compat concern in a modern fork. This is the only open PR fixing a live data-corruption bug.

### #278 — Improve type declaration

- Opened 2025, @Ragnar-Oock — +230/−39, 1 file (`index.d.ts`); CI dead (broken Firefox download URL)
- Replaces PR #258; substantially reworks the hand-written `.d.ts`, splitting the kitchen-sink `Element` interface toward the actual runtime shapes.
- Category: types/TS
- **Disposition: fixed-by-design** — a ground-up TS rewrite generates real types. But **steal the design idea**: model `Element` as a discriminated union (basic element | sequence | encapsulated pixel data | meta element) rather than one interface with 8 optional fields (see #257).

### #277 — Throw error instances instead of strings and objects

- Opened 2025, @Ragnar-Oock — +376/−255, 29 files; CI dead. Closes #46.
- Introduces `DicomParserError` replacing the thrown `{exception, dataSet}` object; replaces thrown strings with `Error`/`TypeError`/`RangeError` with proper messages.
- Category: parser-bug (error-model)
- **Disposition: fixed-by-design** — a mission-critical-style rewrite (Result pattern or typed error classes) subsumes this entirely. Keep one behavior from the old object-throw: the partially-parsed dataset must remain reachable from the error (see #203).

### #268 — UntilTag should stop on the first tag greater than the requested tag

- Opened 2024, @jpambrun — +105/−127, 5 files, mergeable-clean. Fixes #104.
- Changes `untilTag` from exact-match (`===`) to ordered comparison: since DICOM tags are sorted, parsing stops at the first tag ≥ the requested one. Enables partial parsing (skip group 6000/pixel data) without knowing whether the tag exists. Author notes "only superficially tested."
- Category: parser-bug
- **Disposition: port-the-PR.** Correct semantics for the fork's stop-condition option; add the tests the PR lacked.

### #265 — chore(deps-dev): bump follow-redirects 1.14.8 → 1.15.4

- Opened 2024, dependabot. Dev-dep security bump for the legacy webpack/karma chain.
- Category: build/tooling — **Disposition: wontfix/stale** (fork won't inherit this toolchain).

### #262 — chore(deps-dev): bump browserify-sign 4.2.1 → 4.2.2

- Opened 2023, dependabot. Same as above.
- Category: build/tooling — **Disposition: wontfix/stale.**

### #239 — Draft: Update node to latest LTS release for build purposes

- Opened 2023, @yagni — +10,720/−21,758, merge-dirty, explicitly draft
- Checklist to get off Node 16: node tests (#252), remove deprecations, update deps.
- Category: build/tooling — **Disposition: wontfix/stale** — the fork starts on a current toolchain; this is fixed-by-design as a side effect.

### #203 — Fix parsing of truncated byte arrays

- Opened 2022, @jmhmd — +29/−3, 2 files, mergeable-clean
- Catches dataset parsing exceptions, merges the successfully-parsed meta header with the partially-parsed dataset, and re-throws — so a truncated file still yields everything parsed up to the failure point.
- Category: parser-bug (robustness)
- **Disposition: port-the-PR (as design requirement).** In the fork: on parse failure, return the partial dataset plus a typed error / warnings list — real-world PACS truncation is common and salvaging the header is valuable.

### #147 — Typescript rework (WIP)

- Opened 2020, @hiddentn — +9,536/−12,909, 92 files, merge-dirty, **head repo deleted**
- A basic mechanical JS→TS conversion; coverage broken; abandoned.
- Category: types/TS — **Disposition: wontfix/stale** — the fork _is_ this PR done properly; nothing salvageable from a deleted head repo.

### #60 — add support for overriding 'isEncapsulated()'

- Opened 2017, @keean — +20/−12, 3 files, merge-dirty
- Adds `transferSyntax` to `ByteStream` and factors encapsulation detection into an overridable `isEncapsulated()`, so files with nonstandard encapsulated pixel data (defined length instead of 0xFFFFFFFF, see #59) can be parsed via a user hook.
- Category: missing-VR-or-feature (extensibility hook)
- **Disposition: port-the-PR (the concept).** Two ideas worth keeping: (a) transfer syntax should be visible to element-reading logic — trivial in a rewrite; (b) encapsulation detection should be an injectable policy/lenient-mode option.

### #56 — Heap performance

- Opened 2016, @jkrot — +69/−63, merge-dirty
- Hoists variable declarations out of loops etc. for ~4% claimed improvement when bulk-parsing 1000+ files (companion issue #54).
- Category: build/tooling (perf)
- **Disposition: wontfix/stale** — micro-optimizations for 2016-era V8. Carry forward only the _requirement_: benchmark bulk parsing and avoid per-element garbage.

### #52 — Don't include tag if not needed

- Opened 2016, @jssuttles — +121/−25, merge-dirty
- Extends `untilTag` to accept `{ tag, include: false }` so the terminating element can be excluded from the result.
- Category: missing-VR-or-feature
- **Disposition: port-the-PR (as API design).** Fold into the fork's partial-parse options alongside #268's ≥ semantics — a `stopAt: { tag, inclusive }` option covers #52, #104, #268 at once.

---

## Part 2 — Open Issues by Category

### parser-bug (11)

**#281 — Reading tag with VR type "UV" derails reading process** (2026, @PolarsBear)
UV's length field isn't handled, so the read offset drifts and every subsequent element is garbage — total loss of data after the first UV tag. Fix proposed in PR #280.
**Disposition: explicit-work-item** — implement UV/SV/OV VRs (see PR #280). This is the same work item as porting #280.

**#266 — Buffer overrun when encapsulated pixel data SequenceDelimitationItem (FFFE,E0DD) has undefined length** (2024, @jmhmd)
Non-compliant files write length `0xFFFFFFFF` instead of the mandated `0` on the pixel-data sequence delimiter; dicomParser seeks by that length and throws a buffer overrun. Reporter (with sample file) asks why the parser doesn't just treat FFFE,E0DD as length 0 per the standard.
**Disposition: explicit-work-item** — delimitation items (E00D/E0DD) should always be treated as zero-length regardless of the encoded length field; emit a warning instead of failing.

**#244 — Sequence Item Delimiter tag read as an element** (2023, @rennerg, "bug report" label)
For undefined-length sequences containing undefined-length items, the item delimiter (FFFE,E00D) leaks into the parsed output as if it were a data element. Maintainer confirmed it's tricky: per the standard the _sequence_ delimiter is part of the SQ value but the _item_ delimiter is not part of the item value.
**Disposition: explicit-work-item** — the fork's sequence reader must consume delimiters structurally and never surface them as dataset elements (or surface them uniformly and explicitly typed — pick one model; see #143).

**#143 — Sequence Delimitation Item not present in the element list** (2020, @baptiste-le-m, "bug report")
The inverse complaint: SequenceDelimitationItem is silently dropped, while ItemDelimitationItem sometimes appears, so byte-level offsets don't reconcile. chafey confirmed the design intent was to expose the full bitstream detail and called current behavior a bug; yagni noted fixing it changes reported SQ element lengths (breaking).
**Disposition: explicit-work-item (same item as #244)** — define one consistent, documented representation for delimiters + `hadUndefinedLength` + offsets so consumers can reconstruct exact byte ranges. This is a design decision the fork gets to make cleanly.

**#141 — Cannot load DICOM where SQ uses VR:UN with undefined length** (2020, @malaterre, "bug report")
CP-246 territory. Long thread conclusion: UN + undefined length must be parsed as an implicit-VR-LE sequence (works today), but UN + _defined_ length is left as opaque binary even when a vrCallback/dictionary could identify it as SQ — so CP-246-encoded sequences are unreachable. malaterre: treat "UN + defined length" like an implicit-TS SQ when a dictionary says so.
**Disposition: explicit-work-item** — full CP-246 support: UN + undefined length → parse as implicit SQ; UN + defined length → attempt implicit SQ parse when dictionary/callback identifies SQ (with safe fallback to binary on parse failure).

**#181 — Parser doesn't close correctly an undefined length sequence** (2021, @ianholing)
Undefined-length SQ containing one defined-length item: parser hunts for an item delimitation item that legitimately isn't there (NEMA Table 7.5-2). Maintainer said "should be fixed, please retest" in 2022; no response since.
**Disposition: invalid-or-stale** (likely fixed) — but add this exact shape (undefined-length SQ, defined-length items) to the fork's test matrix; it's cheap insurance.

**#114 — Fail to find image element in DICOM with private SIEMENS sequence tags** (2019, @Zaid-Safadi, "bug")
Root cause (diagnosed in comments): in implicit VR, the parser uses a byte-peek heuristic to guess private elements are sequences; a nonconforming private "sequence" makes it compute a wrong length and skip the rest of the file, losing PixelData. Other toolkits treat implicit private elements as UN/binary. Consensus in-thread (chafey, yagni): skip the sequence-peek for private tags unless a vrCallback says SQ; breaking change deferred to 2.0.
**Disposition: explicit-work-item** — in the fork, never heuristically sequence-parse _private_ implicit elements; parse them only when the dictionary/vrCallback identifies SQ. Directly related: #245, #141.

**#125 — Fatal error when parsing image (deflated transfer syntax)** (2019, @create3000)
`TypeError: this is undefined` at parseDicom.js:58 for Deflated Explicit VR LE files. yagni diagnosed broken pako-detection code paths in Node/strict mode.
**Disposition: fixed-by-design** — a modern ESM rewrite with a proper inflate strategy (Node `zlib` / injected `pako` / `DecompressionStream`) eliminates the module-sniffing entirely. Same root as #270/#109.

**#104 — untilTag breaks if the tag is not in dicom** (2018, @Djeisen642)
`untilTag` uses `===`, so a missing tag means the option never triggers and parsing can run into a buffer overrun.
**Disposition: fixed-by-design via porting PR #268** (≥ comparison). One work item covering #104 + #268 + #52.

**#253 — attributeTag returns undefined if attribute has more than one value** (2023, @Ragnar-Oock)
`dataSet.attributeTag()` returns undefined whenever length ≠ 4, but AT elements can have VM 1-n (e.g. Frame Increment Pointer 0028,0009). Proposes an index parameter like the other accessors.
**Disposition: explicit-work-item (small)** — AT accessor takes an index (consistent with `uint16(tag, index)` etc.) and/or a plural accessor returning all values.

**#73 — RangeError: Invalid typed array length** (2017, @rw3iss)
Diagnosis in comments (yagni): user passed element `length` (bytes) as the `Uint16Array` element count — should be `length / 2`, and BitsStored decides Uint8 vs Uint16. Library behavior is correct; README example invited the mistake.
**Disposition: fixed-by-design** — give the fork typed pixel-data accessors (return a correctly-constructed typed array view) so users never hand-build views from `dataOffset`/`length`. Otherwise wontfix as support.

**#46 — Don't throw object, throw Error** (2016)
Error-model complaint resolved by PR #277's design.
**Disposition: fixed-by-design** in the fork's typed-error model, keeping partial-dataset access.

### missing-VR-or-feature (8)

**#59 — Encapsulated Data Without End Delimiter** (2017, @keean, enhancement)
Real-world encapsulated JPEG files where PixelData has an actual defined length instead of 0xFFFFFFFF; parser then doesn't treat them as encapsulated. Discussion produced the `isEncapsulated()` hook (PR #60).
**Disposition: explicit-work-item** — lenient-mode: detect encapsulation from transfer syntax (compressed TS ⇒ encapsulated) rather than solely from the undefined-length sentinel; keep an override hook.

**#146 — Internationalization support** (2020, @malaterre)
dicomParser does zero SpecificCharacterSet (0008,0005) handling; `string()` assumes ISO-8859-1-ish and truncates at the first 0x00 byte (wrong for multi-byte encodings). Workaround: yagni's separate `dicom-character-set` library. chafey: "we should not be propagating designs which are not character-set aware."
**Disposition: explicit-work-item (high value)** — charset-aware string decoding in the fork: honor 0008,0005 (incl. ISO 2022 escapes), PN component groups, and expose `rawBytes()` alongside decoded `string()`. Port `@ubercode/dcmtk`'s `_charset.ts` + PS3.5 Annex H/I/J fixtures.

**#48 — Set default transfer syntax in options** (2016, @NicolasRannou, enhancement)
Raw datasets missing the P10 meta header (no 0002,0010) just error. chafey's stance: keep the core standard-strict but the "parse a headerless dataset" recipe is 3 lines of internal API; wanted an example/utility.
**Disposition: explicit-work-item** — first-class `parseDataset(bytes, { transferSyntax })` API (or `defaultTransferSyntax` option) for headerless/raw datasets. Trivial in a rewrite, frequently requested.

**#245 — Failed to extract private tag sequence (3009,1201)** (2023, @pgfeller)
User maintains a patched build to parse vendor-private sequences; asks for an opt-in `ParseDicomOptions` flag to process private tag sequences. Mirror-image of #114 (which wants private heuristic parsing _off_ by default).
**Disposition: explicit-work-item (same design item as #114)** — default: private implicit elements are opaque; opt-in: vrCallback/private-dictionary can declare them SQ and get full parsing. One coherent policy resolves #114 + #245 + part of #141.

**#107 — Clarify 1.2.840.113619.5.2 (Implicit VR Big Endian DLX, GE Private) support** (2018, @malaterre)
GE private TS: elements little-endian but PixelData bytes big-endian. Errors today are confusing. chafey: never designed for it; non-standard behaviors belong behind opt-in flags.
**Disposition: wontfix (document)** — out of scope for the parser core; at most recognize the UID and emit a clear "unsupported private transfer syntax" error. A byte-swap of PixelData is a consumer concern.

**#113 — Support for encrypted DICOM** (2018, @leovandriel)
Asks about CMS-encrypted DICOM (PS3.15 attribute-level encryption), stuck on PWRI-KEK key unwrap.
**Disposition: wontfix** — cryptography does not belong in a parsing library; the parser only needs to surface Encrypted Attributes Sequence (0400,0500) elements intact.

**#270 — why dicomParser does not have pako as dependency** (2024, @sedghi)
`pako` is sniffed off the global/window rather than imported — historic zero-dependency choice — which breaks ESM bundling of dicom-image-loader. Thread consensus (incl. chafey): optional _injection_ at init is acceptable; don't make it mandatory.
**Disposition: fixed-by-design** — fork uses conditional exports: Node build uses `node:zlib`; browser build accepts an injected inflate or `DecompressionStream('deflate-raw')` (Baseline since 2023) with pako as optional fallback. Kills #270, #125, #109 together.

**#264 — Reading JPEG2000 Lossless data** (2024, @syedkibrahim)
Asks how to know data is compressed and how to decompress. Answered: TS UID says it's compressed; use an external J2K codec on the fragment byte ranges.
**Disposition: wontfix (question/support)** — decompression is deliberately out of scope (same stance as upstream); the fork should make fragment/BOT access ergonomic and document the codec handoff.

### types/TS (2)

**#279 — Missing DataSet constructor in TypeScript definitions** (2025, @sgielen)
`dataSet.js` exports a class with a 3-arg constructor; the hand-written `index.d.ts` declares `DataSet` as an interface, so `new dicomParser.DataSet(...)` (the documented workaround for headerless parsing, issue #112) doesn't typecheck.
**Disposition: fixed-by-design** — types come from source in a TS rewrite; also mooted if the fork ships a proper raw-dataset API (#48).

**#257 — Missing documentation: the dataset object** (2023, @Ragnar-Oock)
The single `Element` interface merges at least 3-4 mutually exclusive runtime shapes (basic, sequence, encapsulated pixel data), causing "hard to track down bugs." Author drafted improved typings (→ PR #258 → #278).
**Disposition: fixed-by-design + explicit-work-item** — the rewrite must model element kinds as a discriminated union (`kind: 'value' | 'sequence' | 'encapsulated' ...`) and generate API docs from source. This is a load-bearing design requirement, not an afterthought.

### build/tooling (6)

**#282 — Security Reporting** (2026, @lp1dev)
Researcher has an undisclosed vulnerability to report; repo lacks SECURITY.md / private vulnerability reporting; maintainer scrambling to set it up. **The vulnerability itself is unknown and possibly unaddressed upstream.**
**Disposition: explicit-work-item** — (a) SECURITY.md + private vulnerability reporting on the fork day one (DONE in Phase 0); (b) the rewrite must be fuzzed (malformed lengths, truncation, deflate bombs) since there is a live undisclosed vuln in the codebase being reimplemented.

**#252 — Run test suite in node** (2023, @yagni, enhancement)
Tests are Karma/browser-only despite Node support being a first-class feature.
**Disposition: fixed-by-design** — fork tests in Node (Vitest) + browser smoke from the start.

**#237 — Improve semantic-release usage** (2023, @yagni)
**Disposition: wontfix/stale** — fork has its own release tooling.

**#140 — npm install fails on mac os x** (2020) — ancient fsevents/Node-12 issue. **Disposition: wontfix/stale.**

**#91 — import package not working** (2018) — fixed upstream in 2018, never closed. **Disposition: invalid-or-stale.**

**#86 — broken links for packaged source files** (2018). **Disposition: invalid-or-stale.**

### docs (2)

**#151 — Documentation?** (2020, @ZachOBrien)
No API docs exist beyond README + `index.d.ts`; multiple +1s over years.
**Disposition: fixed-by-design + explicit-work-item** — TSDoc on all public APIs with generated docs (TypeDoc) is table stakes for the fork.

**#109 — Update live examples to support deflate** (2018, @malaterre)
Drag-and-drop example fails on deflated files with the same pako-sniffing bug as #125.
**Disposition: fixed-by-design** — resolved by the fork's inflate strategy (#270); examples should include a deflated-TS sample.

### question/support (2)

**#275 — Can't get patient age in DICOMDIR file** (2025, @raffo1234, "Awaiting Data to Reproduce")
Likely the age simply isn't in that directory record (viewers compute it from birth date + study date) — awaiting sample data, none provided.
**Disposition: invalid-or-stale** (probably not a parser bug). Fork nicety: convenience helpers over DICOMDIR record sequences.

### meta (1)

**#214 — Version 2.0 Discussion** (2022, @yagni)
The upstream 2.0 wishlist thread. Signals: **ESM is the top ask**; TS rewrite openly discussed but uncommitted; element-type discrimination named the biggest DX pain; Error-throwing (#46) slated for 2.0; a contributor asks for **DICOM writing**; no plan to fold into the cornerstone monorepo.
**Disposition: fixed-by-design** — the fork _is_ v2.0. Free market research; writing is the differentiator (now in scope, PLAN.md item 13).

---

## Summary

| Category              | Count | Items                                                                 |
| --------------------- | ----- | --------------------------------------------------------------------- |
| parser-bug            | 12    | #281, #266, #244, #143, #141, #181, #114, #125, #104, #253, #73, #46  |
| missing-VR-or-feature | 11    | PR #280, PR #60, PR #52, #59, #146, #48, #245, #107, #113, #270, #264 |
| types/TS              | 4     | PR #278, PR #147, #279, #257                                          |
| build/tooling         | 10    | PR #265, PR #262, PR #239, PR #56, #282, #252, #237, #140, #91, #86   |
| docs                  | 2     | #151, #109                                                            |
| question/support      | 2     | #275, #264 (dual)                                                     |
| meta                  | 3     | #214, PR #203, PR #268                                                |

Disposition totals: **fixed-by-design ≈ 14** · **explicit-work-item ≈ 13** · **port-the-PR 5**
(#280, #268, #203, #60-concept, #52-concept) · **wontfix/stale ≈ 13**.

The ranked synthesis of these items is PLAN.md §5 (requirements backlog).
