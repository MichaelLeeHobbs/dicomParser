/**
 * Encapsulated pixel-data scanner: basic offset table + fragments.
 *
 * Rewrites legacy `findEndOfEncapsulatedPixelData` with the corrected delimiter
 * model: the closing Sequence Delimitation Item is consumed structurally and
 * treated as zero-length regardless of its encoded length — a non-compliant
 * `0xFFFFFFFF` delimiter length made upstream seek past the buffer and throw
 * (upstream #266).
 *
 * @module encapsulated
 */

import type { ByteStream } from './byteStream';
import type { EncapsulatedElement, Fragment } from './element';
import { DicomError } from './errors';
import type { ElementHeader } from './elementHeader';
import { TAG_ITEM, TAG_SEQUENCE_DELIMITATION, UNDEFINED_LENGTH, tagToString } from './tag';

function readBasicOffsetTable(stream: ByteStream): number[] {
    const itemTag = stream.readTag();
    if (itemTag !== TAG_ITEM) {
        throw new DicomError('malformed', `encapsulated pixel data: basic offset table item (FFFE,E000) not found at offset ${stream.position - 4}`, {
            offset: stream.position - 4,
        });
    }
    const itemLength = stream.readUint32();
    if (itemLength === UNDEFINED_LENGTH) {
        throw new DicomError('malformed', 'encapsulated pixel data: basic offset table item has undefined length', { offset: stream.position - 4 });
    }
    if (itemLength > stream.remaining) {
        throw new DicomError('buffer-overread', `encapsulated pixel data: basic offset table length ${itemLength} exceeds remaining bytes`, {
            offset: stream.position - 4,
        });
    }
    const entryCount = Math.floor(itemLength / 4);
    const basicOffsetTable: number[] = [];
    for (let i = 0; i < entryCount; i++) {
        basicOffsetTable.push(stream.readUint32());
    }
    stream.seek(itemLength - entryCount * 4);
    return basicOffsetTable;
}

function readFragmentLength(stream: ByteStream, header: ElementHeader): number {
    const length = stream.readUint32();
    if (length === UNDEFINED_LENGTH) {
        throw new DicomError('malformed', `encapsulated pixel data ${tagToString(header.tag)}: fragment with undefined length`, {
            offset: stream.position - 4,
        });
    }
    if (length > stream.remaining) {
        stream.warnings.push({
            code: 'length-adjusted',
            message: `fragment length ${length} exceeds remaining bytes; clamped to ${stream.remaining}`,
            offset: stream.position - 4,
        });
        return stream.remaining;
    }
    return length;
}

/**
 * Scans an undefined-length pixel-data value: basic offset table item, fragment
 * items, closing sequence delimiter. Leaves the stream one past the delimiter
 * (or at end-of-stream with a warning when the delimiter is missing).
 *
 * Legacy quirk preserved: a non-item tag inside the value is tolerated as a
 * final fragment with a warning (upstream shipped files that do this).
 *
 * @param stream - Stream positioned at the first value byte
 * @param header - The pixel-data element's header
 * @returns The encapsulated element with exact byte accounting
 * @throws DicomError `malformed`/`buffer-overread` when the structure is unreadable
 */
export function scanEncapsulatedPixelData(stream: ByteStream, header: ElementHeader): EncapsulatedElement {
    const basicOffsetTable = readBasicOffsetTable(stream);
    const fragments: Fragment[] = [];
    const { contentEnd, endOffset } = scanFragments(stream, header, fragments);
    return {
        kind: 'encapsulated',
        tag: header.tag,
        vr: header.vr,
        vrSource: header.vrSource,
        startOffset: header.startOffset,
        dataOffset: header.dataOffset,
        length: contentEnd - header.dataOffset,
        endOffset,
        hadUndefinedLength: true,
        basicOffsetTable,
        fragments,
    };
}

function scanFragments(stream: ByteStream, header: ElementHeader, fragments: Fragment[]): { contentEnd: number; endOffset: number } {
    const baseOffset = stream.position;
    while (stream.remaining >= 8) {
        const itemStart = stream.position;
        const itemTag = stream.readTag();
        if (itemTag === TAG_SEQUENCE_DELIMITATION) {
            const delimiterLength = stream.readUint32();
            if (delimiterLength !== 0) {
                stream.warnings.push({
                    code: 'nonzero-delimiter-length',
                    message: `sequence delimiter of ${tagToString(header.tag)} has non-zero length ${delimiterLength}; treated as zero`,
                    offset: itemStart + 4,
                });
            }
            return { contentEnd: itemStart, endOffset: stream.position };
        }
        const length = readFragmentLength(stream, header);
        fragments.push({ offset: itemStart - baseOffset, position: stream.position, length });
        stream.seek(length);
        if (itemTag !== TAG_ITEM) {
            stream.warnings.push({
                code: 'unexpected-tag',
                message: `unexpected tag ${tagToString(itemTag)} while reading encapsulated pixel data; treated as final fragment`,
                offset: itemStart,
            });
            return { contentEnd: stream.position, endOffset: stream.position };
        }
    }
    stream.seek(stream.remaining);
    stream.warnings.push({
        code: 'missing-sequence-delimiter',
        message: `pixel data element ${tagToString(header.tag)} missing sequence delimiter (FFFE,E0DD)`,
        offset: stream.position,
    });
    return { contentEnd: stream.position, endOffset: stream.position };
}
