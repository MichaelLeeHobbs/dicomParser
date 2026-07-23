# @ubercode/dicom-parser

> **Status: pre-alpha rewrite in progress.** This is a ground-up TypeScript remake of
> [cornerstonejs/dicomParser](https://github.com/cornerstonejs/dicomParser). The 1.x API does not
> exist here yet — a v1 compatibility façade ships in a later phase. See [PLAN.md](PLAN.md) for
> the roadmap and the full upstream issue/PR triage that drives it.

A TypeScript library for **parsing and writing** DICOM Part-10, with zero runtime dependencies.

## Why a fork?

Upstream dicomParser has been dormant since 2023 (last release Feb 2023) while carrying a backlog
that includes a live data-corruption bug (64-bit VRs, upstream #281), long-standing sequence
delimiter defects, no character-set handling, and no security-response process. Upstream's own
[v2.0 discussion](https://github.com/cornerstonejs/dicomParser/issues/214) asks for ESM,
TypeScript, discriminated element types, and Error-based error handling — this fork builds exactly
that, plus a serializer, and remains offerable to upstream as a v2.0.

## Goals (v2.0.0)

- **Parse + write**: byte-identical round-trip of conformant files; VR-aware element editing
- **All post-2019 VRs** (UV/SV/OV with BigInt) — fixes upstream #281
- **Correct sequence/delimiter handling** with exact byte accounting (upstream #244/#143/#266)
- **CP-246** and a coherent private-element policy (upstream #141/#114/#245)
- **Character-set-aware strings** (SpecificCharacterSet incl. ISO 2022) (upstream #146)
- **Typed errors with partial results** — truncated files salvage everything parsed so far
- **ESM-first dual build**, `node:zlib`/`DecompressionStream` deflate support (upstream #270/#125)
- **v1 compat façade** for drop-in migration from `dicom-parser`

Non-goals: pixel-data codecs, attribute-level encryption, vendor-private transfer syntaxes.

## Toolchain

TypeScript 7 · tsdown · Vitest · ESLint 10 + Prettier · pnpm · GitHub Actions with npm Trusted
Publishing (OIDC) + provenance.

## Repository layout during the rewrite

- `src/` — the new TypeScript implementation
- `legacy/`, `legacy-test/` — the original JS source and karma tests, kept as porting reference
  (removed before 2.0.0 final)
- `testImages/` — DICOM test fixtures (retained from upstream)

## Security

This library parses untrusted binary input. Please report vulnerabilities privately — see
[SECURITY.md](SECURITY.md).

## License

MIT. Original work copyright (c) 2014 Chris Hafey; TypeScript remake copyright (c) 2026
Michael Hobbs. See [LICENSE](LICENSE).
