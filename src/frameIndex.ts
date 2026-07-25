/**
 * Lazy frame index (#38): resolves the PixelData value's file-absolute extent
 * and per-frame `(offset, length)` ranges from a header prefix or a
 * {@link RangeReader}, without loading the whole object — so a frame can be
 * served with a couple of ranged reads.
 *
 * Frame boundaries come from, in order of preference:
 *
 * - the **Extended Offset Table** `(7FE0,0001)` + `(7FE0,0002)` (PS3.5 A.4),
 *   which the parser previously ignored,
 * - the **basic offset table** carried in the first encapsulation item,
 * - a single-frame span when the table is empty and there is one frame,
 * - a fragment-header walk matched 1:1 against `NumberOfFrames` (the
 *   one-fragment-per-frame convention) as a last resort,
 * - for native (uncompressed) syntaxes, arithmetic over Rows / Columns /
 *   SamplesPerPixel / BitsAllocated.
 *
 * Every reported range is **file-absolute**. For encapsulated pixel data a
 * frame range spans that frame's fragment *items* — item headers included — so
 * the fetched bytes stay self-describing; use the pure {@link frameFragments} /
 * {@link framePayload} helpers to strip the headers afterwards, at no extra IO.
 *
 * @module frameIndex
 */

import type { DicomDataSet } from './dataSet';
import { DicomError, type ParseWarning } from './errors';
import { parseHeadAsync, type BulkRange, type HeadOptions, type HeadResult, type RangeReader } from './headRead';
import {
    TAG_EXTENDED_OFFSET_TABLE,
    TAG_EXTENDED_OFFSET_TABLE_LENGTHS,
    TAG_ITEM,
    TAG_PIXEL_DATA,
    TAG_SEQUENCE_DELIMITATION,
    UNDEFINED_LENGTH,
    type Tag,
} from './tag';

/** A file-absolute byte range. */
export interface FrameRange {
    /** Offset of the range's first byte in the source. */
    readonly offset: number;
    /** Range length in bytes. */
    readonly length: number;
}

/** How the frame boundaries were determined. */
export type FrameSource =
    /** Native pixel data: Rows × Columns × SamplesPerPixel × BitsAllocated. */
    | 'computed'
    /** The Extended Offset Table (7FE0,0001)/(7FE0,0002). */
    | 'extended-offset-table'
    /** The basic offset table in the first encapsulation item. */
    | 'basic-offset-table'
    /** Empty basic offset table, one frame: the whole fragment stream. */
    | 'single-frame'
    /** Empty basic offset table: fragment headers walked and matched 1:1 to frames. */
    | 'fragment-walk';

/** Options for {@link readFrameIndexAsync}. */
export interface FrameIndexOptions extends HeadOptions {
    /**
     * An existing head read to resolve frames against, avoiding a second pass.
     * It must come from the same source as `reader`.
     */
    readonly head?: HeadResult;
    /**
     * Permit the fragment-header walk fallback (default `true`). The walk costs
     * one small read per fragment, which on a large multi-frame object can pull
     * in more bytes than the rest of the index; set `false` to prefer an
     * `unavailable` result over that IO.
     */
    readonly allowFragmentWalk?: boolean;
}

interface FrameIndexCommon {
    /** The head read the index was resolved from. */
    readonly head: HeadResult;
    /** Bytes read from the source, including the head read. */
    readonly bytesRead: number;
    /** Anomalies recorded while resolving frames (head warnings stay on {@link head}). */
    readonly warnings: readonly ParseWarning[];
}

/** Result of {@link readFrameIndexAsync}: frame ranges, or why they are unavailable. */
export type FrameIndex =
    | (FrameIndexCommon & {
          /** Whether the pixel data is native (contiguous) or encapsulated (fragmented). */
          readonly kind: 'native' | 'encapsulated';
          /** File-absolute extent of the whole PixelData value. */
          readonly pixelData: BulkRange;
          /** Per-frame file-absolute ranges, in frame order. */
          readonly frames: readonly FrameRange[];
          /** How {@link frames} was derived. */
          readonly frameSource: FrameSource;
      })
    | (FrameIndexCommon & {
          readonly kind: 'unavailable';
          /** The PixelData extent when known, `undefined` when it was not resolved. */
          readonly pixelData: BulkRange | undefined;
          /** Why frames could not be resolved. */
          readonly reason: string;
      });

/** Either resolved frames or the reason they are unavailable. */
type Resolved = { readonly frames: readonly FrameRange[]; readonly frameSource: FrameSource } | { readonly reason: string };

/** A reader that tallies the bytes this module fetches on top of the head read. */
class CountingReader {
    bytesRead = 0;
    private readonly reader: RangeReader;

    constructor(reader: RangeReader) {
        this.reader = reader;
    }

    /** Reads `[offset, offset + length)`, clamped to the source (may return fewer bytes). */
    async read(offset: number, length: number): Promise<Uint8Array> {
        const want = Math.min(length, this.reader.size - offset);
        if (offset < 0 || want <= 0) {
            return new Uint8Array(0);
        }
        const bytes = await this.reader.read(offset, want);
        this.bytesRead += bytes.length;
        return bytes;
    }
}

/** Decodes an 8-byte encapsulation item header at `at` (little endian, as all encapsulated syntaxes are). */
function itemHeaderAt(bytes: Uint8Array, at: number): { tag: Tag; length: number } | undefined {
    if (at + 8 > bytes.length) {
        return undefined;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { tag: view.getUint16(at, true) * 0x10000 + view.getUint16(at + 2, true), length: view.getUint32(at + 4, true) };
}

/**
 * Splits a fetched encapsulated frame range into its fragments' **payload**
 * ranges, relative to `frameBytes` — the item headers the frame range includes
 * are stripped here, at no IO cost.
 *
 * @param frameBytes - Bytes fetched for one {@link FrameRange}
 * @returns The payload ranges, in stream order (one per fragment)
 * @throws DicomError `malformed` when the bytes are not a fragment-item stream
 */
export function frameFragments(frameBytes: Uint8Array): FrameRange[] {
    const out: FrameRange[] = [];
    let at = 0;
    while (at < frameBytes.length) {
        const header = itemHeaderAt(frameBytes, at);
        if (header === undefined || header.tag !== TAG_ITEM || header.length === UNDEFINED_LENGTH) {
            throw new DicomError('malformed', `frameFragments: expected a fragment item (FFFE,E000) at offset ${at}`, { offset: at });
        }
        if (at + 8 + header.length > frameBytes.length) {
            throw new DicomError('malformed', `frameFragments: fragment at offset ${at} overruns the frame range`, { offset: at });
        }
        out.push({ offset: at + 8, length: header.length });
        at += 8 + header.length;
    }
    return out;
}

/**
 * Concatenates a fetched encapsulated frame's fragment payloads into the
 * codec-ready bytes.
 *
 * A single-fragment frame returns a zero-copy view over `frameBytes` (which
 * therefore retains it — copy it if the frame buffer must be released, cf.
 * `rawBytesCopy`); multi-fragment frames return a fresh concatenation.
 *
 * @param frameBytes - Bytes fetched for one {@link FrameRange}
 * @returns The frame's compressed bitstream
 * @throws DicomError `malformed` when the bytes are not a fragment-item stream
 */
export function framePayload(frameBytes: Uint8Array): Uint8Array {
    const fragments = frameFragments(frameBytes);
    if (fragments.length === 1) {
        const only = fragments[0] as FrameRange;
        return frameBytes.subarray(only.offset, only.offset + only.length);
    }
    const total = fragments.reduce((sum, fragment) => sum + fragment.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const fragment of fragments) {
        out.set(frameBytes.subarray(fragment.offset, fragment.offset + fragment.length), at);
        at += fragment.length;
    }
    return out;
}

/** NumberOfFrames (0028,0008), defaulting to 1 per PS3.3 when absent or unparsable. */
function frameCount(dataSet: DicomDataSet): number {
    const declared = dataSet.intString(0x00280008);
    return declared === undefined || !Number.isFinite(declared) || declared < 1 ? 1 : declared;
}

/**
 * Bytes per native frame from the image-pixel module, or why it is unusable.
 * The product is computed in `bigint`: hostile Rows/Columns/SamplesPerPixel/
 * BitsAllocated can exceed the safe-integer range, where number arithmetic
 * would silently mis-size frames instead of refusing.
 */
function nativeFrameLength(dataSet: DicomDataSet): { readonly frameLength: number } | { readonly reason: string } {
    const rows = dataSet.uint16(0x00280010);
    const columns = dataSet.uint16(0x00280011);
    const bitsAllocated = dataSet.uint16(0x00280100);
    const samples = dataSet.uint16(0x00280002) ?? 1;
    if (rows === undefined || columns === undefined || bitsAllocated === undefined) {
        return { reason: 'native pixel data needs Rows (0028,0010), Columns (0028,0011) and BitsAllocated (0028,0100) to size frames' };
    }
    const bits = BigInt(rows) * BigInt(columns) * BigInt(samples) * BigInt(bitsAllocated);
    if (bits <= 0n || bits > BigInt(Number.MAX_SAFE_INTEGER)) {
        return {
            reason: `frame size ${bits} bits is out of range for Rows ${rows} × Columns ${columns} × Samples ${samples} × BitsAllocated ${bitsAllocated}`,
        };
    }
    if (bits % 8n !== 0n) {
        // bit-packed (BitsAllocated 1) frames need not start on a byte boundary
        return { reason: `frame size ${bits} bits is not a whole number of bytes (bit-packed pixel data has no byte-aligned frame offsets)` };
    }
    return { frameLength: Number(bits / 8n) };
}

/** Native frames: equal-sized and contiguous, sized by {@link nativeFrameLength}. */
function nativeFrames(dataSet: DicomDataSet, pixelData: BulkRange, warnings: ParseWarning[]): Resolved {
    const sized = nativeFrameLength(dataSet);
    if ('reason' in sized) {
        return sized;
    }
    const { frameLength } = sized;
    let count = frameCount(dataSet);
    if (frameLength * count > pixelData.length) {
        warnings.push({
            code: 'length-adjusted',
            message: `pixel data holds ${pixelData.length} bytes but ${count} frames of ${frameLength} bytes were declared; reporting only whole frames that fit`,
            offset: pixelData.offset,
        });
        count = Math.floor(pixelData.length / frameLength);
    }
    const frames: FrameRange[] = [];
    for (let i = 0; i < count; i++) {
        frames.push({ offset: pixelData.offset + i * frameLength, length: frameLength });
    }
    return { frames, frameSource: 'computed' };
}

/** Where the fragment stream of an encapsulated value starts and ends. */
interface Layout {
    /** Length of the basic offset table item's value (0 when the table is empty). */
    readonly botLength: number;
    /** Offset of the first fragment item's tag — the base all table offsets are relative to. */
    readonly firstFragment: number;
    /** One past the last fragment byte (the sequence delimiter, when present, is excluded). */
    readonly fragmentsEnd: number;
}

/** Reads the basic offset table item header and locates the fragment stream. */
async function readLayout(reader: CountingReader, pixelData: BulkRange): Promise<Layout | { readonly reason: string }> {
    const head = itemHeaderAt(await reader.read(pixelData.offset, 8), 0);
    if (head === undefined || head.tag !== TAG_ITEM || head.length === UNDEFINED_LENGTH) {
        return { reason: 'encapsulated pixel data does not start with a basic offset table item (FFFE,E000)' };
    }
    const valueEnd = pixelData.offset + pixelData.length;
    // The bulk extent may or may not include the closing FFFE,E0DD (the head-read
    // hop stops one past it); probing the last 8 bytes settles it either way.
    const tail = itemHeaderAt(await reader.read(valueEnd - 8, 8), 0);
    const fragmentsEnd = tail?.tag === TAG_SEQUENCE_DELIMITATION ? valueEnd - 8 : valueEnd;
    const firstFragment = pixelData.offset + 8 + head.length;
    if (firstFragment > fragmentsEnd) {
        return { reason: 'basic offset table overruns the pixel data value' };
    }
    return { botLength: head.length, firstFragment, fragmentsEnd };
}

/** Turns table-relative starts (ascending) into frame ranges bounded by the stream end. */
function rangesFromStarts(starts: readonly number[], layout: Layout): FrameRange[] | undefined {
    const frames: FrameRange[] = [];
    for (let i = 0; i < starts.length; i++) {
        const start = starts[i] as number;
        const next = i + 1 < starts.length ? (starts[i + 1] as number) : layout.fragmentsEnd - layout.firstFragment;
        if (start < 0 || next < start || layout.firstFragment + next > layout.fragmentsEnd) {
            return undefined;
        }
        frames.push({ offset: layout.firstFragment + start, length: next - start });
    }
    return frames;
}

/** Reads the 64-bit values of an OV element, whether it was kept or skipped as bulk. */
async function readOv(reader: CountingReader, head: HeadResult, tag: Tag): Promise<number[] | undefined> {
    const kept = head.dataSet.element(tag);
    if (kept !== undefined && kept.kind === 'value') {
        if (kept.length % 8 !== 0) {
            return undefined; // not a whole number of 64-bit entries: malformed table
        }
        const out: number[] = [];
        for (let i = 0; i * 8 < kept.length; i++) {
            const value = head.dataSet.uint64(tag, i);
            if (value === undefined || value > BigInt(Number.MAX_SAFE_INTEGER)) {
                return undefined;
            }
            out.push(Number(value));
        }
        return out;
    }
    const range = head.bulk.get(tag);
    return range === undefined ? undefined : decodeOv(await reader.read(range.offset, range.length));
}

function decodeOv(bytes: Uint8Array): number[] | undefined {
    if (bytes.length % 8 !== 0) {
        return undefined; // truncated or padded table: fall back rather than trim it
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out: number[] = [];
    for (let at = 0; at + 8 <= bytes.length; at += 8) {
        const value = view.getBigUint64(at, true);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
            return undefined;
        }
        out.push(Number(value));
    }
    return out;
}

/**
 * Extended Offset Table frames (PS3.5 A.4): offsets are relative to the first
 * fragment item, and each length is the frame's payload — the table is only
 * valid when every frame is a single fragment, so the span is payload + header.
 */
async function extendedOffsetTableFrames(reader: CountingReader, head: HeadResult, layout: Layout, warnings: ParseWarning[]): Promise<Resolved | undefined> {
    const offsets = await readOv(reader, head, TAG_EXTENDED_OFFSET_TABLE);
    if (offsets === undefined || offsets.length === 0) {
        return undefined;
    }
    const lengths = await readOv(reader, head, TAG_EXTENDED_OFFSET_TABLE_LENGTHS);
    if (lengths === undefined || lengths.length !== offsets.length) {
        warnings.push({
            code: 'length-adjusted',
            message: 'extended offset table (7FE0,0001) has no matching lengths (7FE0,0002); falling back to the basic offset table',
            offset: layout.firstFragment,
        });
        return undefined;
    }
    const frames = offsets.map((offset, i) => ({ offset: layout.firstFragment + offset, length: 8 + (lengths[i] as number) }));
    const valid = frames.every(
        (frame, i) =>
            frame.offset >= layout.firstFragment &&
            frame.offset + frame.length <= layout.fragmentsEnd &&
            (i === 0 || frame.offset >= (frames[i - 1] as FrameRange).offset)
    );
    if (!valid) {
        warnings.push({
            code: 'length-adjusted',
            message: 'extended offset table entries fall outside the fragment stream; ignored',
            offset: layout.firstFragment,
        });
        return undefined;
    }
    return { frames, frameSource: 'extended-offset-table' };
}

/** Basic offset table frames: 32-bit starts relative to the first fragment item. */
async function basicOffsetTableFrames(reader: CountingReader, pixelData: BulkRange, layout: Layout, warnings: ParseWarning[]): Promise<Resolved | undefined> {
    const bytes = await reader.read(pixelData.offset + 8, layout.botLength);
    if (bytes.length < layout.botLength) {
        return undefined;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const starts: number[] = [];
    for (let at = 0; at + 4 <= bytes.length; at += 4) {
        starts.push(view.getUint32(at, true));
    }
    const frames = rangesFromStarts(starts, layout);
    if (frames === undefined) {
        warnings.push({
            code: 'length-adjusted',
            message: 'basic offset table entries fall outside the fragment stream; ignored',
            offset: layout.firstFragment,
        });
        return undefined;
    }
    return { frames, frameSource: 'basic-offset-table' };
}

/** Walks fragment item headers and maps them 1:1 onto frames (the common convention). */
async function walkFrames(reader: CountingReader, layout: Layout, numberOfFrames: number): Promise<Resolved> {
    const starts: number[] = [];
    let at = layout.firstFragment;
    while (at < layout.fragmentsEnd) {
        const header = itemHeaderAt(await reader.read(at, 8), 0);
        if (header === undefined || header.tag !== TAG_ITEM || header.length === UNDEFINED_LENGTH || at + 8 + header.length > layout.fragmentsEnd) {
            return { reason: 'fragment stream is not a clean chain of defined-length items; frame boundaries are indeterminate' };
        }
        starts.push(at - layout.firstFragment);
        at += 8 + header.length;
    }
    if (starts.length !== numberOfFrames) {
        return {
            reason: `${starts.length} fragments do not map onto ${numberOfFrames} frames without an offset table; fetch the value and decode to locate frames`,
        };
    }
    const frames = rangesFromStarts(starts, layout);
    return frames === undefined ? { reason: 'fragment walk produced ranges outside the fragment stream' } : { frames, frameSource: 'fragment-walk' };
}

interface EncapsulatedContext {
    readonly reader: CountingReader;
    readonly head: HeadResult;
    readonly pixelData: BulkRange;
    readonly warnings: ParseWarning[];
    readonly allowWalk: boolean;
}

/** Resolves encapsulated frames: EOT, then BOT, then single-frame, then a walk. */
async function encapsulatedFrames(ctx: EncapsulatedContext): Promise<Resolved> {
    const layout = await readLayout(ctx.reader, ctx.pixelData);
    if ('reason' in layout) {
        return layout;
    }
    const eot = await extendedOffsetTableFrames(ctx.reader, ctx.head, layout, ctx.warnings);
    if (eot !== undefined) {
        return eot;
    }
    if (layout.botLength > 0) {
        const bot = await basicOffsetTableFrames(ctx.reader, ctx.pixelData, layout, ctx.warnings);
        if (bot !== undefined) {
            return bot;
        }
    }
    const numberOfFrames = frameCount(ctx.head.dataSet);
    if (numberOfFrames === 1) {
        return { frames: [{ offset: layout.firstFragment, length: layout.fragmentsEnd - layout.firstFragment }], frameSource: 'single-frame' };
    }
    if (!ctx.allowWalk) {
        return { reason: 'no offset table resolves the frames and the fragment walk is disabled (allowFragmentWalk: false)' };
    }
    return walkFrames(ctx.reader, layout, numberOfFrames);
}

/** Why no file-absolute pixel-data range was available from the head read. */
function missingPixelDataReason(head: HeadResult): string {
    if (head.transferSyntax === '' || head.dataSet.element(TAG_PIXEL_DATA) === undefined) {
        return 'the object has no pixel data';
    }
    return 'pixel data was not resolved as a file-absolute bulk range (deflated transfer syntax or malformed encapsulation); parse the object instead';
}

/**
 * Resolves the PixelData extent and per-frame ranges over a
 * {@link RangeReader}, reading only the header, the offset tables and (as a
 * last resort) fragment item headers — never the pixel payload.
 *
 * Deflated objects, and files whose pixel data could not be skipped as a bulk
 * range (absent, or a malformed encapsulation the head read had to copy),
 * return `kind: 'unavailable'` with a reason rather than a guess: their offsets
 * would not address the source.
 *
 * @param reader - Random-access source of the file bytes
 * @param options - Head-read options, an existing {@link HeadResult}, and the walk toggle
 * @returns The frame index, or an `unavailable` result explaining why
 * @throws DicomError `invalid-argument` when the reader size is negative
 */
export async function readFrameIndexAsync(reader: RangeReader, options: FrameIndexOptions = {}): Promise<FrameIndex> {
    // validated here, not only inside parseHeadAsync: a supplied options.head
    // skips that call, and a bad size would otherwise degrade to empty reads
    if (!Number.isInteger(reader.size) || reader.size < 0) {
        throw new DicomError('invalid-argument', `readFrameIndexAsync: reader.size must be a non-negative integer, got ${reader.size}`);
    }
    const counting = new CountingReader(reader);
    const head = options.head ?? (await parseHeadAsync(reader, options));
    const warnings: ParseWarning[] = [];
    const pixelData = head.bulk.get(TAG_PIXEL_DATA);
    const common = (): FrameIndexCommon => ({ head, bytesRead: head.bytesRead + counting.bytesRead, warnings });
    if (pixelData === undefined) {
        return { ...common(), kind: 'unavailable', pixelData: undefined, reason: missingPixelDataReason(head) };
    }
    const resolved =
        pixelData.encapsulated === true
            ? await encapsulatedFrames({ reader: counting, head, pixelData, warnings, allowWalk: options.allowFragmentWalk !== false })
            : nativeFrames(head.dataSet, pixelData, warnings);
    if ('reason' in resolved) {
        return { ...common(), kind: 'unavailable', pixelData, reason: resolved.reason };
    }
    return {
        ...common(),
        kind: pixelData.encapsulated === true ? 'encapsulated' : 'native',
        pixelData,
        frames: resolved.frames,
        frameSource: resolved.frameSource,
    };
}
