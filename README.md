# @ubercode/dicom-parser

[![npm version](https://img.shields.io/npm/v/@ubercode/dicom-parser)](https://www.npmjs.com/package/@ubercode/dicom-parser)
[![npm downloads](https://img.shields.io/npm/dm/@ubercode/dicom-parser)](https://www.npmjs.com/package/@ubercode/dicom-parser)
[![CI](https://github.com/MichaelLeeHobbs/dicomParser/actions/workflows/ci.yml/badge.svg)](https://github.com/MichaelLeeHobbs/dicomParser/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@ubercode/dicom-parser)](./LICENSE)

A ground-up TypeScript remake of [cornerstonejs/dicomParser](https://github.com/cornerstonejs/dicomParser)
that **parses and writes** DICOM Part-10 with **zero runtime dependencies** — Node and browser.

- **Reads**: explicit/implicit VR, little/big endian, deflated, encapsulated pixel data,
  post-2019 VRs (SV/UV/OV with BigInt), CP-246 `UN` sequences, charset-aware strings
  (SpecificCharacterSet incl. ISO 2022 CJK), headerless datasets.
- **Writes**: Part-10 assembly with generated meta group, explicit/implicit LE, deflated,
  sequences (defined and undefined length), encapsulated fragment pass-through, and a
  parse -> modify -> serialize edit model. Unmodified round trips are **byte-identical**.
- **Safe on hostile input**: no recursion, bounded loops, bounds-checked reads, deflate-bomb
  caps, fuzzed with fast-check. Parse failures return typed errors _with the partial dataset_.
- **v1 compatible**: a `compat` export reproduces the upstream `dicom-parser` API for
  drop-in migration.

This is v2.x of the dicomParser lineage — the entire upstream open backlog (33 issues,
12 PRs) was triaged and resolved or consciously declined; see `docs/upstream-triage.md`.

## Install

```bash
pnpm add @ubercode/dicom-parser   # or npm i / yarn add
```

## Quick start — parsing

```ts
import { parse } from '@ubercode/dicom-parser';
import { readFileSync } from 'node:fs';

// `parse` accepts a Node Buffer directly (zero-copy, byteOffset honored) —
// `new Uint8Array(...)` is only needed if you want to detach from the Buffer pool.
const result = parse(readFileSync('ct.dcm'));

if (!result.ok) {
    // typed error + everything parsed before the failure point
    console.error(result.error?.code, result.error?.message);
}

result.dataSet.string('x00100010'); // 'Doe^Jane' (charset-aware)
result.dataSet.uint16(0x00280010); // 512 — tags as numbers or 'xggggeeee' strings
result.dataSet.uint64('x00091001'); // BigInt for SV/UV
result.transferSyntax; // '1.2.840.10008.1.2.1'
result.meta.string('x00020002'); // file meta group is separate from the dataset
result.warnings; // structured { code, message, offset } anomalies

const pixelData = result.dataSet.element('x7fe00010');
// discriminated union: 'value' | 'sequence' | 'encapsulated' | 'unknown'
if (pixelData?.kind === 'encapsulated') {
    pixelData.fragments; // [{ offset, position, length }, ...]
    pixelData.basicOffsetTable;
}
```

Browser with deflated files (no zlib): `await parseAsync(bytes)` uses
`DecompressionStream('deflate-raw')`.

### Metadata-only fast path

```ts
// stop before pixel data — >= comparison, works even if the tag is absent.
// The core default is exclusive, so the triggering element is not parsed;
// pass `inclusive: true` to include it. (The /compat façade pins `true`.)
const result = parse(bytes, { stopAt: { tag: 'x7fe00010' } });
```

### Lenient-mode options

| Option                          | Purpose                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `transferSyntax`                | parse raw/headerless datasets (no `DICM` prefix)                                                 |
| `vrLookup`                      | supply VRs for implicit files; returning `'SQ'` enables CP-246 `UN` and private sequence parsing |
| `charset: { assume, fallback }` | charset for files without/with-broken (0008,0005)                                                |
| `maxInflatedBytes`              | deflate-bomb cap (default 256 MiB)                                                               |
| `maxDepth`                      | sequence nesting bound (default 128)                                                             |
| `inflate`                       | injected inflater (replaces the old global-pako sniffing)                                        |

## Quick start — writing

```ts
import { writeFile, dataSet, element, item, parse, modifyDataSet } from '@ubercode/dicom-parser';

// from scratch
const file = writeFile({
    dataSet: dataSet([
        element('00080016', 'UI', '1.2.840.10008.5.1.4.1.1.7'),
        element('00080018', 'UI', '1.2.3.4.5'),
        element('00100010', 'PN', 'Doe^Jane'),
        element('00280010', 'US', [512]),
        element('00081140', 'SQ', [item([element('00080100', 'SH', 'AB')])]),
    ]),
});

// parse -> modify -> serialize
const parsed = parse(file);
const edited = writeFile({
    dataSet: modifyDataSet(parsed.dataSet, {
        set: [element('00100010', 'PN', 'Doe^John')],
        remove: ['x00081140'],
    }),
});
```

`serializeParsed(parsed)` re-encodes a parsed file; for conformant little-endian files the
output is byte-identical to the input (verified across the test corpus in CI).

## Migrating from `dicom-parser` 1.x

The `compat` export is the v1 API:

```ts
import dicomParser from '@ubercode/dicom-parser/compat';

const dataSet = dicomParser.parseDicom(bytes, { vrCallback, inflater });
dataSet.string('x00100010');
dataSet.elements['x7fe00010'].fragments;
```

See [docs/migration-v1.md](./docs/migration-v1.md) for the mapping and divergence list
(all divergences are upstream-bug fixes, e.g. delimiter items no longer leak into
`elements`).

## Charset support

`string()`/`text()` decode through SpecificCharacterSet (0008,0005) — upstream #146:

| Repertoire       | Terms                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| Single-byte      | ISO_IR 6, 100, 101, 109, 110, 144, 127, 126, 138, 148, 166, 203           |
| Multi-byte       | ISO_IR 192 (UTF-8), GB18030, GBK, ISO_IR 13 (Shift_JIS)                   |
| ISO 2022 escapes | IR 6/13/87/159 (JP), IR 149 (KR), IR 58 (CN), single-byte G1 designations |

Values decode **then** split, so 0x5C trail bytes in multi-byte encodings never corrupt
multi-value splitting. Sequence items inherit the dataset charset and may override it.
Raw bytes stay reachable via `dataSet.rawBytes(tag)`.

## Codec handoff (compressed pixel data)

This library does not decompress pixel data (same stance as upstream). It hands you exact
fragment byte ranges to feed a codec:

```ts
import { readEncapsulatedImageFrame, readEncapsulatedPixelDataFromFragments } from '@ubercode/dicom-parser';

const frame = readEncapsulatedImageFrame(result.bytes, pixelDataElement, 0); // via basic offset table
const frag = readEncapsulatedPixelDataFromFragments(result.bytes, pixelDataElement, 0, 3);
// -> pass to @cornerstonejs/codec-* / your JPEG/J2K/RLE decoder
```

For native pixel data, `nativePixelDataView(dataSet)` returns a correctly-typed
`Uint8/Int8/Uint16/Int16Array` view from BitsAllocated/PixelRepresentation.

## API documentation

Generated from source with TypeDoc: run `pnpm run docs` (output in `docs-site/`).
Every public symbol carries TSDoc.

## Security

This library treats all input as untrusted; see [SECURITY.md](./SECURITY.md) for the
reporting process. Please use private vulnerability reporting — never public issues.

## License and lineage

MIT. Original work (c) Chris Hafey and cornerstonejs/dicomParser contributors; this fork
continues the version lineage as 2.x. The legacy 1.x changelog is preserved in
[legacy-CHANGELOG.md](./legacy-CHANGELOG.md).
