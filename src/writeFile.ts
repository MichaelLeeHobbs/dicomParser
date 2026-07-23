/**
 * Part-10 file writing: meta-group generation, whole-file assembly, and
 * round-trip serialization of parsed datasets.
 *
 * @module writeFile
 */

import { DicomDataSet } from './dataSet';
import { DicomError } from './errors';
import type { ParseResult } from './parse';
import { TS_DEFLATED_LE, TS_EXPLICIT_BE, TS_EXPLICIT_LE, TS_GE_PRIVATE_DLX, TS_IMPLICIT_LE } from './parse';
import { toTag, type TagLike } from './tag';
import { encodeDataSet, type EncodeOptions } from './writer';
import { dataSet as buildDataSet, element, toWriteModel, type WriteDataSet, type WriteElement } from './writeModel';

/** Implementation Class UID for generated file meta groups (UUID-derived, 2.25 root). */
export const IMPLEMENTATION_CLASS_UID = '2.25.331717632425659486778196813677143528292';
/** Implementation Version Name for generated file meta groups. */
export const IMPLEMENTATION_VERSION_NAME = 'UBERCODE_DP2';

/** A raw-deflate compressor (mirror of {@link InflateFn}). */
export type DeflateFn = (bytes: Uint8Array) => Uint8Array;

interface ZlibLike {
    deflateRawSync(data: Uint8Array): Uint8Array;
}

function nodeDeflate(): DeflateFn | undefined {
    if (typeof process === 'undefined' || typeof process.getBuiltinModule !== 'function') {
        return undefined;
    }
    const zlib = process.getBuiltinModule('node:zlib') as unknown as ZlibLike;
    return (bytes: Uint8Array): Uint8Array => zlib.deflateRawSync(bytes);
}

/** Options for {@link writeFile}. */
export interface WriteFileOptions {
    /** The main dataset (ascending tag order; see `dataSet()`/`toWriteModel()`). */
    readonly dataSet: WriteDataSet;
    /** Output transfer syntax (default Explicit VR Little Endian). */
    readonly transferSyntax?: string;
    /** 128-byte preamble (default zeros). */
    readonly preamble?: Uint8Array;
    /** Media Storage SOP Class UID; default: the dataset's (0008,0016). */
    readonly sopClassUid?: string;
    /** Media Storage SOP Instance UID; default: the dataset's (0008,0018). */
    readonly sopInstanceUid?: string;
    /** Injected deflater for the deflated transfer syntax. */
    readonly deflate?: DeflateFn;
    /** Charset for string values ('latin1' default, 'utf8' for ISO_IR 192). */
    readonly charset?: EncodeOptions['charset'];
}

function findStringValue(dataSet: WriteDataSet, tag: TagLike): string | undefined {
    const wanted = toTag(tag);
    const found = dataSet.elements.find(el => el.tag === wanted);
    if (found === undefined || found.value.kind !== 'bytes') {
        return found !== undefined && found.value.kind === 'string' ? found.value.value : undefined;
    }
    let end = found.value.bytes.length;
    while (end > 0 && ((found.value.bytes[end - 1] as number) === 0 || (found.value.bytes[end - 1] as number) === 0x20)) {
        end--;
    }
    let out = '';
    for (let i = 0; i < end; i++) {
        out += String.fromCharCode(found.value.bytes[i] as number);
    }
    return out;
}

/**
 * Builds the file meta group (group 0002) with a correct group length.
 *
 * @param transferSyntax - The dataset transfer syntax UID
 * @param sopClassUid - Media Storage SOP Class UID
 * @param sopInstanceUid - Media Storage SOP Instance UID
 * @returns The encoded meta group bytes (always explicit little endian)
 */
export function buildMetaGroup(transferSyntax: string, sopClassUid: string, sopInstanceUid: string): Uint8Array {
    const afterLength = encodeDataSet(
        buildDataSet([
            element(0x00020001, 'OB', Uint8Array.from([0x00, 0x01])),
            element(0x00020002, 'UI', sopClassUid),
            element(0x00020003, 'UI', sopInstanceUid),
            element(0x00020010, 'UI', transferSyntax),
            element(0x00020012, 'UI', IMPLEMENTATION_CLASS_UID),
            element(0x00020013, 'SH', IMPLEMENTATION_VERSION_NAME),
        ]),
        { explicitVr: true }
    );
    const lengthElement = encodeDataSet(buildDataSet([element(0x00020000, 'UL', [afterLength.length])]), { explicitVr: true });
    const out = new Uint8Array(lengthElement.length + afterLength.length);
    out.set(lengthElement, 0);
    out.set(afterLength, lengthElement.length);
    return out;
}

function encodedDataSetFor(options: WriteFileOptions, transferSyntax: string): Uint8Array {
    if (transferSyntax === TS_EXPLICIT_BE || transferSyntax === TS_GE_PRIVATE_DLX) {
        throw new DicomError('unsupported', `transfer syntax ${transferSyntax} is read-only; the write path is little-endian`);
    }
    const explicitVr = transferSyntax !== TS_IMPLICIT_LE;
    const encoded = encodeDataSet(options.dataSet, { explicitVr, ...(options.charset === undefined ? {} : { charset: options.charset }) });
    if (transferSyntax !== TS_DEFLATED_LE) {
        return encoded;
    }
    const deflate = options.deflate ?? nodeDeflate();
    if (deflate === undefined) {
        throw new DicomError('no-inflater', 'deflated transfer syntax: no deflater available — supply options.deflate');
    }
    return deflate(encoded);
}

/**
 * Writes a complete Part-10 file: preamble + `DICM` + generated meta group +
 * encoded dataset.
 *
 * @param options - Dataset, transfer syntax, meta identifiers
 * @returns The file bytes
 * @throws DicomError `invalid-argument`/`unsupported` on unencodable input
 */
export function writeFile(options: WriteFileOptions): Uint8Array {
    const transferSyntax = options.transferSyntax ?? TS_EXPLICIT_LE;
    const preamble = options.preamble ?? new Uint8Array(128);
    if (preamble.length !== 128) {
        throw new DicomError('invalid-argument', `preamble must be 128 bytes, got ${preamble.length}`);
    }
    const sopClassUid = options.sopClassUid ?? findStringValue(options.dataSet, 0x00080016) ?? '';
    const sopInstanceUid = options.sopInstanceUid ?? findStringValue(options.dataSet, 0x00080018) ?? '';
    const meta = buildMetaGroup(transferSyntax, sopClassUid, sopInstanceUid);
    const dataSetBytes = encodedDataSetFor(options, transferSyntax);
    const out = new Uint8Array(128 + 4 + meta.length + dataSetBytes.length);
    out.set(preamble, 0);
    out.set([0x44, 0x49, 0x43, 0x4d], 128);
    out.set(meta, 132);
    out.set(dataSetBytes, 132 + meta.length);
    return out;
}

/**
 * Re-serializes a parsed file: the original preamble/DICM/meta bytes are kept
 * verbatim and the dataset is re-encoded from the parsed model.
 *
 * For conformant little-endian files this is **byte-identical** to the input
 * (the round-trip gate); deflated files re-compress (parse-equal, not
 * byte-equal). Explicit big endian is read-only and raises `unsupported`.
 *
 * @param result - A successful parse result
 * @returns The re-serialized file bytes
 * @throws DicomError `unsupported` for big-endian input; `invalid-argument`
 *         for datasets containing non-re-encodable (unknown-kind) elements
 */
export function serializeParsed(result: ParseResult): Uint8Array {
    if (result.transferSyntax === TS_EXPLICIT_BE) {
        throw new DicomError('unsupported', 'explicit big endian is read-only; re-encode via a little-endian write model instead');
    }
    const model = toWriteModel(result.dataSet);
    const explicitVr = result.transferSyntax !== TS_IMPLICIT_LE;
    let encoded = encodeDataSet(model, { explicitVr });
    if (result.transferSyntax === TS_DEFLATED_LE) {
        const deflate = nodeDeflate();
        if (deflate === undefined) {
            throw new DicomError('no-inflater', 'deflated transfer syntax: no deflater available');
        }
        encoded = deflate(encoded);
    }
    const headerEnd = headerLength(result);
    const out = new Uint8Array(headerEnd + encoded.length);
    out.set(result.bytes.subarray(0, headerEnd), 0);
    out.set(encoded, headerEnd);
    return out;
}

/** Length of the original preamble+DICM+meta section in `result.bytes`. */
function headerLength(result: ParseResult): number {
    let last = 0;
    for (const element of result.meta.elements.values()) {
        last = Math.max(last, element.endOffset);
    }
    return last;
}

/** Edits for {@link modifyDataSet}. */
export interface DataSetEdits {
    /** Elements to add or replace (matched by tag). */
    readonly set?: readonly WriteElement[];
    /** Tags to remove. */
    readonly remove?: readonly TagLike[];
}

/**
 * Builds a write model from a parsed dataset with edits applied
 * (parse → modify → serialize, PLAN.md item 13's edit model).
 *
 * @param parsed - The parsed dataset
 * @param edits - Elements to set (add/replace) and tags to remove
 * @returns The edited write model, in ascending tag order
 */
export function modifyDataSet(parsed: DicomDataSet, edits: DataSetEdits): WriteDataSet {
    const removed = new Set((edits.remove ?? []).map(tag => toTag(tag)));
    const replaced = new Map((edits.set ?? []).map(el => [el.tag, el]));
    const out: WriteElement[] = [];
    for (const el of toWriteModel(parsed).elements) {
        if (removed.has(el.tag)) {
            continue;
        }
        const replacement = replaced.get(el.tag);
        if (replacement !== undefined) {
            out.push(replacement);
            replaced.delete(el.tag);
            continue;
        }
        out.push(el);
    }
    for (const el of replaced.values()) {
        out.push(el);
    }
    return buildDataSet(out);
}
