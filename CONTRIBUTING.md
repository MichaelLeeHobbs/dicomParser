# Contributing

Thanks for helping improve `@ubercode/dicom-parser`. This library parses untrusted
medical data, so the bar for changes is deliberately high.

## Dev setup

```bash
pnpm install                # pnpm version comes from packageManager in package.json
pnpm run test               # Vitest
pnpm run test:coverage      # enforces 95/90/95/95 thresholds
pnpm run lint               # ESLint, --max-warnings 0
pnpm run typecheck          # TypeScript 7 (via the ts7 alias)
pnpm run format:check       # Prettier
pnpm run build              # tsdown → ESM + CJS + DTS (main + /compat entries)
pnpm run bench              # perf gate vs dicom-parser@1.8.21 (local machines only)
pnpm run docs               # TypeDoc → docs-site/
```

All of the above must be green before a PR merges; CI runs them on Node 20/22/24.

## Ground rules (docs/TypeScript Coding Standard for Mission-Critical Systems.md)

- No `any`; `unknown` + type guards. No recursion — iterative algorithms with bounded
  loops. Typed `DicomError`s carrying partial results; never throw strings.
- `readonly` by default; exact byte accounting on every element
  (`startOffset`/`dataOffset`/`endOffset` must tile the stream).
- TSDoc on all public APIs; functions ≤ 40 lines; complexity ≤ 10.
- **Every parser change needs a fixture**: a real file in `testImages/`, a synthetic
  builder case (`tests/helpers/p10.ts`), or a fuzz case (`tests/fuzz.test.ts`).

## Adding fixtures

- Small synthetic cases: build them with `tests/helpers/p10.ts` inside the test.
- Real files: add to `testImages/` **only** if fully anonymized and small; the corpus is
  shipped in the repo. Note DCMTK ground truth in the test (use `dcmdump`).
- Malformed-input regressions: prefer a fuzz-suite case so the shrunken repro is kept.

## Security-sensitive areas

Length/offset arithmetic (`tokenizer.ts`, `encapsulated.ts`, `byteStream.ts`) and the
inflate paths (`inflate.ts`) are the attack surface — an undisclosed vulnerability was
reported against the 1.x code this library reimplements (upstream #282). Changes there
need fuzz coverage. **Never** discuss suspected vulnerabilities in public issues; use
GitHub private vulnerability reporting (see SECURITY.md).

## Release gates (maintainers)

See `docs/release-runbook.md`. Round-trip byte-identity across `testImages/`, the
199-file legacy differential, and the dcmdump acceptance suite must be green before
tagging; publishing is tag-driven via OIDC trusted publishing.
