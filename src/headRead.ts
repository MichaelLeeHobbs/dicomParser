/**
 * Bounded / streaming head-read: parses a Part-10 file's metadata while skipping
 * bulk value bytes (PixelData and other OB/OW/OD/OF/OL/OV values), so peak memory
 * is proportional to the metadata rather than the file (fork #59).
 *
 * The reader is a {@link RangeReader} over `(read, size)` — an in-memory buffer,
 * an `fs` descriptor, or S3 ranged GETs all fit. Only *provably-bulk* values are
 * skipped; everything ambiguous (sequences, short/string VRs) is copied and
 * parsed normally, so the metadata result is identical to a whole-file parse.
 *
 * Implementation: a forward walker reads element headers, records the skipped
 * bulk ranges, and emits the kept bytes into a compacted buffer which the proven
 * {@link parse} re-reads — so no tokenizer semantics are re-implemented. Extents
 * of undefined-length constructs are measured by the real tokenizer over a
 * window; encapsulated PixelData is skipped by hopping fragment item-headers.
 * Deflated transfer syntax cannot be seeked, so the whole file is read.
 *
 * @module headRead
 */

import { ByteStream } from './byteStream';
import type { CharsetOptions } from './charset';
import { DicomDataSet } from './dataSet';
import { DicomError, type ParseWarning } from './errors';
import { readExplicitElementHeader, readImplicitElementHeader, type ElementHeader, type VrLookup } from './elementHeader';
import { NATIVE_TRANSFER_SYNTAXES, parse, TS_DEFLATED_LE, TS_EXPLICIT_BE, TS_GE_PRIVATE_DLX, TS_IMPLICIT_LE } from './parse';
import { readPart10Header } from './part10';
import { TAG_ITEM, TAG_PIXEL_DATA, TAG_SEQUENCE_DELIMITATION, tagToString, toTag, UNDEFINED_LENGTH, type Tag } from './tag';
import { readElements, type ReadElementsResult, type StopAtTagOption } from './tokenizer';

/** Value representations whose defined-length value bytes are skippable bulk. */
const BULK_VRS: ReadonlySet<string> = new Set(['OB', 'OW', 'OD', 'OF', 'OL', 'OV']);
/**
 * Read-ahead window (bytes) for header/metadata reads. Amortizes reader round
 * trips (one read covers many element headers) while staying small enough that
 * skipping a large bulk value still avoids reading most of it — a larger window
 * would pull bulk bytes into the read-ahead buffer and erode the memory win.
 */
const READ_AHEAD = 8 * 1024;
/** Initial window for measuring an undefined-length construct via the tokenizer. */
const MEASURE_WINDOW = 8 * 1024;

/** A random-access source of file bytes; reads may be sync or async. */
export interface RangeReader {
    /** Reads `length` bytes starting at `offset` (may return fewer at EOF). */
    read(offset: number, length: number): Uint8Array | Promise<Uint8Array>;
    /** Total size of the source in bytes. */
    readonly size: number;
}

/** File-absolute byte range of a value that was skipped rather than read. */
export interface BulkRange {
    /** Offset of the value's first byte in the source. */
    readonly offset: number;
    /** Value length in bytes (clamped to the source size on truncation). */
    readonly length: number;
    /**
     * The VR the walker saw: the explicit VR from the file, or `vrLookup`'s
     * answer for an implicit-VR element; `undefined` when neither is available.
     * For encapsulated PixelData this is the declared VR (`OB`/`OW`), not the
     * DCMTK-normalized `OB` — use {@link encapsulated} to apply that yourself.
     */
    readonly vr?: string;
    /**
     * `true` when the range covers an encapsulated (undefined-length, fragmented)
     * PixelData value; `false` for a plain defined-length bulk value.
     */
    readonly encapsulated?: boolean;
}

/** Options for {@link parseHeadAsync} (the subset of parse options that applies). */
export interface HeadOptions {
    /** VR source for implicit-VR elements (the core is dictionary-free). */
    readonly vrLookup?: VrLookup;
    /** Charset handling for string decoding. */
    readonly charset?: CharsetOptions;
    /** Maximum sequence nesting depth. */
    readonly maxDepth?: number;
    /** Maximum total structures (amplification-bomb bound). */
    readonly maxElements?: number;
    /** Transfer syntax for headerless (raw) datasets — no `DICM` prefix. */
    readonly transferSyntax?: string;
    /**
     * Stop condition with ≥ semantics (root-level elements only). The head
     * read supports the single-tag threshold; resolved-tag sets (#35) apply to
     * `parse`/`PushParser`, where whole-value walking is the cost to bound —
     * the head read already skips bulk values.
     */
    readonly stopAt?: StopAtTagOption;
}

/** Result of {@link parseHeadAsync}: metadata plus the skipped bulk ranges. */
export interface HeadResult {
    /** `true` when parsing completed without a fatal error. */
    readonly ok: boolean;
    /** The file meta group (group 0002). */
    readonly meta: DicomDataSet;
    /** The metadata elements; skipped bulk values are in {@link bulk}, not here. */
    readonly dataSet: DicomDataSet;
    /** The transfer syntax the dataset was parsed with. */
    readonly transferSyntax: string;
    /** Warnings recorded while reading (codes match a whole-file parse). */
    readonly warnings: readonly ParseWarning[];
    /** The failure that ended parsing, or `undefined` on success. */
    readonly error: DicomError | undefined;
    /** Bytes actually read from the source (the memory/IO win over a full read). */
    readonly bytesRead: number;
    /** File-absolute ranges of the bulk values that were skipped, by tag. */
    readonly bulk: ReadonlyMap<Tag, BulkRange>;
}

/** A forward reader over a {@link RangeReader} with a rolling read-ahead buffer. */
class Source {
    /** Total bytes fetched from the underlying reader (the IO cost). */
    bytesRead = 0;
    private readonly reader: RangeReader;
    private buffer: Uint8Array = new Uint8Array(0);
    private bufferStart = 0;

    constructor(reader: RangeReader) {
        this.reader = reader;
    }

    /** Total size of the source. */
    get size(): number {
        return this.reader.size;
    }

    /**
     * Returns a copy of `[offset, offset + length)` (fewer bytes at EOF), reading
     * through a read-ahead window so small header reads don't each hit the reader.
     */
    async read(offset: number, length: number): Promise<Uint8Array> {
        const want = Math.min(length, this.size - offset);
        if (offset >= this.bufferStart && offset + want <= this.bufferStart + this.buffer.length) {
            const rel = offset - this.bufferStart;
            return this.buffer.slice(rel, rel + want);
        }
        const windowEnd = Math.min(this.size, offset + Math.max(want, READ_AHEAD));
        const chunk = await this.reader.read(offset, windowEnd - offset);
        this.bytesRead += chunk.length;
        this.buffer = chunk;
        this.bufferStart = offset;
        return chunk.slice(0, Math.min(want, chunk.length));
    }
}

/** Resolved transfer-syntax properties for the walk. */
interface Plan {
    readonly transferSyntax: string;
    readonly explicitVr: boolean;
    readonly littleEndian: boolean;
    readonly compressed: boolean;
    readonly dataSetPosition: number;
    /** Preamble + `DICM` + meta bytes, copied verbatim into the compacted buffer. */
    readonly headerBytes: Uint8Array;
}

/** Reads the header region and classifies the transfer syntax. */
async function readHead(source: Source, options: HeadOptions): Promise<{ header: ReturnType<typeof readPart10Header>; plan: Plan } | undefined> {
    let prefixLen = Math.min(source.size, READ_AHEAD);
    for (;;) {
        const prefix = await source.read(0, prefixLen);
        const header = readPart10Header(prefix, headerOptions(options));
        const complete = header.error === undefined || prefix.length >= source.size;
        if (complete && header.transferSyntax !== undefined && header.dataSetPosition <= prefix.length) {
            const ts = header.transferSyntax;
            const plan: Plan = {
                transferSyntax: ts,
                explicitVr: ts !== TS_IMPLICIT_LE,
                littleEndian: ts !== TS_EXPLICIT_BE,
                compressed: ts !== '' && !NATIVE_TRANSFER_SYNTAXES.has(ts),
                dataSetPosition: header.dataSetPosition,
                headerBytes: prefix.slice(0, header.dataSetPosition),
            };
            return { header, plan };
        }
        if (prefixLen >= source.size) {
            return undefined; // header unreadable — caller falls back to a whole read
        }
        prefixLen = Math.min(source.size, prefixLen * 2);
    }
}

function headerOptions(options: HeadOptions): { transferSyntax?: string; maxElements?: number; maxDepth?: number } {
    return {
        ...(options.transferSyntax === undefined ? {} : { transferSyntax: options.transferSyntax }),
        ...(options.maxElements === undefined ? {} : { maxElements: options.maxElements }),
        ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    };
}

/** Whether the transfer syntax can be walked (seekable, element-by-element). */
function isWalkable(plan: Plan): boolean {
    return plan.transferSyntax !== TS_DEFLATED_LE && plan.transferSyntax !== TS_GE_PRIVATE_DLX && plan.transferSyntax !== '';
}

/** Reads the whole source and parses it normally (deflated / unsupported / not-DICOM). */
async function wholeFileHead(source: Source, options: HeadOptions): Promise<HeadResult> {
    const bytes = await source.read(0, source.size);
    const result = parse(bytes, parseOptions(options));
    return {
        ok: result.ok,
        meta: result.meta,
        dataSet: result.dataSet,
        transferSyntax: result.transferSyntax,
        warnings: result.warnings,
        error: result.error,
        bytesRead: source.bytesRead,
        bulk: new Map<Tag, BulkRange>(),
    };
}

function parseOptions(options: HeadOptions): Parameters<typeof parse>[1] {
    return {
        ...(options.vrLookup === undefined ? {} : { vrLookup: options.vrLookup }),
        ...(options.charset === undefined ? {} : { charset: options.charset }),
        ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
        ...(options.maxElements === undefined ? {} : { maxElements: options.maxElements }),
        ...(options.transferSyntax === undefined ? {} : { transferSyntax: options.transferSyntax }),
    };
}

/** Mutable walk state threaded through the element loop. */
interface Walk {
    readonly source: Source;
    readonly plan: Plan;
    readonly options: HeadOptions;
    readonly stopTag: Tag | undefined;
    readonly stopInclusive: boolean;
    readonly chunks: Uint8Array[];
    readonly bulk: Map<Tag, BulkRange>;
    readonly warnings: ParseWarning[];
    offset: number;
    stoppedAt: Tag | undefined;
}

/** Parses one element header from a small window at the current walk offset. */
function parseHeader(bytes: Uint8Array, plan: Plan, options: HeadOptions): ElementHeader {
    const stream = new ByteStream(bytes, { littleEndian: plan.littleEndian, position: 0 });
    return plan.explicitVr ? readExplicitElementHeader(stream) : readImplicitElementHeader(stream, options.vrLookup);
}

/** Whether a defined-length element's value is provably bulk (skippable). */
function isBulk(header: ElementHeader, options: HeadOptions): boolean {
    if (header.tag === TAG_PIXEL_DATA) {
        return true;
    }
    if (header.vr !== undefined) {
        return BULK_VRS.has(header.vr) || (header.vr === 'UN' && options.vrLookup?.(header.tag) !== 'SQ');
    }
    const looked = options.vrLookup?.(header.tag);
    return looked !== undefined && BULK_VRS.has(looked);
}

/** Records a skipped bulk value and advances past it (clamping at EOF). */
function skipBulk(walk: Walk, header: ElementHeader): void {
    const dataOffset = walk.offset + header.dataOffset;
    let length = header.lengthField;
    if (dataOffset + length > walk.source.size) {
        walk.warnings.push({ code: 'unexpected-eof', message: `value of ${tagToString(header.tag)} truncated`, offset: dataOffset });
        length = walk.source.size - dataOffset;
    }
    // `header.vr` is already the VR the walker saw — the stream's explicit VR, or
    // (for implicit) the value `readImplicitElementHeader` stored from `vrLookup`.
    walk.bulk.set(header.tag, { offset: dataOffset, length, encapsulated: false, ...(header.vr === undefined ? {} : { vr: header.vr }) });
    walk.offset = dataOffset + length;
}

/** Copies a defined-length element verbatim into the compacted buffer. */
async function copyDefined(walk: Walk, header: ElementHeader): Promise<void> {
    const extent = header.dataOffset + header.lengthField;
    walk.chunks.push(await walk.source.read(walk.offset, extent));
    walk.offset += Math.min(extent, walk.source.size - walk.offset);
}

/**
 * Measures an undefined-length construct (SQ / UN / scanned) by parsing it with
 * the real tokenizer over a growing window, then copies it verbatim. Reusing the
 * tokenizer guarantees the extent matches a whole-file parse exactly.
 */
async function copyUndefined(walk: Walk): Promise<void> {
    let window = Math.min(walk.source.size - walk.offset, MEASURE_WINDOW);
    for (;;) {
        const buf = await walk.source.read(walk.offset, window);
        const extent = measureFirst(buf, walk);
        const atEof = walk.offset + window >= walk.source.size;
        if (extent !== undefined && (extent < buf.length || atEof)) {
            walk.chunks.push(buf.slice(0, extent));
            walk.offset += extent;
            return;
        }
        if (atEof) {
            walk.chunks.push(buf); // truncated construct: copy the rest, let re-parse warn
            walk.offset += buf.length;
            return;
        }
        window = Math.min(walk.source.size - walk.offset, window * 2);
    }
}

/**
 * Extent of the first root construct in a parsed window. Root elements are
 * contiguous, so the construct ends where the next one begins — prefer that
 * `nextStart`: a malformed duplicate root tag can overwrite the offset-0 element
 * in the tag-keyed map, but the following element's start still pins the extent
 * (and equals the construct's endOffset). Falls back to the offset-0 element's
 * own endOffset when it is the only root element in the window.
 */
function firstExtent(result: ReadElementsResult): number | undefined {
    let firstEnd: number | undefined; // endOffset of the construct starting at 0
    let nextStart: number | undefined; // startOffset of the following root element
    for (const el of result.elements.values()) {
        if (el.startOffset === 0) firstEnd = el.endOffset;
        else if (nextStart === undefined || el.startOffset < nextStart) nextStart = el.startOffset;
    }
    return nextStart ?? firstEnd;
}

/** Runs the tokenizer over `buf` and returns the endOffset of the element at 0. */
function measureFirst(buf: Uint8Array, walk: Walk): number | undefined {
    const stream = new ByteStream(buf, { littleEndian: walk.plan.littleEndian, position: 0 });
    const result = readElements(stream, {
        explicitVr: walk.plan.explicitVr,
        compressedTransferSyntax: walk.plan.compressed,
        ...(walk.options.vrLookup === undefined ? {} : { vrLookup: walk.options.vrLookup }),
        ...(walk.options.maxDepth === undefined ? {} : { maxDepth: walk.options.maxDepth }),
        ...(walk.options.maxElements === undefined ? {} : { maxElements: walk.options.maxElements }),
    });
    const extent = firstExtent(result);
    if (extent === undefined) return undefined;
    const errBefore = result.error !== undefined && (result.error.offset ?? Number.MAX_SAFE_INTEGER) < extent;
    return errBefore ? undefined : extent;
}

/** Reads an 8-byte encapsulation item header (tag + length) at `at`. */
async function readItemHeader(source: Source, at: number): Promise<{ tag: number; length: number }> {
    const b = await source.read(at, 8);
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { tag: view.getUint16(0, true) * 0x10000 + view.getUint16(2, true), length: view.getUint32(4, true) };
}

/**
 * True when an encapsulation item is a happy-path `FFFE,E000` value — the basic
 * offset table or a fragment — with a defined length fully inside the bound. The
 * basic offset table (`isBot`) additionally must be a multiple of 4, or the
 * tokenizer emits a `length-adjusted` warning we would otherwise drop.
 */
function isCleanItem(tag: number, length: number, available: number, isBot: boolean): boolean {
    if (tag !== TAG_ITEM || length === UNDEFINED_LENGTH || length > available) return false;
    return !isBot || length % 4 === 0;
}

/**
 * Fast path for well-formed encapsulated PixelData: hops 8-byte item headers
 * (never fragment bodies) and returns the value's end offset only when the chain
 * is exactly what the tokenizer accepts without any warning — a `FFFE,E000` basic
 * offset table, zero or more `FFFE,E000` fragments (all defined-length, inside the
 * bound), closed by a zero-length `FFFE,E0DD`. Returns `undefined` for anything
 * the tokenizer would reject (e.g. an undefined-length fragment item) or merely
 * tolerate-with-a-warning (missing/wrong/non-zero delimiter, over-long fragment,
 * garbage tag, truncation), so the caller falls back to the tokenizer-backed copy
 * path and head/full identity holds by construction (#67).
 */
async function tryHopEncapsulated(walk: Walk, dataOffset: number): Promise<number | undefined> {
    const bound = walk.source.size;
    let at = dataOffset;
    let bot = true; // the first item is the basic offset table
    for (;;) {
        if (at + 8 > bound) return undefined; // ran out before a FFFE,E0DD terminator
        const { tag, length } = await readItemHeader(walk.source, at);
        if (!bot && tag === TAG_SEQUENCE_DELIMITATION) return length === 0 ? at + 8 : undefined;
        if (!isCleanItem(tag, length, bound - (at + 8), bot)) return undefined;
        at += 8 + length;
        bot = false;
    }
}

/**
 * Skips well-formed encapsulated PixelData by hopping item headers; for any
 * malformed chain, falls back to {@link copyUndefined} so the real tokenizer
 * measures and copies it — reproducing the whole-file parse's ok/warnings/error
 * exactly rather than silently accepting bytes `parse` rejects (#67).
 */
async function skipEncapsulated(walk: Walk, header: ElementHeader): Promise<void> {
    const dataOffset = walk.offset + header.dataOffset;
    const end = await tryHopEncapsulated(walk, dataOffset);
    if (end === undefined) {
        await copyUndefined(walk);
        return;
    }
    walk.bulk.set(header.tag, { offset: dataOffset, length: end - dataOffset, encapsulated: true, ...(header.vr === undefined ? {} : { vr: header.vr }) });
    walk.offset = end;
}

/** Dispatches one element: skip bulk, hop encapsulated, or copy metadata. */
async function walkOne(walk: Walk, header: ElementHeader): Promise<void> {
    if (header.tag === TAG_PIXEL_DATA && header.hadUndefinedLength) {
        await skipEncapsulated(walk, header);
    } else if (header.hadUndefinedLength) {
        await copyUndefined(walk);
    } else if (isBulk(header, walk.options)) {
        skipBulk(walk, header);
    } else {
        await copyDefined(walk, header);
    }
}

/** Whether the walk should stop at `header` (≥ stopAt). Sets stoppedAt. */
function shouldStop(walk: Walk, header: ElementHeader): boolean {
    if (walk.stopTag === undefined || header.tag < walk.stopTag) {
        return false;
    }
    walk.stoppedAt = header.tag;
    return !walk.stopInclusive;
}

/** Walks the dataset, emitting kept bytes and recording skipped bulk ranges. */
async function walkDataSet(walk: Walk): Promise<void> {
    while (walk.offset < walk.source.size) {
        const headerLen = Math.min(12, walk.source.size - walk.offset);
        if (headerLen < 8) {
            walk.chunks.push(await walk.source.read(walk.offset, headerLen));
            walk.offset += headerLen;
            return;
        }
        const bytes = await walk.source.read(walk.offset, headerLen);
        let header: ElementHeader;
        try {
            header = parseHeader(bytes, walk.plan, walk.options);
        } catch {
            walk.chunks.push(bytes); // partial header at EOF: copy verbatim, let re-parse handle
            walk.offset += bytes.length;
            return;
        }
        if (shouldStop(walk, header)) {
            return;
        }
        await walkOne(walk, header);
        if (walk.stoppedAt !== undefined) {
            return;
        }
    }
}

/** Assembles a {@link HeadResult} from the walk output and a re-parse of the compacted bytes. */
function buildResult(walk: Walk, options: HeadOptions): HeadResult {
    const compacted = concat(walk.chunks);
    // Part-10 compacted buffers carry their own meta group, so parse re-derives
    // the transfer syntax; headerless datasets need the caller's TS (in opts).
    const result = parse(compacted, parseOptions(options));
    return {
        ok: result.ok,
        meta: result.meta,
        dataSet: result.dataSet,
        transferSyntax: result.transferSyntax === '' ? walk.plan.transferSyntax : result.transferSyntax,
        warnings: [...result.warnings, ...walk.warnings],
        error: result.error,
        bytesRead: walk.source.bytesRead,
        bulk: walk.bulk,
    };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.length;
    }
    return out;
}

/**
 * Parses a Part-10 file's metadata over a {@link RangeReader}, skipping bulk value
 * bytes so peak memory tracks the metadata rather than the file.
 *
 * Skipped values (PixelData and other OB/OW/OD/OF/OL/OV values) are reported in
 * {@link HeadResult.bulk} as file-absolute ranges for the caller to fetch on
 * demand; every other element parses exactly as in a whole-file {@link parse}.
 * Deflated transfer syntax cannot be seeked, so the whole file is read.
 *
 * @param reader - Random-access source of the file bytes
 * @param options - Parse options (VR lookup, charset, limits, stopAt, headerless TS)
 * @returns The metadata result plus the skipped bulk ranges and bytes-read count
 * @throws DicomError `invalid-argument` when the reader size is negative
 */
export async function parseHeadAsync(reader: RangeReader, options: HeadOptions = {}): Promise<HeadResult> {
    if (!Number.isInteger(reader.size) || reader.size < 0) {
        throw new DicomError('invalid-argument', `parseHeadAsync: reader.size must be a non-negative integer, got ${reader.size}`);
    }
    const source = new Source(reader);
    const head = await readHead(source, options);
    if (head === undefined || !isWalkable(head.plan)) {
        return wholeFileHead(source, options);
    }
    const walk: Walk = {
        source,
        plan: head.plan,
        options,
        stopTag: options.stopAt === undefined ? undefined : toTag(options.stopAt.tag),
        stopInclusive: options.stopAt?.inclusive ?? false,
        chunks: [head.plan.headerBytes],
        bulk: new Map<Tag, BulkRange>(),
        warnings: [],
        offset: head.plan.dataSetPosition,
        stoppedAt: undefined,
    };
    await walkDataSet(walk);
    return buildResult(walk, options);
}
