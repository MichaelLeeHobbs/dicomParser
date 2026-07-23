# Release runbook — 2.0.0-rc.1 → 2.0.0

Phases 6-7 need steps that are deliberately manual (publishing, cross-repo changes,
external soak). Everything below the "prepared" line is done; work the blockers top-down.

## Prepared (in-repo, done)

- Version staged at `2.0.0-rc.1` (`package.json` + `src/version.ts`), CHANGELOG entry ready.
- `npm pack --dry-run` clean; ESM+CJS+DTS build with `/compat` subpath.
- All quality gates green: 615 tests, coverage ≥ thresholds, fuzz, byte-identical
  round-trip corpus, 199-file legacy differential (local), dcmdump acceptance (local),
  perf baseline recorded.

## Blockers, in order

1. **npm Trusted Publishing** (one-time, manual, ~2 min): on npmjs.com → package
   `@ubercode/dicom-parser` → Settings → Trusted Publishing → add GitHub repo
   `MichaelLeeHobbs/dicomParser`, workflow `publish.yml`. Until then tag-push publishes
   fail at `npm publish`.
2. **Tag `v2.0.0-rc.1`**: `git tag v2.0.0-rc.1 && git push origin v2.0.0-rc.1` — the
   publish workflow derives the `rc` dist-tag and creates the GitHub Release.
   (Tags intentionally not pushed by the overnight run.)
3. **GitHub Pages** (one-time): repo Settings → Pages → Source: GitHub Actions. The
   `docs.yml` workflow then publishes the TypeDoc site on every master push.
4. **dcmtk.js swap** (cross-repo): in dcmtk.js, change `_p10ToJson.ts`'s import to
   `@ubercode/dicom-parser/compat` (one-line diff per docs/migration-v1.md), update the
   dependency, run its 198-file DCMTK differential + perf suite. Keep the
   `engine`/`dcmtkFallback` machinery as the safety net.
5. **d-dart soak**, then `v2.0.0` final (fixes the forced-`latest` alpha dist-tag).
6. Post-final repo hygiene (§9): delete `legacy/` + `legacy-test/`, CONTRIBUTING.md,
   issue/PR templates, branch protection on master, browser-mode smoke suite.

## Phase 7 (optional)

`docs/upstream-offer-draft.md` contains a ready-to-post comment for upstream #214
offering this as their v2.0. Posting (or not) is a project decision — do not automate.
