# Migrating from `dicom-parser` 1.x

Two paths: the **compat façade** (minutes, near-zero code change) or the **new core API**
(better types, byte accounting, and error handling).

## Path 1 — the compat façade

```diff
-import dicomParser from 'dicom-parser';
+import dicomParser from '@ubercode/dicom-parser/compat';
```

Everything dcmtk.js-class consumers use keeps working: `parseDicom(bytes, options)` with
`vrCallback` / `inflater` / `TransferSyntaxUID` / `untilTag`, `DataSet` accessors
(`string`, `text`, `uint16`, `int16`, `uint32`, `int32`, `float`, `double`,
`floatString`, `intString`, `numStringValues`, `attributeTag`), `elements` keyed
`'xggggeeee'` with meta (group 0002) merged in, `items` / `fragments` /
`basicOffsetTable` / `hadUndefinedLength` element shapes, and string `warnings`.

### Divergences (deliberate fixes, not regressions)

| v1 behavior                                                              | v2 compat behavior                                                     | Why                                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| FFFE delimitation items appear inside undefined-length items             | never surfaced as elements                                             | upstream #244/#143                                                            |
| item `length` includes the 8-byte item delimiter                         | `length` is content only                                               | consistent byte accounting; use the core model's `endOffset` for exact ranges |
| explicit SV/UV/OV elements derail the parse                              | parsed correctly (long-form VRs)                                       | upstream #280/#281                                                            |
| non-zero delimitation-item lengths crash (buffer overrun)                | warned and treated as zero                                             | upstream #266                                                                 |
| `string()` truncates at the first NUL byte                               | full value, trailing NUL padding stripped                              | upstream #146                                                                 |
| misdetected implicit sequences derail the rest of the file               | element falls back to opaque bytes with a warning                      | upstream #114                                                                 |
| private implicit undefined-length sequences: items parsed then discarded | items kept                                                             | strictly more information                                                     |
| parse failures throw `{ exception, dataSet }` object                     | throws a `DicomError` (an `Error`) with `.dataSet` attached            | upstream #46/#277                                                             |
| `untilTag` matches exactly (`===`), misses absent tags                   | first tag ≥ `untilTag` stops the parse                                 | upstream #104/#268                                                            |
| `attributeTag(tag)` fails on multi-valued AT                             | `attributeTag(tag, index)`                                             | upstream #253                                                                 |
| `inflater` sniffed a global `pako` when absent                           | `node:zlib` / `DecompressionStream` built in; `inflater` still honored | upstream #270/#125                                                            |

## Path 2 — the new core API

| v1                                               | v2 core                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `dicomParser.parseDicom(bytes, opts)` (throws)   | `parse(bytes, opts)` → `ParseResult` (never throws on malformed input)            |
| exception `.dataSet`                             | `result.dataSet` is always present (partial on `!result.ok`)                      |
| meta merged into `dataSet`                       | `result.meta` (group 0002) separate from `result.dataSet`                         |
| `'x00100010'` string tags                        | numeric tags (`0x00100010`) or strings — both accepted                            |
| one `Element` interface, 8 optional fields       | discriminated union: `kind: 'value' \| 'sequence' \| 'encapsulated' \| 'unknown'` |
| `element.length` (delimiters sometimes included) | `length` (value only) + `startOffset`/`dataOffset`/`endOffset` (exact range)      |
| `vrCallback(tagString)`                          | `vrLookup(tag: number)`                                                           |
| `options.inflater(bytes, position)`              | `options.inflate(deflated)` or nothing (built-in strategy)                        |
| `dataSet.warnings: string[]`                     | `result.warnings: { code, message, offset }[]`                                    |
| —                                                | `uint64`/`int64` BigInt accessors, `rawBytes()`, `charset` context                |
| —                                                | writing: `writeFile`, `serializeParsed`, `modifyDataSet`, `encodeDataSet`         |

### Error handling

```ts
const result = parse(bytes);
if (!result.ok) {
    result.error; // DicomError { code, message, offset? }
    result.dataSet; // everything parsed before the failure
    result.warnings; // recoverable anomalies (also populated on success)
}
```

`DicomError.code` values: `invalid-argument`, `buffer-overread`, `not-dicom`,
`malformed`, `unsupported`, `no-inflater`, `depth-exceeded`, `limit-exceeded`.
Prefer the `isDicomError(err)` guard over `err instanceof DicomError` (robust
across the dual ESM/CJS build).

### Known limits of the compat façade

- Deprecated v1 helpers that no consumer we measured uses (`sharedCopy`, `alloc`,
  `readEncapsulatedPixelData`, `explicitDataSetToJS`, `elementToString`) are not
  reproduced; equivalents exist in the core API (`readEncapsulatedImageFrame`,
  `readEncapsulatedPixelDataFromFragments`, `createJpegBasicOffsetTable`).
- Explicit big endian remains read-only (as in v1; the write path is new and LE-only).
