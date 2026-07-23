/**
 * The core tokenizer: reads a stream of data elements, including nested
 * sequences and encapsulated pixel data, into the discriminated-union element
 * model.
 *
 * Design constraints (see docs/TypeScript Coding Standard):
 *
 * - **No recursion.** Sequence nesting is handled with an explicit frame stack
 *   and a bounded loop: every step either advances the stream or pops a frame,
 *   and pushes are bounded by `maxDepth` — malformed input cannot overflow the
 *   call stack or hang the parser.
 * - **Delimiters are consumed structurally** (upstream #244/#143): item and
 *   sequence delimitation items never surface as dataset elements, and their
 *   encoded length is ignored — a non-zero value is a warning, never a seek
 *   (upstream #266).
 * - **Typed errors with partial results** (upstream #46/#203/#277): on failure
 *   the frame stack is unwound and everything parsed so far is returned
 *   alongside the error.
 * - **`stopAt` uses ≥ comparison** (upstream #104 via PR #268/#52): parsing
 *   stops at the first root-level element whose tag is ≥ the requested tag,
 *   whether or not that tag exists.
 *
 * @module tokenizer
 */

import type { ByteStream } from './byteStream';
import { DicomDataSet } from './dataSet';
import type { DicomElement, SequenceElement, SequenceItem, UnknownElement, ValueElement } from './element';
import { scanEncapsulatedPixelData } from './encapsulated';
import { DicomError, type ParseWarningCode } from './errors';
import { readExplicitElementHeader, readImplicitElementHeader, type ElementHeader, type VrLookup } from './elementHeader';
import {
    TAG_ITEM,
    TAG_ITEM_DELIMITATION,
    TAG_PIXEL_DATA,
    TAG_SEQUENCE_DELIMITATION,
    UNDEFINED_LENGTH,
    isPrivateTag,
    tagToString,
    toTag,
    type Tag,
    type TagLike,
} from './tag';

/** Stop condition for partial parsing (root-level elements only). */
export interface StopAtOption {
    /** Parsing stops at the first root-level element with tag ≥ this tag. */
    readonly tag: TagLike;
    /** Fully parse the triggering element before stopping (default `true`). */
    readonly inclusive?: boolean;
}

/** Options for {@link readElements}. */
export interface ReadElementsOptions {
    /** `true` (default) for explicit VR, `false` for implicit VR. */
    readonly explicitVr?: boolean;
    /** VR source for implicit elements (the core is dictionary-free). */
    readonly vrLookup?: VrLookup;
    /** Stop condition with ≥ semantics. */
    readonly stopAt?: StopAtOption;
    /** Maximum sequence nesting depth (default 128). */
    readonly maxDepth?: number;
}

/** Result of {@link readElements}: always populated, even on failure. */
export interface ReadElementsResult {
    /** Every root-level element parsed, in stream order. */
    readonly elements: Map<Tag, DicomElement>;
    /** The failure that ended parsing, or `undefined` on success. */
    readonly error: DicomError | undefined;
    /** The tag that triggered `stopAt`, when parsing stopped early. */
    readonly stoppedAt: Tag | undefined;
}

interface DataSetFrame {
    readonly kind: 'dataset';
    readonly explicitVr: boolean;
    readonly elements: Map<Tag, DicomElement>;
    /** Absolute position one past the last readable content byte. */
    bound: number;
    readonly undefinedLength: boolean;
    readonly root: boolean;
    readonly itemStart: number;
}

interface SequenceFrame {
    readonly kind: 'sequence';
    readonly header: ElementHeader;
    readonly contentExplicitVr: boolean;
    readonly items: SequenceItem[];
    readonly bound: number;
    readonly undefinedLength: boolean;
}

type Frame = DataSetFrame | SequenceFrame;

const DEFAULT_MAX_DEPTH = 128;

class Tokenizer {
    private readonly stream: ByteStream;
    private readonly vrLookup: VrLookup | undefined;
    private readonly stopTag: Tag | undefined;
    private readonly stopInclusive: boolean;
    private readonly maxDepth: number;
    private readonly stack: Frame[] = [];
    private elements = new Map<Tag, DicomElement>();
    private stoppedAt: Tag | undefined;
    private stopPending = false;

    constructor(stream: ByteStream, options: ReadElementsOptions) {
        this.stream = stream;
        this.vrLookup = options.vrLookup;
        this.stopTag = options.stopAt === undefined ? undefined : toTag(options.stopAt.tag);
        this.stopInclusive = options.stopAt?.inclusive ?? true;
        this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
        this.stack.push({
            kind: 'dataset',
            explicitVr: options.explicitVr ?? true,
            elements: new Map<Tag, DicomElement>(),
            bound: stream.length,
            undefinedLength: false,
            root: true,
            itemStart: stream.position,
        });
    }

    run(): ReadElementsResult {
        let error: DicomError | undefined;
        try {
            while (this.stack.length > 0) {
                const top = this.stack[this.stack.length - 1] as Frame;
                if (top.kind === 'dataset') {
                    this.stepDataSet(top);
                } else {
                    this.stepSequence(top);
                }
            }
        } catch (thrown) {
            if (!(thrown instanceof DicomError)) {
                throw thrown;
            }
            error = thrown;
            this.salvage();
        }
        return { elements: this.elements, error, stoppedAt: this.stoppedAt };
    }

    /** Unwinds open frames after a failure so partial results survive. */
    private salvage(): void {
        while (this.stack.length > 0) {
            const top = this.stack[this.stack.length - 1] as Frame;
            if (top.kind === 'dataset') {
                this.finalizeDataSet(top, this.stream.position, this.stream.position);
            } else {
                this.finalizeSequence(top, this.stream.position, this.stream.position);
            }
        }
    }

    private stepDataSet(frame: DataSetFrame): void {
        if (frame.root && this.stopPending) {
            this.finalizeDataSet(frame, this.stream.position, this.stream.position);
            return;
        }
        if (frame.undefinedLength) {
            const peeked = this.stream.peekTag();
            if (peeked === TAG_ITEM_DELIMITATION && this.stream.remaining >= 8) {
                const delimiterStart = this.stream.position;
                this.consumeDelimiter('item delimiter');
                this.finalizeDataSet(frame, delimiterStart, this.stream.position);
                return;
            }
            if (peeked === undefined || (peeked === TAG_ITEM_DELIMITATION && this.stream.remaining < 8)) {
                this.warn('missing-item-delimiter', 'eof encountered before finding item delimiter (FFFE,E00D) in item of undefined length');
                this.stream.seek(this.stream.remaining);
                this.finalizeDataSet(frame, this.stream.position, this.stream.position);
                return;
            }
            this.readElement(frame);
            return;
        }
        if (this.stream.position >= frame.bound) {
            this.finalizeDataSet(frame, this.stream.position, this.stream.position);
            return;
        }
        this.readElement(frame);
    }

    /** Reads one element header and dispatches on its shape. */
    private readElement(frame: DataSetFrame): void {
        const header = frame.explicitVr ? readExplicitElementHeader(this.stream) : readImplicitElementHeader(this.stream, this.vrLookup);
        if (frame.root && this.stopTag !== undefined && header.tag >= this.stopTag) {
            this.stoppedAt = header.tag;
            this.stopPending = true;
            if (!this.stopInclusive) {
                this.stream.position = header.startOffset;
                return;
            }
        }
        if (frame.explicitVr) {
            this.dispatchExplicit(frame, header);
        } else {
            this.dispatchImplicit(frame, header);
        }
    }

    private dispatchExplicit(frame: DataSetFrame, header: ElementHeader): void {
        if (header.vr === 'SQ') {
            this.pushSequence(frame, header, true);
            return;
        }
        if (header.hadUndefinedLength) {
            if (header.tag === TAG_PIXEL_DATA) {
                this.addElement(frame, scanEncapsulatedPixelData(this.stream, header));
                return;
            }
            if (header.vr === 'UN') {
                // CP-246: UN with undefined length is an implicit-VR sequence.
                this.pushSequence(frame, header, false);
                return;
            }
            this.addElement(frame, this.scanUnknown(header));
            return;
        }
        this.readValue(frame, header);
    }

    private dispatchImplicit(frame: DataSetFrame, header: ElementHeader): void {
        if (header.vr === 'SQ') {
            this.pushSequence(frame, header, false);
            return;
        }
        if (header.vr !== undefined) {
            // The lookup identified a non-sequence VR; peeking is skipped.
            if (header.hadUndefinedLength) {
                this.addElement(frame, this.scanUnknown(header));
            } else {
                this.readValue(frame, header);
            }
            return;
        }
        if (this.looksLikeSequence(header)) {
            this.pushSequence(frame, header, false);
            return;
        }
        if (header.hadUndefinedLength) {
            this.addElement(frame, this.scanUnknown(header));
            return;
        }
        this.readValue(frame, header);
    }

    /**
     * Peek-based implicit sequence detection. Private defined-length elements
     * are never peeked (upstream #114): without a dictionary match they stay
     * opaque binary. Undefined-length elements must be traversed regardless.
     */
    private looksLikeSequence(header: ElementHeader): boolean {
        if (!header.hadUndefinedLength && (isPrivateTag(header.tag) || header.lengthField < 8)) {
            return false;
        }
        const peeked = this.stream.peekTag();
        return peeked === TAG_ITEM || peeked === TAG_SEQUENCE_DELIMITATION;
    }

    /** Adds a defined-length value element, clamping only at stream truncation. */
    private readValue(frame: DataSetFrame, header: ElementHeader): void {
        let length = header.lengthField;
        const end = header.dataOffset + length;
        if (end > frame.bound) {
            if (frame.bound < this.stream.length) {
                throw new DicomError(
                    'malformed',
                    `element ${tagToString(header.tag)} length ${length} overruns its enclosing item/sequence bound at ${frame.bound}`,
                    { offset: header.startOffset }
                );
            }
            this.warn('unexpected-eof', `element ${tagToString(header.tag)} length ${length} overruns end of data; value truncated`);
            length = frame.bound - header.dataOffset;
        }
        this.stream.seek(length);
        const element: ValueElement = {
            kind: 'value',
            tag: header.tag,
            vr: header.vr,
            vrSource: header.vrSource,
            startOffset: header.startOffset,
            dataOffset: header.dataOffset,
            length,
            endOffset: header.dataOffset + length,
            hadUndefinedLength: false,
        };
        this.addElement(frame, element);
    }

    /**
     * Scans an undefined-length, non-sequence value for a delimitation item
     * (either FFFE,E00D or FFFE,E0DD — files disagree; both are accepted).
     */
    private scanUnknown(header: ElementHeader): UnknownElement {
        let contentEnd: number;
        for (;;) {
            const peeked = this.stream.peekTag();
            if (peeked === undefined) {
                this.warn('missing-item-delimiter', `element ${tagToString(header.tag)} of undefined length has no delimitation item; using end of data`);
                this.stream.seek(this.stream.remaining);
                contentEnd = this.stream.position;
                break;
            }
            if ((peeked === TAG_ITEM_DELIMITATION || peeked === TAG_SEQUENCE_DELIMITATION) && this.stream.remaining >= 8) {
                contentEnd = this.stream.position;
                this.consumeDelimiter(`delimiter of ${tagToString(header.tag)}`);
                break;
            }
            this.stream.seek(2);
        }
        return {
            kind: 'unknown',
            tag: header.tag,
            vr: header.vr,
            vrSource: header.vrSource,
            startOffset: header.startOffset,
            dataOffset: header.dataOffset,
            length: contentEnd - header.dataOffset,
            endOffset: this.stream.position,
            hadUndefinedLength: true,
        };
    }

    private pushSequence(frame: DataSetFrame, header: ElementHeader, contentExplicitVr: boolean): void {
        this.checkDepth();
        let bound = this.stream.length;
        if (!header.hadUndefinedLength) {
            bound = header.dataOffset + header.lengthField;
            if (bound > frame.bound) {
                throw new DicomError(
                    'malformed',
                    `sequence ${tagToString(header.tag)} length ${header.lengthField} overruns its enclosing bound at ${frame.bound}`,
                    { offset: header.startOffset }
                );
            }
        }
        this.stack.push({
            kind: 'sequence',
            header,
            contentExplicitVr,
            items: [],
            bound,
            undefinedLength: header.hadUndefinedLength,
        });
    }

    private stepSequence(frame: SequenceFrame): void {
        if (!frame.undefinedLength && this.stream.position >= frame.bound) {
            if (this.stream.position > frame.bound) {
                this.warn('length-adjusted', `sequence ${tagToString(frame.header.tag)} content overran its declared length`);
            }
            this.finalizeSequence(frame, this.stream.position, this.stream.position);
            return;
        }
        if (frame.undefinedLength) {
            if (this.stream.remaining < 8) {
                this.warn('missing-sequence-delimiter', `eof encountered before finding sequence delimiter (FFFE,E0DD) for ${tagToString(frame.header.tag)}`);
                this.stream.seek(this.stream.remaining);
                this.finalizeSequence(frame, this.stream.position, this.stream.position);
                return;
            }
            if (this.stream.peekTag() === TAG_SEQUENCE_DELIMITATION) {
                const delimiterStart = this.stream.position;
                this.consumeDelimiter(`sequence delimiter of ${tagToString(frame.header.tag)}`);
                this.finalizeSequence(frame, delimiterStart, this.stream.position);
                return;
            }
        }
        this.pushItem(frame);
    }

    private pushItem(frame: SequenceFrame): void {
        this.checkDepth();
        const itemStart = this.stream.position;
        const itemTag = this.stream.readTag();
        if (itemTag !== TAG_ITEM) {
            throw new DicomError('malformed', `item tag (FFFE,E000) not found at offset ${itemStart} in sequence ${tagToString(frame.header.tag)}`, {
                offset: itemStart,
            });
        }
        const itemLength = this.stream.readUint32();
        const undefinedLength = itemLength === UNDEFINED_LENGTH;
        let bound = this.stream.length;
        if (!undefinedLength) {
            bound = this.stream.position + itemLength;
            if (bound > this.stream.length) {
                throw new DicomError('malformed', `sequence item length ${itemLength} at offset ${itemStart} overruns end of data`, { offset: itemStart });
            }
        }
        this.stack.push({
            kind: 'dataset',
            explicitVr: frame.contentExplicitVr,
            elements: new Map<Tag, DicomElement>(),
            bound,
            undefinedLength,
            root: false,
            itemStart,
        });
    }

    private finalizeDataSet(frame: DataSetFrame, contentEnd: number, endOffset: number): void {
        this.stack.pop();
        if (frame.root) {
            this.elements = frame.elements;
            return;
        }
        const parent = this.stack[this.stack.length - 1];
        if (parent === undefined || parent.kind !== 'sequence') {
            throw new DicomError('malformed', 'internal: item frame without an enclosing sequence frame');
        }
        const dataOffset = frame.itemStart + 8;
        const item: SequenceItem = {
            startOffset: frame.itemStart,
            dataOffset,
            length: contentEnd - dataOffset,
            endOffset,
            hadUndefinedLength: frame.undefinedLength,
            dataSet: new DicomDataSet(this.stream.bytes, this.stream.littleEndian, frame.elements),
        };
        parent.items.push(item);
    }

    private finalizeSequence(frame: SequenceFrame, contentEnd: number, endOffset: number): void {
        this.stack.pop();
        const parent = this.stack[this.stack.length - 1];
        if (parent === undefined || parent.kind !== 'dataset') {
            throw new DicomError('malformed', 'internal: sequence frame without an enclosing dataset frame');
        }
        const element: SequenceElement = {
            kind: 'sequence',
            tag: frame.header.tag,
            vr: frame.header.vr,
            vrSource: frame.header.vrSource,
            startOffset: frame.header.startOffset,
            dataOffset: frame.header.dataOffset,
            length: contentEnd - frame.header.dataOffset,
            endOffset,
            hadUndefinedLength: frame.undefinedLength,
            items: frame.items,
        };
        this.addElement(parent, element);
    }

    private addElement(frame: DataSetFrame, element: DicomElement): void {
        frame.elements.set(element.tag, element);
    }

    /** Consumes an 8-byte delimitation item; its length is ignored (#266). */
    private consumeDelimiter(context: string): void {
        this.stream.seek(4);
        const length = this.stream.readUint32();
        if (length !== 0) {
            this.warn('nonzero-delimiter-length', `${context} at offset ${this.stream.position - 8} has non-zero length ${length}; treated as zero`);
        }
    }

    private checkDepth(): void {
        if (this.stack.length >= this.maxDepth) {
            throw new DicomError('depth-exceeded', `sequence nesting exceeded maxDepth (${this.maxDepth})`, { offset: this.stream.position });
        }
    }

    private warn(code: ParseWarningCode, message: string): void {
        this.stream.warnings.push({ code, message, offset: this.stream.position });
    }
}

/**
 * Reads data elements from the stream's current position to its end (or the
 * `stopAt` condition), returning root-level elements plus any failure.
 *
 * Never throws for malformed input: failures are returned as a typed error
 * alongside everything parsed before the failure point.
 *
 * @param stream - The stream to tokenize (endianness already configured)
 * @param options - VR mode, VR lookup, stop condition, depth bound
 * @returns The parsed elements, the terminating error (if any), and the
 *          `stopAt` trigger tag (if parsing stopped early)
 */
export function readElements(stream: ByteStream, options: ReadElementsOptions = {}): ReadElementsResult {
    return new Tokenizer(stream, options).run();
}
