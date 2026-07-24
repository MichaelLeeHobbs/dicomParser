/**
 * DICOM Part-10 file header: preamble, `DICM` prefix, file meta group.
 *
 * The meta group is always Explicit VR Little Endian (PS3.10 §7.1) regardless
 * of the dataset transfer syntax. Headerless (raw) datasets are supported
 * first-class via the `transferSyntax` option (upstream #48); a missing
 * preamble with `DICM` at offset 0 is tolerated with a warning.
 *
 * @module part10
 */

import { ByteStream } from './byteStream';
import { DEFAULT_CHARSET_CONTEXT } from './charset';
import { DicomDataSet } from './dataSet';
import { DicomError, type ParseWarning } from './errors';
import { readElements } from './tokenizer';
import { TAG_TRANSFER_SYNTAX_UID, tag } from './tag';

/** Options for {@link readPart10Header}. */
export interface Part10Options {
    /**
     * Transfer syntax to assume when the input has no `DICM` prefix (raw
     * dataset). Without it, headerless input is a `not-dicom` error.
     */
    readonly transferSyntax?: string;
    /**
     * Structure cap applied while parsing the file meta group, so a hostile
     * group-2 amplification payload honors a memory-constrained caller's limit
     * instead of only the built-in default (review §3). Note: the meta group and
     * the main dataset are parsed in separate passes, so this bounds each pass.
     */
    readonly maxElements?: number;
    /** Nesting-depth cap applied while parsing the file meta group (review §3). */
    readonly maxDepth?: number;
}

/** Result of {@link readPart10Header}: always populated, even on failure. */
export interface Part10Header {
    /** The file meta group (group 0002) elements; empty when headerless. */
    readonly meta: DicomDataSet;
    /** Transfer Syntax UID from (0002,0010) or the headerless override. */
    readonly transferSyntax: string | undefined;
    /** Offset of the first dataset byte (0 for headerless input). */
    readonly dataSetPosition: number;
    /** `true` when a `DICM` prefix was found. */
    readonly isPart10: boolean;
    /** Warnings recorded while reading the header. */
    readonly warnings: readonly ParseWarning[];
    /** The failure that ended header parsing, or `undefined` on success. */
    readonly error: DicomError | undefined;
}

const DICM = [0x44, 0x49, 0x43, 0x4d] as const;

function hasDicmPrefix(bytes: Uint8Array, at: number): boolean {
    return bytes.length >= at + 4 && DICM.every((byte, i) => bytes[at + i] === byte);
}

/** Decodes a UI-style string value, stripping trailing NUL and space padding. */
export function readUiString(bytes: Uint8Array, dataOffset: number, length: number): string {
    let end = dataOffset + length;
    while (end > dataOffset && (bytes[end - 1] === 0x00 || bytes[end - 1] === 0x20)) {
        end--;
    }
    let result = '';
    for (let i = dataOffset; i < end; i++) {
        result += String.fromCharCode(bytes[i] as number);
    }
    return result;
}

function emptyMeta(bytes: Uint8Array): DicomDataSet {
    return new DicomDataSet(bytes, true, new Map());
}

/**
 * Reads the Part-10 preamble, prefix and file meta group.
 *
 * Never throws for malformed input: failures are reported in the result
 * alongside whatever meta elements were parsed.
 *
 * @param bytes - The complete file bytes
 * @param options - Headerless-input override
 * @returns The header description (see {@link Part10Header})
 * @throws DicomError `invalid-argument` when `bytes` is not a Uint8Array
 */
export function readPart10Header(bytes: Uint8Array, options: Part10Options = {}): Part10Header {
    if (!(bytes instanceof Uint8Array)) {
        throw new DicomError('invalid-argument', 'readPart10Header: bytes must be a Uint8Array');
    }
    const warnings: ParseWarning[] = [];
    let metaPosition: number;
    if (hasDicmPrefix(bytes, 128)) {
        metaPosition = 132;
    } else if (hasDicmPrefix(bytes, 0)) {
        warnings.push({ code: 'missing-preamble', message: 'DICM prefix found at offset 0: the 128-byte preamble is missing', offset: 0 });
        metaPosition = 4;
    } else {
        if (options.transferSyntax !== undefined) {
            return { meta: emptyMeta(bytes), transferSyntax: options.transferSyntax, dataSetPosition: 0, isPart10: false, warnings, error: undefined };
        }
        const error = new DicomError('not-dicom', 'DICM prefix not found: this is not a DICOM Part-10 file (supply options.transferSyntax for raw datasets)', {
            offset: 128,
        });
        return { meta: emptyMeta(bytes), transferSyntax: undefined, dataSetPosition: 0, isPart10: false, warnings, error };
    }
    return readMetaGroup(bytes, metaPosition, warnings, options);
}

/** Parses group-0002 elements (explicit LE) up to the first non-meta tag. */
function readMetaGroup(bytes: Uint8Array, metaPosition: number, warnings: ParseWarning[], options: Part10Options): Part10Header {
    const stream = new ByteStream(bytes, { position: metaPosition, warnings });
    const result = readElements(stream, {
        explicitVr: true,
        stopAt: { tag: tag(0x0003, 0x0000), inclusive: false },
        ...(options.maxElements === undefined ? {} : { maxElements: options.maxElements }),
        ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    });
    const meta = new DicomDataSet(bytes, true, result.elements);
    // Group 2 is always the default repertoire; give meta a context so its string
    // reads use the fast decode path instead of the per-byte fallback (review §3).
    meta.applyCharset(DEFAULT_CHARSET_CONTEXT);
    const tsElement = result.elements.get(TAG_TRANSFER_SYNTAX_UID);
    let transferSyntax: string | undefined;
    let error = result.error;
    if (error === undefined && warnings.some(warning => warning.code === 'unexpected-eof')) {
        // A truncated meta value could silently yield a wrong (prefix) transfer
        // syntax UID — treat meta truncation as a hard error.
        error = new DicomError('malformed', 'file meta group is truncated', { offset: metaPosition });
    }
    if (tsElement !== undefined && tsElement.kind === 'value') {
        transferSyntax = readUiString(bytes, tsElement.dataOffset, tsElement.length);
    } else if (error === undefined) {
        error = new DicomError('malformed', 'file meta group is missing the Transfer Syntax UID (0002,0010)', { offset: metaPosition });
    }
    return { meta, transferSyntax, dataSetPosition: stream.position, isPart10: true, warnings, error };
}
