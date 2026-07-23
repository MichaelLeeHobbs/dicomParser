# Draft: upstream #214 ("Version 2.0 Discussion") offer

Status: DRAFT — not posted. Posting is a deliberate decision for the maintainer to make
after 2.0.0 final ships and has soaked in production.

---

Hi all — over the last stretch I built what this thread describes, as a true fork:
**[@ubercode/dicom-parser](https://github.com/MichaelLeeHobbs/dicomParser)** (npm:
`@ubercode/dicom-parser`), and I'd like to offer it back as the basis for dicomParser 2.0
if there's interest.

What it delivers against this thread's wishlist:

- **ESM-first** dual ESM+CJS build, types generated from TypeScript source (no hand-written
  d.ts) — the top asks here.
- **Element kinds as a discriminated union** (`value | sequence | encapsulated | unknown`)
  with exact byte accounting — the DX pain called out here and in #257/#278.
- **Error instances, not strings** (#46), with the partial dataset attached (#203).
- **DICOM writing** — Part-10 serializer + edit model with byte-identical unmodified
  round trips, the differentiator asked for in this thread.
- The open parser-bug backlog resolved: #281 (SV/UV/OV), #244/#143/#266 (delimiter
  model), #141/#114/#245 (CP-246 + private-SQ policy), #104/#268/#52 (`stopAt`), #146
  (charset-aware strings incl. ISO 2022 CJK), #59/#60, #48, #253, #270/#125/#109
  (inflate strategy), #73 (typed pixel views), #282 posture (fuzzing, bomb caps,
  SECURITY.md).
- **A v1 compat façade** (`/compat`) that reproduces the 1.x API — validated tag-for-tag
  against `dicom-parser@1.8.21` across a 199-file corpus — so dicom-image-loader and
  other consumers can migrate with an import swap while moving to the new API
  incrementally.

Migration guide: `docs/migration-v1.md` in the repo. I'm open to whatever shape is
useful: transferring the work upstream, co-maintaining, or simply existing as a
compatible successor package. No strings attached — the license is MIT with the original
copyright preserved.
