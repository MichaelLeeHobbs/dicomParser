/**
 * Parse entry points: `parse` (sync) and `parseAsync` (adds the
 * `DecompressionStream` inflate path for browsers).
 *
 * Both return a {@link ParseResult} instead of throwing on malformed input:
 * the partially-parsed dataset and meta group are always available alongside
 * the typed error (upstream #46/#203/#277).
 *
 * @module parse
 */

import { ByteStream } from './byteStream';
import { isProbableUtf8Mislabel, LATIN1_CHARSET_CONTEXT, resolveCharsetContext, type CharsetContext, type CharsetOptions } from './charset';
import { DicomDataSet } from './dataSet';
import { DicomError, type ParseWarning } from './errors';
import { inflateRaw, inflateRawAsync, type InflateFn } from './inflate';
import { readPart10Header, type Part10Header } from './part10';
import { readElements, type StopAtOption } from './tokenizer';
import type { VrLookup } from './elementHeader';
import { TAG_SPECIFIC_CHARACTER_SET, tagToString, type Tag } from './tag';
import { isCharsetAffectedVr } from './vr';
import { readUiString } from './part10';

/** Implicit VR Little Endian. */
export const TS_IMPLICIT_LE = '1.2.840.10008.1.2';
/** Explicit VR Little Endian. */
export const TS_EXPLICIT_LE = '1.2.840.10008.1.2.1';
/** Deflated Explicit VR Little Endian. */
export const TS_DEFLATED_LE = '1.2.840.10008.1.2.1.99';
/** Explicit VR Big Endian (retired; read-only support). */
export const TS_EXPLICIT_BE = '1.2.840.10008.1.2.2';
/** GE private Implicit VR Big Endian DLX — recognized but unsupported (#107). */
export const TS_GE_PRIVATE_DLX = '1.2.840.113619.5.2';

/** Options for {@link parse} and {@link parseAsync}. */
export interface ParseOptions {
    /** Transfer syntax for headerless (raw) datasets — upstream #48. */
    readonly transferSyntax?: string;
    /** VR source for implicit-VR elements. */
    readonly vrLookup?: VrLookup;
    /** Stop condition with ≥ semantics (root-level elements only). */
    readonly stopAt?: StopAtOption;
    /** Maximum sequence nesting depth (default 128). */
    readonly maxDepth?: number;
    /** Maximum total structures (elements + items + fragments); default 1,000,000. */
    readonly maxElements?: number;
    /** Injected raw-deflate inflater for the deflated transfer syntax. */
    readonly inflate?: InflateFn;
    /** Charset handling for string decoding (#146): assume/fallback names. */
    readonly charset?: CharsetOptions;
    /**
     * Decode values detected as mislabeled UTF-8 (a single-byte charset whose
     * bytes are valid UTF-8 with multi-byte sequences) as UTF-8 instead of the
     * declared charset. A `utf8-mislabel` warning is emitted regardless; this
     * only changes the decoded value. Detection needs an explicit VR, so it is
     * skipped for implicit-VR text elements without a `vrLookup`.
     *
     * The heuristic is inherently ambiguous for short values: a 2-byte all-caps
     * Cyrillic (ISO_IR 144) pair such as `ЮГ` is also valid UTF-8, so it may be
     * warned (and, with this flag, mis-promoted). Because promotion is opt-in
     * and off by default, the default cost is only an advisory warning; enable
     * this only when you expect mislabeled UTF-8 in single-byte-declared files.
     */
    readonly utf8MislabelPromote?: boolean;
    /** Maximum inflated size in bytes for deflated files (default 256 MiB). */
    readonly maxInflatedBytes?: number;
}

/** Result of {@link parse}/{@link parseAsync}: always populated. */
export interface ParseResult {
    /** `true` when parsing completed without error. */
    readonly ok: boolean;
    /** The file meta group (group 0002); empty for headerless input. */
    readonly meta: DicomDataSet;
    /** The main dataset (partial when {@link error} is set). */
    readonly dataSet: DicomDataSet;
    /** The transfer syntax the dataset was parsed with ('' when unknown). */
    readonly transferSyntax: string;
    /**
     * The bytes that element offsets refer to. Identical to the input except
     * for deflated files, where it is preamble+meta plus the inflated dataset.
     */
    readonly bytes: Uint8Array;
    /** All warnings recorded while parsing (header + dataset). */
    readonly warnings: readonly ParseWarning[];
    /** The failure that ended parsing, or `undefined` on success. */
    readonly error: DicomError | undefined;
    /** The tag that triggered `stopAt`, when parsing stopped early. */
    readonly stoppedAt: Tag | undefined;
}

interface Plan {
    readonly header: Part10Header;
    readonly transferSyntax: string;
    readonly explicitVr: boolean;
    readonly littleEndian: boolean;
    readonly deflated: boolean;
    readonly compressed: boolean;
    readonly error: DicomError | undefined;
}

/** Uncompressed (native pixel data) transfer syntaxes. */
const NATIVE_TRANSFER_SYNTAXES: ReadonlySet<string> = new Set([TS_IMPLICIT_LE, TS_EXPLICIT_LE, TS_DEFLATED_LE, TS_EXPLICIT_BE]);

function failed(header: Part10Header, bytes: Uint8Array, transferSyntax: string, error: DicomError): ParseResult {
    return {
        ok: false,
        meta: header.meta,
        dataSet: new DicomDataSet(bytes, true, new Map()),
        transferSyntax,
        bytes,
        warnings: header.warnings,
        error,
        stoppedAt: undefined,
    };
}

/** Reads the header and decides VR mode, endianness and deflate handling. */
function planParse(bytes: Uint8Array, options: ParseOptions): Plan {
    const header = readPart10Header(bytes, options);
    const transferSyntax = header.transferSyntax ?? '';
    let error = header.error;
    if (error === undefined && transferSyntax === TS_GE_PRIVATE_DLX) {
        error = new DicomError('unsupported', `transfer syntax ${TS_GE_PRIVATE_DLX} (GE private Implicit VR Big Endian DLX) is not supported`);
    }
    return {
        header,
        transferSyntax,
        explicitVr: transferSyntax !== TS_IMPLICIT_LE,
        littleEndian: transferSyntax !== TS_EXPLICIT_BE,
        deflated: transferSyntax === TS_DEFLATED_LE,
        compressed: transferSyntax !== '' && !NATIVE_TRANSFER_SYNTAXES.has(transferSyntax),
        error,
    };
}

/** Splices preamble+meta bytes together with the inflated dataset bytes. */
function spliceInflated(bytes: Uint8Array, dataSetPosition: number, inflated: Uint8Array): Uint8Array {
    const total = dataSetPosition + inflated.length;
    let full: Uint8Array;
    try {
        full = new Uint8Array(total);
    } catch (cause) {
        // an oversized caller-supplied maxInflatedBytes can push this past the
        // maximum typed-array length; surface it as a typed error, not a RangeError
        throw new DicomError('malformed', `deflated transfer syntax: inflated dataset (${total} bytes) is too large to materialize`, { cause });
    }
    full.set(bytes.subarray(0, dataSetPosition), 0);
    full.set(inflated, dataSetPosition);
    return full;
}

/** Raw latin-1 (0008,0005) value of a dataset, or undefined. */
function rawSpecificCharacterSet(dataSet: DicomDataSet): string | undefined {
    const element = dataSet.elements.get(TAG_SPECIFIC_CHARACTER_SET);
    if (element === undefined || element.kind !== 'value' || element.length === 0) {
        return undefined;
    }
    return readUiString(dataSet.bytes, element.dataOffset, element.length);
}

/** Resolves a context leniently: unsupported charsets warn and decode as Latin-1. */
function resolveLenient(raw: string | undefined, options: ParseOptions, warnings: ParseWarning[]): CharsetContext {
    try {
        const context = resolveCharsetContext(raw, options.charset ?? {});
        if (context.aliased) {
            const message = `bare ISO_IR term in a code-extension SpecificCharacterSet ('${String(raw)}') read as its ISO 2022 equivalent`;
            // dedupe: the same (0008,0005) value repeated across sequence items warns once
            if (!warnings.some(w => w.code === 'nonstandard-charset' && w.message === message)) {
                warnings.push({ code: 'nonstandard-charset', message, offset: 0 });
            }
        }
        return context;
    } catch (thrown) {
        if (!(thrown instanceof DicomError)) {
            throw thrown;
        }
        warnings.push({ code: 'unsupported-charset', message: `${thrown.message}; strings decode as Latin-1`, offset: 0 });
        return LATIN1_CHARSET_CONTEXT;
    }
}

/** Parse-wide state for UTF-8 mislabel detection across the dataset tree. */
interface MislabelState {
    readonly promote: boolean;
    /** Tags already warned about (one warning per distinct tag per parse). */
    readonly seen: Set<Tag>;
    readonly warnings: ParseWarning[];
}

/**
 * Detects charset-affected values (SH/LO/ST/LT/UC/UT/PN) under a single-byte
 * context that are probably mislabeled UTF-8: emits one `utf8-mislabel` warning
 * per distinct tag, and — when promoting — marks them to decode as UTF-8.
 */
function detectUtf8Mislabels(dataSet: DicomDataSet, context: CharsetContext, state: MislabelState): void {
    if (!context.singleByte) {
        return;
    }
    const promoted = new Set<Tag>();
    for (const element of dataSet.elements.values()) {
        if (element.kind !== 'value' || !isCharsetAffectedVr(element.vr)) {
            continue;
        }
        if (!isProbableUtf8Mislabel(dataSet.bytes.subarray(element.dataOffset, element.dataOffset + element.length))) {
            continue;
        }
        if (!state.seen.has(element.tag)) {
            state.seen.add(element.tag);
            const action = state.promote ? 'decoded as UTF-8' : `decoded as '${context.terms.join('\\')}'`;
            state.warnings.push({
                code: 'utf8-mislabel',
                message: `possible UTF-8 mislabel: ${tagToString(element.tag)} (${action})`,
                offset: element.dataOffset,
            });
        }
        promoted.add(element.tag);
    }
    if (state.promote && promoted.size > 0) {
        dataSet.applyUtf8Promotion(promoted);
    }
}

/**
 * Assigns charset contexts across the dataset tree (iterative walk): each item
 * dataset inherits its parent's context unless it carries its own (0008,0005).
 * Runs UTF-8 mislabel detection per dataset so warnings exist at parse time.
 */
function assignCharsets(root: DicomDataSet, options: ParseOptions, warnings: ParseWarning[]): void {
    const state: MislabelState = { promote: options.utf8MislabelPromote === true, seen: new Set<Tag>(), warnings };
    const queue: { dataSet: DicomDataSet; context: CharsetContext }[] = [
        { dataSet: root, context: resolveLenient(rawSpecificCharacterSet(root), options, warnings) },
    ];
    while (queue.length > 0) {
        const { dataSet, context } = queue.pop() as { dataSet: DicomDataSet; context: CharsetContext };
        dataSet.applyCharset(context);
        detectUtf8Mislabels(dataSet, context, state);
        for (const element of dataSet.elements.values()) {
            if (element.kind !== 'sequence') {
                continue;
            }
            for (const item of element.items) {
                const own = rawSpecificCharacterSet(item.dataSet);
                queue.push({ dataSet: item.dataSet, context: own === undefined ? context : resolveLenient(own, options, warnings) });
            }
        }
    }
}

function parseDataSet(plan: Plan, bytes: Uint8Array, options: ParseOptions): ParseResult {
    const warnings = [...plan.header.warnings];
    const stream = new ByteStream(bytes, { position: plan.header.dataSetPosition, littleEndian: plan.littleEndian, warnings });
    const result = readElements(stream, {
        explicitVr: plan.explicitVr,
        compressedTransferSyntax: plan.compressed,
        ...(options.vrLookup === undefined ? {} : { vrLookup: options.vrLookup }),
        ...(options.stopAt === undefined ? {} : { stopAt: options.stopAt }),
        ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
        ...(options.maxElements === undefined ? {} : { maxElements: options.maxElements }),
    });
    const dataSet = new DicomDataSet(bytes, plan.littleEndian, result.elements);
    assignCharsets(dataSet, options, warnings);
    return {
        ok: result.error === undefined,
        meta: plan.header.meta,
        dataSet,
        transferSyntax: plan.transferSyntax,
        bytes,
        warnings,
        error: result.error,
        stoppedAt: result.stoppedAt,
    };
}

/**
 * Parses a DICOM Part-10 file (or raw dataset via `options.transferSyntax`).
 *
 * Deflated files use `options.inflate` or `node:zlib`; in environments with
 * neither (browsers without an injected inflater), the result carries a
 * `no-inflater` error — use {@link parseAsync} there.
 *
 * @param bytes - The complete file bytes
 * @param options - Parse options
 * @returns The parse result; never throws for malformed input
 * @throws DicomError `invalid-argument` when `bytes` is not a Uint8Array
 */
export function parse(bytes: Uint8Array, options: ParseOptions = {}): ParseResult {
    const plan = planParse(bytes, options);
    if (plan.error !== undefined) {
        return failed(plan.header, bytes, plan.transferSyntax, plan.error);
    }
    let dataBytes = bytes;
    if (plan.deflated) {
        try {
            const inflated = inflateRaw(bytes.subarray(plan.header.dataSetPosition), {
                ...(options.inflate === undefined ? {} : { inflate: options.inflate }),
                ...(options.maxInflatedBytes === undefined ? {} : { maxInflatedBytes: options.maxInflatedBytes }),
            });
            dataBytes = spliceInflated(bytes, plan.header.dataSetPosition, inflated);
        } catch (thrown) {
            if (!(thrown instanceof DicomError)) {
                throw thrown;
            }
            return failed(plan.header, bytes, plan.transferSyntax, thrown);
        }
    }
    return parseDataSet(plan, dataBytes, options);
}

/**
 * Like {@link parse}, adding the `DecompressionStream('deflate-raw')` inflate
 * path so deflated files parse in browsers without an injected inflater.
 *
 * @param bytes - The complete file bytes
 * @param options - Parse options
 * @returns The parse result; never rejects for malformed input
 * @throws DicomError `invalid-argument` when `bytes` is not a Uint8Array
 */
export async function parseAsync(bytes: Uint8Array, options: ParseOptions = {}): Promise<ParseResult> {
    const plan = planParse(bytes, options);
    if (plan.error !== undefined) {
        return failed(plan.header, bytes, plan.transferSyntax, plan.error);
    }
    let dataBytes = bytes;
    if (plan.deflated) {
        try {
            const inflated = await inflateRawAsync(bytes.subarray(plan.header.dataSetPosition), {
                ...(options.inflate === undefined ? {} : { inflate: options.inflate }),
                ...(options.maxInflatedBytes === undefined ? {} : { maxInflatedBytes: options.maxInflatedBytes }),
            });
            dataBytes = spliceInflated(bytes, plan.header.dataSetPosition, inflated);
        } catch (thrown) {
            if (!(thrown instanceof DicomError)) {
                throw thrown;
            }
            return failed(plan.header, bytes, plan.transferSyntax, thrown);
        }
    }
    return parseDataSet(plan, dataBytes, options);
}
