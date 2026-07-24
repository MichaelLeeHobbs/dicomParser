# Version lineage & deprecation guidance

## The lineage

This package, **`@ubercode/dicom-parser`**, continues the version history of
[`cornerstonejs/dicomParser`](https://github.com/cornerstonejs/dicomParser) — the
`dicom-parser` npm package, last released as **1.8.21** and dormant since October 2023. This repository is a true GitHub fork of it, and the versioning **continues
as 2.x** rather than restarting at 1.0.

|          | Upstream                     | This package                                                     |
| -------- | ---------------------------- | ---------------------------------------------------------------- |
| npm name | `dicom-parser`               | `@ubercode/dicom-parser`                                         |
| Latest   | `1.8.21` (Oct 2023, dormant) | `2.0.0-*`                                                        |
| Language | JavaScript                   | TypeScript (strict, zero runtime deps)                           |
| Scope    | parse only                   | parse **and** write DICOM Part-10                                |
| API      | callback/throw               | `ParseResult` with typed errors; never throws on malformed input |

The 1.x changelog is preserved verbatim in
[legacy-CHANGELOG.md](../legacy-CHANGELOG.md); the 2.x history is in
[CHANGELOG.md](../CHANGELOG.md).

## Why 2.x and not 1.9

The rewrite is a **breaking** change to the public API — a discriminated-union
element model, a `ParseResult` return instead of throwing, charset-aware string
decoding, SV/UV/OV support, and a writer. Continuing the lineage (2.x) signals
both "same project, evolved" and "new major, expect breakage", per semver. The
entire upstream open backlog (33 issues, 12 PRs) was triaged and either resolved
or consciously declined — see [docs/upstream-triage.md](./upstream-triage.md).

`@ubercode/dicom-parser` and `dicom-parser` are **separate npm packages**: this is
not a republish of `dicom-parser`, and installing one does not affect the other.

## Guidance for `dicom-parser` (1.x) consumers

`dicom-parser@1.8.21` still works and is unchanged; there is no forced migration.
When you are ready to move, there are two paths:

1. **Drop-in via the compat façade.** `@ubercode/dicom-parser/compat` reproduces the
   v1 `parseDicom`/`DataSet` surface (including `vrCallback`, `inflater`,
   `TransferSyntaxUID`, `untilTag`), validated tag-for-tag against `dicom-parser@1.8.21`
   across a 199-file corpus. Most call sites migrate with an import swap. Known
   divergences (all upstream-bug fixes) and the small set of unported v1 helpers are
   listed in [docs/migration-v1.md](./migration-v1.md).

2. **Adopt the core API** (recommended for new code and hot paths). `parse(bytes)`
   returns a `ParseResult` with a typed error and partial dataset instead of
   throwing; strings are charset-aware; `stopAt` gives a correct metadata fast path.
   The full v1 → v2 mapping is in [docs/migration-v1.md](./migration-v1.md).

Because the two packages are independent, you can adopt incrementally — run both
side by side and migrate module by module.

## npm dist-tags

During the 2.x pre-release, install an explicit version or the `rc` tag:

```bash
pnpm add @ubercode/dicom-parser@rc     # release candidate
pnpm add @ubercode/dicom-parser@2.0.0  # a specific version
```

The `latest` tag points at the current stable release once 2.0.0 ships.
