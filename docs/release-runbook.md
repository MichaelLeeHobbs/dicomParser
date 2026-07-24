# Release runbook — 2.0.0-rc.1 → 2.0.0

Phases 6-7 need steps that are deliberately manual (publishing, cross-repo changes,
external soak). Everything below the "prepared" line is done; work the blockers top-down.

## Prepared (in-repo, done)

- **`2.0.0-rc.1` published** to npm under the `rc` dist-tag (with provenance); GitHub
  Release created; npm Trusted Publishing configured; the `2.0.0-alpha.0` release
  deprecated. `npm pack --dry-run` clean; ESM+CJS+DTS build with `/compat` subpath; `attw`
  clean.
- All quality gates green in CI: the full unit/fixture suite plus the environment-gated
  corpus differential, `dcm2xml` oracle, `dcmdump` round-trip, and browser smoke suite (the
  CI `Test`/`Acceptance`/`Browser smoke` jobs); coverage ≥ thresholds; fuzz; byte-identical
  round-trip corpus; perf baseline (`docs/benchmark.md`). (Test counts move with every PR —
  read them off CI rather than hardcoding here.)
- Repo hygiene done: `legacy/`/`legacy-test/` removed, CONTRIBUTING + issue/PR templates +
  branch protection in place, TypeDoc site on GitHub Pages.

## Blockers, in order

1. **dcmtk.js swap** (cross-repo) — **not a one-line diff**:
    - `_p10ToJson.ts` import → `@ubercode/dicom-parser/compat` (this part _is_ one line, per
      `docs/migration-v1.md`).
    - `_boundedRead` (dcmtk.js's memory feature, dcmtk.js#35) must be **rewritten against the
      core bounded head-read API** (fork #59). The legacy `dicom-parser` internals it relied on
      are gone by design — `readPart10Header` is not on the `/compat` namespace in v1 shape, and
      truncated defined-length values now clamp with an `unexpected-eof` warning instead of
      throwing with an oversized extent, so its skip trigger can never fire (fork #58). A naive
      swap silently disables skipping and reintroduces the full-read memory profile. Alternative:
      disable it explicitly (`boundedRead: false`) and note the memory regression.
    - Run dcmtk.js's 198-file DCMTK differential + its forced-bounded differential + perf suite.
      Keep the `engine`/`dcmtkFallback` safety net.
    - **Adoption check (fork #60):** run the dcmtk.js `bad/` corpus through the swapped engine
      and diff `ok`/`err` outcomes vs legacy. Truncated/overrunning files now parse `ok` with an
      `unexpected-eof` warning (divergence A1) where legacy threw — review each flip against any
      error-keyed flow (quarantine, repair/reroute) in dcmtk.js and d-dart (cf. dcmtk.js#34).
2. **d-dart soak**, then `v2.0.0` final — repoints `latest` off the alpha dist-tag.

## Phase 7 (optional)

`docs/upstream-offer-draft.md` contains a ready-to-post comment for upstream #214
offering this as their v2.0. Posting (or not) is a project decision — do not automate.
