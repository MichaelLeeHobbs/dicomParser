# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@ubercode/dicom-parser` — a ground-up TypeScript remake of cornerstonejs/dicomParser that
**parses and writes** DICOM Part-10 with zero runtime dependencies. This repo is a true GitHub
fork. The original JS source and karma tests (`legacy/` and `legacy-test/`) served as the
porting reference and were removed once the port completed; the 1.x history lives in
`legacy-CHANGELOG.md` and `docs/porting-notes.md`. `testImages/` holds binary DICOM fixtures.

**PLAN.md is the governing document** — progress tracker, phases, the 13-item requirements
backlog, verification gates, and the 2.0.0 definition-of-done checklist. Update its §0 tracker
and §9 checklist as work lands. Companion docs: `docs/upstream-triage.md` (full 45-item upstream
triage — the raw requirements), `docs/porting-notes.md` (legacy behavior map, preserve-vs-fix
list, assets to port from dcmtk.js, toolchain gotchas — **read before touching Phase 1**).

## Commands

```bash
pnpm run test            # Vitest run
pnpm run test:coverage   # coverage w/ thresholds (95/90/95/95)
pnpm run lint            # ESLint --max-warnings 0
pnpm run typecheck       # tsc --noEmit (TypeScript 7)
pnpm run build           # tsdown (ESM + CJS + DTS)
pnpm run format:check    # Prettier
```

## Governing standards

Per `docs/TypeScript Coding Standard for Mission-Critical Systems.md` (in this repo; same
standard as `@ubercode/dcmtk`):

- No `any`; `unknown` + type guards
- No recursion — iterative algorithms with bounded loops (this parses untrusted input)
- Typed errors carrying partial results; never throw strings
- Discriminated unions over optional-field grab-bags (element model: `kind`-tagged)
- `readonly` by default; exact byte accounting on every element
- TSDoc on all public APIs; functions ≤ 40 lines; complexity ≤ 10
- Every parser change needs a fixture: real file in `testImages/`, synthetic builder, or fuzz case

## Security posture

Upstream issue #282 documents an **undisclosed vulnerability** reported against the 1.x code this
rewrite reimplements. Treat all length/offset/deflate handling as attack surface: bounds-check
every read, bound every loop, fuzz malformed inputs. SECURITY.md + GitHub private vulnerability
reporting are live — never discuss suspected vulns in public issues.

## Key facts

- Version lineage continues upstream: this is v2.x (`2.0.0-alpha.*` during the rewrite)
- Publishing: tag `vX.Y.Z` push → publish workflow (OIDC trusted publishing, dist-tag derived
  from version, GitHub Release auto-created). First-ever npm publish must be done manually to
  create the package before trusted publishing can be configured on npmjs.com.
- pnpm version comes from the `packageManager` field ONLY — do not add `version:` to
  pnpm/action-setup in workflows (they conflict and fail CI)
- The primary downstream consumer is `@ubercode/dcmtk` (`_p10ToJson.ts` runs on the v1 compat
  façade at Phase 4); its 198-file DCMTK differential suite is an external acceptance gate
