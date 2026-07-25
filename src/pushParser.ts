/**
 * Push (streaming) parser: feed chunks as they arrive, get incremental
 * signals — element emission, wanted-tag resolution, "everything before
 * PixelData is available" — without buffering the whole object first
 * (issue #33).
 *
 * Built on the #34 strict-EOF machinery: each `push` advances a settled
 * watermark by tokenizing root elements over the bytes so far; a truncation
 * hit (`totalNeeded`) leaves the in-progress element unsettled and re-parses
 * it when more bytes arrive. A settled element saw exactly the bytes and
 * context a whole-buffer parse would see, so incremental results match the
 * final parse by construction — and {@link PushParser.end} returns the
 * authoritative tolerant {@link parse} over the assembled buffer.
 *
 * Deflated transfer syntaxes are buffered and resolve at `end()`/`endAsync()`
 * only: mid-stream offsets for a deflated dataset would be in inflated
 * coordinates, which cannot guide transport reads.
 *
 * @module pushParser
 */

import { ByteStream } from './byteStream';
import { DicomDataSet } from './dataSet';
import type { DicomElement } from './element';
import { DicomError } from './errors';
import { readPart10Header, type Part10Header } from './part10';
import { readElements } from './tokenizer';
import {
    NATIVE_TRANSFER_SYNTAXES,
    TS_DEFLATED_LE,
    TS_EXPLICIT_BE,
    TS_GE_PRIVATE_DLX,
    TS_IMPLICIT_LE,
    parse,
    parseAsync,
    type ParseOptions,
    type ParseResult,
    type TruncationInfo,
} from './parse';
import { TAG_PIXEL_DATA, toTag, type Tag, type TagLike } from './tag';

/** Options for {@link PushParser}. */
export interface PushOptions extends ParseOptions {
    /**
     * Root-level tags to resolve early. A tag is resolved when it is settled,
     * or provably absent — a settled root element with a greater tag has been
     * seen (data elements are stream-ordered per PS3.5 §7.1).
     */
    readonly wanted?: readonly TagLike[];
    /**
     * Called once per root-level element, in stream order, as each settles.
     * Never called twice for the same element, regardless of chunking.
     */
    readonly onElement?: (element: DicomElement) => void;
}

/** The `push`-so-far classification, using the {@link parsePartial} vocabulary. */
export type PushOutcome =
    | { readonly kind: 'needMoreBytes'; readonly truncation: TruncationInfo }
    | { readonly kind: 'complete' }
    | { readonly kind: 'malformed'; readonly error: DicomError };

/** Incremental status returned by {@link PushParser.push}. */
export interface PushStatus {
    /**
     * Classification of the bytes buffered so far. `complete` means
     * boundary-consistent (more elements may still follow — keep pushing while
     * the transport has bytes); `malformed` is sticky and means more bytes
     * cannot help. For deflated input the sized hint is unavailable and
     * `totalNeeded` is only ever "one more byte".
     */
    readonly outcome: PushOutcome;
    /** Total bytes buffered so far. */
    readonly bytesBuffered: number;
    /** Root-level elements settled so far. */
    readonly elementCount: number;
    /** All {@link PushOptions.wanted} tags answered or provably absent. */
    readonly wantedResolved: boolean;
    /**
     * Every element before (7FE0,0010) PixelData has settled — a root element
     * with tag ≥ (7FE0,0010) has been seen, or the input is complete without
     * one. Advisory: assumes stream-ordered tags (PS3.5).
     */
    readonly beforePixelData: boolean;
}

const INITIAL_CAPACITY = 64 * 1024;
const PART10_PREFIX_END = 132;

interface WirePlan {
    readonly header: Part10Header;
    readonly littleEndian: boolean;
    readonly explicitVr: boolean;
    readonly compressed: boolean;
    readonly deflated: boolean;
}

/**
 * A push-mode DICOM parser: call {@link push} for each received chunk and read
 * the returned {@link PushStatus}; call {@link end} (or {@link endAsync} in
 * inflater-less browsers) when the transport finishes to get the
 * authoritative {@link ParseResult} — identical to `parse` of the whole
 * buffer, regardless of how the bytes were chunked.
 */
export class PushParser {
    private readonly options: PushOptions;
    private readonly wantedTags: readonly Tag[];
    private buffer = new Uint8Array(INITIAL_CAPACITY);
    private written = 0;
    private plan: WirePlan | undefined;
    private watermark = 0;
    private readonly settled = new Map<Tag, DicomElement>();
    private maxSeenRootTag = -1;
    private lastOutcome: PushOutcome = { kind: 'needMoreBytes', truncation: { offset: 0, totalNeeded: 1 } };
    private stopReached = false;
    private ended: ParseResult | undefined;

    constructor(options: PushOptions = {}) {
        this.options = options;
        this.wantedTags = (options.wanted ?? []).map(toTag);
    }

    /** The status as of the last `push` (or the initial state). */
    get status(): PushStatus {
        return {
            outcome: this.lastOutcome,
            bytesBuffered: this.written,
            elementCount: this.settled.size,
            wantedResolved: this.wantedTags.every(tag => this.settled.has(tag) || this.maxSeenRootTag > tag),
            beforePixelData: this.maxSeenRootTag >= TAG_PIXEL_DATA || this.lastOutcome.kind === 'complete',
        };
    }

    /**
     * Appends a received chunk and advances the incremental parse.
     *
     * @param chunk - The next bytes of the object, in transport order
     * @returns The updated status
     * @throws DicomError `invalid-argument` when `chunk` is not a Uint8Array
     *         or the parser was already ended
     */
    push(chunk: Uint8Array): PushStatus {
        if (!(chunk instanceof Uint8Array)) {
            throw new DicomError('invalid-argument', 'PushParser.push: chunk must be a Uint8Array');
        }
        if (this.ended !== undefined) {
            throw new DicomError('invalid-argument', 'PushParser.push: parser already ended');
        }
        this.append(chunk);
        if (this.lastOutcome.kind !== 'malformed') {
            this.advance();
        }
        return this.status;
    }

    /**
     * Finishes the stream and returns the authoritative result: a tolerant
     * {@link parse} of the assembled buffer (a view over the internal buffer —
     * copy it if the parser outlives the result's use). Idempotent.
     */
    end(): ParseResult {
        this.ended ??= parse(this.bytes(), this.options);
        return this.ended;
    }

    /** Like {@link end}, using {@link parseAsync} (browser deflate support). */
    async endAsync(): Promise<ParseResult> {
        this.ended ??= await parseAsync(this.bytes(), this.options);
        return this.ended;
    }

    /** The bytes buffered so far (a view over the internal buffer). */
    bytes(): Uint8Array {
        return this.buffer.subarray(0, this.written);
    }

    /**
     * The settled root-level elements as a dataset over the bytes so far.
     * Strings decode with the default repertoire until {@link end} (charset
     * assignment is a whole-parse concern); offsets are final.
     */
    dataSet(): DicomDataSet {
        return new DicomDataSet(this.bytes(), this.plan?.littleEndian ?? true, new Map(this.settled));
    }

    private append(chunk: Uint8Array): void {
        const needed = this.written + chunk.length;
        if (needed > this.buffer.length) {
            let capacity = this.buffer.length * 2;
            while (capacity < needed) {
                capacity *= 2;
            }
            const grown = new Uint8Array(capacity);
            grown.set(this.buffer.subarray(0, this.written), 0);
            this.buffer = grown;
        }
        this.buffer.set(chunk, this.written);
        this.written = needed;
    }

    /** Re-assesses the buffered bytes: header phase, then dataset watermark. */
    private advance(): void {
        // a resolved stopAt is final, matching parse (no elements settle past it)
        if (this.stopReached) {
            return;
        }
        // gate on the last sized hint — re-parsing earlier cannot progress
        if (this.lastOutcome.kind === 'needMoreBytes' && this.written < this.lastOutcome.truncation.totalNeeded) {
            return;
        }
        if (this.plan === undefined) {
            this.plan = this.resolveHeader();
            if (this.plan === undefined) {
                return; // outcome already set by resolveHeader
            }
            this.watermark = this.plan.header.dataSetPosition;
        }
        if (this.plan.deflated) {
            // inflated coordinates cannot guide transport reads: signals for
            // deflated input resolve at end()/endAsync() only
            this.lastOutcome = { kind: 'needMoreBytes', truncation: { offset: this.watermark, totalNeeded: this.written + 1 } };
            return;
        }
        this.advanceDataSet();
    }

    /** Runs the strict-EOF header read; returns undefined until it resolves. */
    private resolveHeader(): WirePlan | undefined {
        const header = readPart10Header(this.bytes(), { ...this.options, strictEof: true });
        const error = header.error;
        if (error !== undefined) {
            if (error.totalNeeded !== undefined) {
                this.lastOutcome = { kind: 'needMoreBytes', truncation: { offset: error.offset ?? this.written, totalNeeded: error.totalNeeded } };
            } else if (error.code === 'not-dicom' && this.written < PART10_PREFIX_END) {
                this.lastOutcome = { kind: 'needMoreBytes', truncation: { offset: this.written, totalNeeded: PART10_PREFIX_END } };
            } else {
                this.lastOutcome = { kind: 'malformed', error };
            }
            return undefined;
        }
        const transferSyntax = header.transferSyntax ?? '';
        if (transferSyntax === TS_GE_PRIVATE_DLX) {
            this.lastOutcome = {
                kind: 'malformed',
                error: new DicomError('unsupported', `transfer syntax ${TS_GE_PRIVATE_DLX} (GE private Implicit VR Big Endian DLX) is not supported`),
            };
            return undefined;
        }
        return {
            header,
            littleEndian: transferSyntax !== TS_EXPLICIT_BE,
            explicitVr: transferSyntax !== TS_IMPLICIT_LE,
            compressed: transferSyntax !== '' && !NATIVE_TRANSFER_SYNTAXES.has(transferSyntax),
            deflated: transferSyntax === TS_DEFLATED_LE,
        };
    }

    /** Tokenizes root elements from the watermark and settles completed ones. */
    private advanceDataSet(): void {
        const plan = this.plan as WirePlan;
        const stream = new ByteStream(this.bytes(), { position: this.watermark, littleEndian: plan.littleEndian, strictEof: true });
        const result = readElements(stream, {
            explicitVr: plan.explicitVr,
            compressedTransferSyntax: plan.compressed,
            ...(this.options.vrLookup === undefined ? {} : { vrLookup: this.options.vrLookup }),
            ...(this.options.stopAt === undefined ? {} : { stopAt: this.options.stopAt }),
            ...(this.options.maxDepth === undefined ? {} : { maxDepth: this.options.maxDepth }),
            ...(this.options.maxElements === undefined ? {} : { maxElements: Math.max(1, this.options.maxElements - this.settled.size) }),
        });
        const elements = [...result.elements.values()];
        const error = result.error;
        if (error === undefined) {
            this.settleElements(elements);
            this.watermark = stream.position;
            this.stopReached = result.stoppedAt !== undefined;
            this.lastOutcome = { kind: 'complete' };
            return;
        }
        const totalNeeded = error.totalNeeded;
        if (totalNeeded === undefined) {
            // terminal corruption: nothing further settles (a salvaged partial
            // element would not match the authoritative end() parse) — the full
            // partial results are available from end()
            this.lastOutcome = { kind: 'malformed', error };
            return;
        }
        // Truncated. The last-read root element is never settled: it may be a
        // salvaged partial (nested-EOF salvage records an end equal to the
        // truncation offset, so an offset comparison cannot tell it apart), and
        // re-parsing a complete one is a single element of redundant work. The
        // watermark only ever moves to known root boundaries — never to
        // error.offset, which can point inside a header or value.
        const last = elements[elements.length - 1];
        this.settleElements(elements.slice(0, -1));
        if (last !== undefined) {
            this.watermark = last.startOffset;
            // its header was seen: everything before it is settled, so the
            // ordering-derived signals may advance
            this.maxSeenRootTag = Math.max(this.maxSeenRootTag, last.tag);
        }
        this.lastOutcome = { kind: 'needMoreBytes', truncation: { offset: error.offset ?? this.written, totalNeeded } };
        this.probeOrderedSignals();
    }

    /**
     * Ordering-derived signals must advance even while the element that proves
     * them is still in flight — e.g. "everything before PixelData is
     * available" should fire the moment the PixelData *header* is readable,
     * long before its value finishes arriving (and a truncated value never
     * settles). A stopAt-bounded probe from the watermark supplies exactly
     * that proof: its `stoppedAt` is a real root header ≥ the probe target. It
     * stops at the trigger, so it re-walks at most the few unsettled elements.
     */
    private probeOrderedSignals(): void {
        const plan = this.plan as WirePlan;
        const targets: Tag[] = this.wantedTags.filter(tag => !this.settled.has(tag) && this.maxSeenRootTag <= tag);
        if (this.maxSeenRootTag < TAG_PIXEL_DATA) {
            targets.push(TAG_PIXEL_DATA);
        }
        if (targets.length === 0) {
            return;
        }
        const stream = new ByteStream(this.bytes(), { position: this.watermark, littleEndian: plan.littleEndian, strictEof: true });
        const result = readElements(stream, {
            explicitVr: plan.explicitVr,
            compressedTransferSyntax: plan.compressed,
            stopAt: { tag: Math.max(...targets) },
            ...(this.options.vrLookup === undefined ? {} : { vrLookup: this.options.vrLookup }),
            ...(this.options.maxDepth === undefined ? {} : { maxDepth: this.options.maxDepth }),
        });
        if (result.stoppedAt !== undefined) {
            this.maxSeenRootTag = Math.max(this.maxSeenRootTag, result.stoppedAt);
        }
    }

    private settleElements(elements: readonly DicomElement[]): void {
        for (const element of elements) {
            this.settled.set(element.tag, element);
            this.maxSeenRootTag = Math.max(this.maxSeenRootTag, element.tag);
            this.options.onElement?.(element);
        }
    }
}
