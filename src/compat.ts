/**
 * The v1 compat façade (Phase 4): the upstream `dicom-parser` surface as a
 * thin wrapper over the new core, so existing consumers (dcmtk.js's
 * `_p10ToJson`, cornerstone's dicom-image-loader) can adopt with an import
 * swap.
 *
 * Preserved v1 contracts (docs/porting-notes.md):
 * - `elements` keyed `'x' + 8 lowercase hex`; meta (group 0002) merged in.
 * - `element.vr` present only when explicit (or supplied by `vrCallback`).
 * - `vrCallback(tag)` receives the `'xggggeeee'` string.
 * - `inflater(byteArray, position)` returns header-bytes + inflated combined.
 * - `dataSet.string()` trims trailing whitespace; accessor set matches v1.
 * - Undefined-length elements carry `hadUndefinedLength`; encapsulated pixel
 *   data carries `basicOffsetTable` + `fragments`.
 *
 * Documented divergences (fixes, not bugs):
 * - Delimitation items never appear as elements (upstream #244).
 * - Item `length` excludes the item delimiter; use `endOffset` byte accounting
 *   in the core model when exact ranges are needed.
 * - Private implicit undefined-length sequences keep their parsed `items`
 *   (legacy discarded them).
 * - Parse failures throw a `DicomError` (an `Error`) with the partial
 *   `dataSet` attached — not a bare `{ exception, dataSet }` object. Note that
 *   value-level truncation is a warning, not a failure (the core salvages and
 *   clamps the value), so a file legacy rejected may parse here with a
 *   truncated element and an `odd-length`/`unexpected-eof` warning (review A1).
 * - Deflated files: legacy re-parsed the preamble/DICM bytes as junk elements
 *   (`x00000000`, `x49444d43`, `x4c550004`); those never appear here (review A3).
 * - `untilTag` stops at the first tag ≥ the requested one (≥ semantics), so it
 *   works for absent tags and parses a terminating SQ's items (review A4).
 * - `string()` is charset-aware (honors SpecificCharacterSet), so a value under
 *   a non-Latin charset decodes to real text rather than mojibake (review A5);
 *   consumers that re-decode raw bytes should read the bytes, not `string()`.
 *   With `parseDicom`'s core, `string()` can also decode a value detected as
 *   mislabeled UTF-8 as UTF-8 when `utf8MislabelPromote` is set (review C4).
 * - Accessor edge cases return `undefined` rather than throwing or reading a
 *   neighbor element (out-of-range `string(tag,i)`/`uint16(tag,i)`,
 *   whitespace-only `floatString`), matching the core (review A6).
 *
 * @module compat
 */

import { DicomDataSet } from './dataSet';
import type { DicomElement } from './element';
import { DicomError } from './errors';
import { parse, type ParseResult } from './parse';
import { readPart10Header } from './part10';
import { isPrivateTag as corePrivate, tagFromString, tagToString, toTag, type Tag } from './tag';
import { isStringVr } from './vr';
import { parseDA, parsePN, parseTM } from './valueParsers';
import { VERSION } from './version';

/** A v1-shaped sequence item. */
export interface Item {
    readonly tag: string;
    readonly length: number;
    readonly dataOffset: number;
    readonly hadUndefinedLength?: boolean;
    readonly dataSet?: DataSet;
}

/** A v1-shaped element. */
export interface Element {
    readonly tag: string;
    readonly vr?: string;
    readonly length: number;
    readonly dataOffset: number;
    readonly hadUndefinedLength?: boolean;
    readonly items?: Item[];
    readonly fragments?: { readonly offset: number; readonly position: number; readonly length: number }[];
    readonly basicOffsetTable?: number[];
    readonly encapsulatedPixelData?: boolean;
}

/** Options accepted by {@link parseDicom} (the v1 option names). */
export interface ParseDicomOptions {
    /** VR resolver for implicit elements; receives the `'xggggeeee'` tag. */
    readonly vrCallback?: (tag: string) => string | undefined;
    /** Legacy inflater: receives the full bytes + deflated-data offset. */
    readonly inflater?: (byteArray: Uint8Array, position: number) => Uint8Array;
    /** Transfer syntax for headerless (raw) datasets. */
    readonly TransferSyntaxUID?: string;
    /** Stop parsing at the first root element with tag ≥ this `'xggggeeee'` tag. */
    readonly untilTag?: string;
}

/**
 * The v1 `DataSet`: elements keyed by `'xggggeeee'` plus the accessor set.
 */
export class DataSet {
    /** The bytes element offsets refer to. */
    readonly byteArray: Uint8Array;
    /** Elements keyed `'xggggeeee'`. */
    readonly elements: Record<string, Element>;
    /** Human-readable warnings (v1 shape: strings). */
    warnings: string[];

    private readonly core: DicomDataSet;
    private readonly metaCore: DicomDataSet | undefined;

    constructor(core: DicomDataSet, elements: Record<string, Element>, warnings: string[], metaCore?: DicomDataSet) {
        this.core = core;
        this.byteArray = core.bytes;
        this.elements = elements;
        this.warnings = warnings;
        this.metaCore = metaCore;
    }

    /**
     * Routes low-group reads to the always-little-endian meta dataset — but only
     * when the tag actually lives there. A group 0000/0001 element that appears
     * in the main dataset (non-standard but real) must still be read from the
     * core, not silently return `undefined` (review A2).
     */
    private pick(tag: string): DicomDataSet {
        if (this.metaCore !== undefined && toTag(tag) < 0x00030000 && this.metaCore.elements.has(toTag(tag))) {
            return this.metaCore;
        }
        return this.core;
    }

    /** Reads an unsigned 16-bit value at `index`. */
    uint16(tag: string, index = 0): number | undefined {
        return this.pick(tag).uint16(tag, index);
    }

    /** Reads a signed 16-bit value at `index`. */
    int16(tag: string, index = 0): number | undefined {
        return this.pick(tag).int16(tag, index);
    }

    /** Reads an unsigned 32-bit value at `index`. */
    uint32(tag: string, index = 0): number | undefined {
        return this.pick(tag).uint32(tag, index);
    }

    /** Reads a signed 32-bit value at `index`. */
    int32(tag: string, index = 0): number | undefined {
        return this.pick(tag).int32(tag, index);
    }

    /** Reads a 32-bit float (v1 name) at `index`. */
    float(tag: string, index = 0): number | undefined {
        return this.pick(tag).float32(tag, index);
    }

    /** Reads a 64-bit float (v1 name) at `index`. */
    double(tag: string, index = 0): number | undefined {
        return this.pick(tag).float64(tag, index);
    }

    /** Number of backslash-separated string values. */
    numStringValues(tag: string): number | undefined {
        return this.pick(tag).numStringValues(tag);
    }

    /** String value with leading/trailing whitespace trimmed. */
    string(tag: string, index?: number): string | undefined {
        return this.pick(tag).string(tag, index);
    }

    /** String value with only trailing spaces removed. */
    text(tag: string, index?: number): string | undefined {
        return this.pick(tag).text(tag, index);
    }

    /** Parses the string value at `index` as a float. */
    floatString(tag: string, index = 0): number | undefined {
        return this.pick(tag).floatString(tag, index);
    }

    /** Parses the string value at `index` as an integer. */
    intString(tag: string, index = 0): number | undefined {
        return this.pick(tag).intString(tag, index);
    }

    /** AT value as an `'xggggeeee'` string (indexed, upstream #253). */
    attributeTag(tag: string, index = 0): string | undefined {
        const value = this.pick(tag).attributeTag(tag, index);
        return value === undefined ? undefined : tagToString(value);
    }
}

interface ConvertJob {
    readonly source: DicomDataSet;
    readonly out: Record<string, Element>;
    readonly assign: (dataSet: DataSet) => void;
}

/** Converts a core element to the v1 shape (items filled by the walker). */
function convertElement(el: DicomElement): { compat: Element; itemsOut: Item[] | undefined } {
    const base = {
        tag: tagToString(el.tag),
        length: el.length,
        dataOffset: el.dataOffset,
        ...(el.vr === undefined ? {} : { vr: el.vr }),
        ...(el.hadUndefinedLength ? { hadUndefinedLength: true } : {}),
    };
    if (el.kind === 'sequence') {
        const itemsOut: Item[] = [];
        return { compat: { ...base, items: itemsOut }, itemsOut };
    }
    if (el.kind === 'encapsulated') {
        return {
            compat: {
                ...base,
                // legacy encapsulated length included the trailing delimiter
                length: el.endOffset - el.dataOffset,
                encapsulatedPixelData: true,
                basicOffsetTable: [...el.basicOffsetTable],
                fragments: el.fragments.map(f => ({ offset: f.offset, position: f.position, length: f.length })),
            },
            itemsOut: undefined,
        };
    }
    return { compat: base, itemsOut: undefined };
}

/** Builds the v1 DataSet tree from a core dataset (iterative walk). */
function toCompatDataSet(core: DicomDataSet, warnings: string[], meta?: DicomDataSet): DataSet {
    let root: DataSet | undefined;
    const jobs: ConvertJob[] = [
        {
            source: core,
            out: {},
            assign: (ds): void => {
                root = ds;
            },
        },
    ];
    while (jobs.length > 0) {
        const job = jobs.pop() as ConvertJob;
        fillElements(job, jobs);
        if (meta !== undefined && job.source === core) {
            for (const el of meta.elements.values()) {
                const { compat } = convertElement(el);
                job.out[compat.tag] = compat;
            }
            job.assign(new DataSet(job.source, job.out, warnings, meta));
            continue;
        }
        job.assign(new DataSet(job.source, job.out, warnings));
    }
    return root as DataSet;
}

function fillElements(job: ConvertJob, jobs: ConvertJob[]): void {
    for (const el of job.source.elements.values()) {
        const { compat, itemsOut } = convertElement(el);
        job.out[compat.tag] = compat;
        if (el.kind !== 'sequence' || itemsOut === undefined) {
            continue;
        }
        for (const item of el.items) {
            const compatItem = {
                tag: 'xfffee000',
                length: item.length,
                dataOffset: item.dataOffset,
                ...(item.hadUndefinedLength ? { hadUndefinedLength: true } : {}),
            };
            const index = itemsOut.push(compatItem) - 1;
            jobs.push({
                source: item.dataSet,
                out: {},
                assign: ds => {
                    itemsOut[index] = { ...compatItem, dataSet: ds };
                },
            });
        }
    }
}

function coreOptions(options: ParseDicomOptions, bytes: Uint8Array): Parameters<typeof parse>[1] {
    const vrCallback = options.vrCallback;
    return {
        ...(vrCallback === undefined ? {} : { vrLookup: (tag: Tag): string | undefined => vrCallback(tagToString(tag)) }),
        ...(options.TransferSyntaxUID === undefined ? {} : { transferSyntax: options.TransferSyntaxUID }),
        ...(options.untilTag === undefined ? {} : { stopAt: { tag: tagFromString(options.untilTag), inclusive: true } }),
        ...(options.inflater === undefined ? {} : { inflate: legacyInflate(options.inflater, bytes) }),
    };
}

/** Adapts the legacy inflater contract to the core's deflated-bytes-in/out. */
function legacyInflate(inflater: NonNullable<ParseDicomOptions['inflater']>, bytes: Uint8Array): (deflated: Uint8Array) => Uint8Array {
    return (): Uint8Array => {
        const header = readPart10Header(bytes);
        const combined = inflater(bytes, header.dataSetPosition);
        return combined.subarray(header.dataSetPosition);
    };
}

function buildCompatResult(result: ParseResult): DataSet {
    const warnings = result.warnings.map(w => w.message);
    // meta offsets stay valid in result.bytes (the header bytes are preserved
    // verbatim even for deflated files), but always read little-endian
    const meta = new DicomDataSet(result.bytes, true, result.meta.elements);
    return toCompatDataSet(result.dataSet, warnings, meta);
}

/**
 * The v1 entry point: parses a Part-10 byte array into a {@link DataSet} with
 * meta (group 0002) elements merged in.
 *
 * @param byteArray - The file bytes
 * @param options - v1 options (`vrCallback`, `inflater`, `TransferSyntaxUID`, `untilTag`)
 * @returns The parsed v1 DataSet
 * @throws DicomError on parse failure, with the partial v1 `dataSet` attached
 *         as a property (replaces the legacy `{ exception, dataSet }` throw)
 */
export function parseDicom(byteArray: Uint8Array, options: ParseDicomOptions = {}): DataSet {
    const result = parse(byteArray, coreOptions(options, byteArray));
    const dataSet = buildCompatResult(result);
    if (result.error !== undefined) {
        const error = result.error as DicomError & { dataSet?: DataSet };
        error.dataSet = dataSet;
        throw error;
    }
    return dataSet;
}

/** v1 helper: tests whether an `'xggggeeee'` tag is private (odd group). */
export function isPrivateTag(tag: string): boolean {
    return corePrivate(toTag(tag));
}

/** The v1-style namespace object (`import dicomParser from '.../compat'`). */
const dicomParser = {
    parseDicom,
    isPrivateTag,
    isStringVr,
    parseDA,
    parseTM,
    parsePN,
    version: VERSION,
};

export default dicomParser;
export { isStringVr, parseDA, parsePN, parseTM };
