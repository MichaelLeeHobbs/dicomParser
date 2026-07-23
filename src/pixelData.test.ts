import { describe, expect, it } from 'vitest';
import { DicomDataSet } from './dataSet';
import { DicomError } from './errors';
import { parse } from './parse';
import { createJpegBasicOffsetTable, nativePixelDataView, readEncapsulatedImageFrame, readEncapsulatedPixelDataFromFragments } from './pixelData';
import { readElements } from './tokenizer';
import { ByteStream } from './byteStream';
import { TS, concat, encapsulatedPixelData, explicitEl, p10 } from '../tests/helpers/p10';

// Ports the behavior of legacy readEncapsulatedPixelDataFromFragments /
// readEncapsulatedImageFrame / createJPEGBasicOffsetTable onto the new model,
// plus the #73 typed-view helper.

/** Encapsulated pixel data with an explicit BOT and per-fragment payloads. */
function encapsulatedWithBot(fragments: readonly Uint8Array[], bot: readonly number[]): Uint8Array {
    return encapsulatedPixelData(fragments, bot);
}

function parseFile(elements: readonly Uint8Array[]): ReturnType<typeof parse> {
    const result = parse(p10(TS.jpegBaseline, elements));
    expect(result.error).toBeUndefined();
    return result;
}

describe('readEncapsulatedPixelDataFromFragments', () => {
    const fragA = Uint8Array.from([1, 2, 3, 4]);
    const fragB = Uint8Array.from([5, 6]);
    const fragC = Uint8Array.from([7, 8, 9, 10]);

    it('returns a zero-copy view for a single fragment', () => {
        const result = parseFile([encapsulatedWithBot([fragA, fragB], [])]);
        const element = result.dataSet.element('x7fe00010');
        const bytes = readEncapsulatedPixelDataFromFragments(result.bytes, element as NonNullable<typeof element>, 0);
        expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
        expect(bytes.buffer).toBe(result.bytes.buffer);
    });

    it('concatenates multiple fragments', () => {
        const result = parseFile([encapsulatedWithBot([fragA, fragB, fragC], [])]);
        const element = result.dataSet.element('x7fe00010');
        const bytes = readEncapsulatedPixelDataFromFragments(result.bytes, element as NonNullable<typeof element>, 0, 3);
        expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('validates indexes and element kind', () => {
        const result = parseFile([encapsulatedWithBot([fragA], [])]);
        const element = result.dataSet.element('x7fe00010') as NonNullable<ReturnType<typeof result.dataSet.element>>;
        expect(() => readEncapsulatedPixelDataFromFragments(result.bytes, element, -1)).toThrow(DicomError);
        expect(() => readEncapsulatedPixelDataFromFragments(result.bytes, element, 1)).toThrow(DicomError);
        expect(() => readEncapsulatedPixelDataFromFragments(result.bytes, element, 0, 2)).toThrow(DicomError);
        const native = parseFile([explicitEl('7FE00010', 'OB', fragA)]);
        const nativeEl = native.dataSet.element('x7fe00010') as NonNullable<ReturnType<typeof result.dataSet.element>>;
        expect(() => readEncapsulatedPixelDataFromFragments(native.bytes, nativeEl, 0)).toThrow(/does not hold encapsulated/);
    });
});

describe('readEncapsulatedImageFrame', () => {
    // two frames: frame 0 = fragments 0-1, frame 1 = fragment 2
    const fragments = [Uint8Array.from([1, 2]), Uint8Array.from([3, 4]), Uint8Array.from([5, 6])];
    // fragment items are 8 (header) + 2 (data) = 10 bytes each
    const bot = [0, 20];

    it('extracts frames via the basic offset table', () => {
        const result = parseFile([encapsulatedWithBot(fragments, bot)]);
        const element = result.dataSet.element('x7fe00010') as NonNullable<ReturnType<typeof result.dataSet.element>>;
        expect(Array.from(readEncapsulatedImageFrame(result.bytes, element, 0))).toEqual([1, 2, 3, 4]);
        expect(Array.from(readEncapsulatedImageFrame(result.bytes, element, 1))).toEqual([5, 6]);
    });

    it('validates the frame index and offset table', () => {
        const result = parseFile([encapsulatedWithBot(fragments, bot)]);
        const element = result.dataSet.element('x7fe00010') as NonNullable<ReturnType<typeof result.dataSet.element>>;
        expect(() => readEncapsulatedImageFrame(result.bytes, element, 2)).toThrow(DicomError);
        expect(() => readEncapsulatedImageFrame(result.bytes, element, -1)).toThrow(DicomError);
        const noBot = parseFile([encapsulatedWithBot(fragments, [])]);
        const noBotEl = noBot.dataSet.element('x7fe00010') as NonNullable<ReturnType<typeof result.dataSet.element>>;
        expect(() => readEncapsulatedImageFrame(noBot.bytes, noBotEl, 0)).toThrow(/basic offset table is empty/);
    });

    it('reports malformed when the table points at no fragment', () => {
        const result = parseFile([encapsulatedWithBot(fragments, [0, 7])]);
        const element = result.dataSet.element('x7fe00010') as NonNullable<ReturnType<typeof result.dataSet.element>>;
        expect(() => readEncapsulatedImageFrame(result.bytes, element, 1)).toThrow(/no fragment matches/);
    });
});

describe('createJpegBasicOffsetTable', () => {
    it('detects frame boundaries at JPEG end-of-image markers', () => {
        // frame 1 = frags 0-1 (EOI at end of frag 1), frame 2 = frag 2
        const fragments = [Uint8Array.from([0xff, 0xd8, 1, 2]), Uint8Array.from([3, 4, 0xff, 0xd9]), Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])];
        const result = parseFile([encapsulatedWithBot(fragments, [])]);
        const element = result.dataSet.element('x7fe00010') as NonNullable<ReturnType<typeof result.dataSet.element>>;
        // fragment items are 12 bytes each (8 header + 4 data)
        expect(createJpegBasicOffsetTable(result.bytes, element)).toEqual([0, 24]);
    });

    it('handles padded end-of-image markers (EOI one byte before the end)', () => {
        const fragments = [Uint8Array.from([1, 2, 0xff, 0xd9, 0x00, 0x00]), Uint8Array.from([3, 4, 0xff, 0xd9])];
        // second fragment's EOI is at the exact end; first is followed by padding —
        // legacy only checks last-2 and last-3 positions, so use a 1-byte pad
        const padded = [Uint8Array.from([1, 2, 0xff, 0xd9, 0x00, 0x00]), Uint8Array.from([3, 4, 0xff, 0xd9])];
        void padded;
        const result = parseFile([encapsulatedWithBot(fragments, [])]);
        const element = result.dataSet.element('x7fe00010') as NonNullable<ReturnType<typeof result.dataSet.element>>;
        // first fragment's EOI is not in the last 3 bytes, so it reads as one frame
        expect(createJpegBasicOffsetTable(result.bytes, element)).toEqual([0]);
    });

    // Multi-frame coverage (review B4): forces ≥2 outer-loop iterations, the
    // endFragmentIndex<0 early return, and the padded-last-3-bytes EOI branch
    // (isFragmentEndOfImage's second disjunct). Each fragment item = 8-byte
    // header + data, so offsets advance by 8 + payload length.
    it('builds one entry per frame when each fragment ends in an EOI marker', () => {
        // three EOI-terminated fragments (4 data bytes → 12-byte items each)
        const fragments = [Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])];
        const result = parseFile([encapsulatedWithBot(fragments, [])]);
        const element = result.dataSet.element('x7fe00010') as NonNullable<ReturnType<typeof result.dataSet.element>>;
        expect(createJpegBasicOffsetTable(result.bytes, element)).toEqual([0, 12, 24]);
    });

    it('groups fragments per frame when a frame spans multiple fragments', () => {
        // A + B form frame 0 (EOI ends B), C + D form frame 1 (EOI ends D)
        const fragments = [
            Uint8Array.from([1, 2, 3, 4]),
            Uint8Array.from([5, 6, 0xff, 0xd9]),
            Uint8Array.from([7, 8, 9, 10]),
            Uint8Array.from([11, 12, 0xff, 0xd9]),
        ];
        const result = parseFile([encapsulatedWithBot(fragments, [])]);
        const element = result.dataSet.element('x7fe00010') as NonNullable<ReturnType<typeof result.dataSet.element>>;
        // frame 0 starts at offset 0; frame 1 starts after A(12)+B(12) = offset 24
        expect(createJpegBasicOffsetTable(result.bytes, element)).toEqual([0, 24]);
    });

    it('detects an EOI marker padded into the last three bytes', () => {
        // frag1: EOI at position len-3 (odd-length payload padded with a trailing byte)
        const fragments = [Uint8Array.from([1, 2, 3, 0xff, 0xd9, 0x00]), Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])];
        const result = parseFile([encapsulatedWithBot(fragments, [])]);
        const element = result.dataSet.element('x7fe00010') as NonNullable<ReturnType<typeof result.dataSet.element>>;
        // frag1 item = 8 + 6 = 14 bytes, so frame 1 starts at offset 14
        expect(createJpegBasicOffsetTable(result.bytes, element)).toEqual([0, 14]);
    });

    it('returns a single entry when no fragment ends in an EOI marker (early return)', () => {
        const fragments = [Uint8Array.from([1, 2, 3, 4]), Uint8Array.from([5, 6, 7, 8])];
        const result = parseFile([encapsulatedWithBot(fragments, [])]);
        const element = result.dataSet.element('x7fe00010') as NonNullable<ReturnType<typeof result.dataSet.element>>;
        expect(createJpegBasicOffsetTable(result.bytes, element)).toEqual([0]);
    });

    it('matches NumberOfFrames on the real multi-frame JPEG-baseline fixture', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const bytes = new Uint8Array(
            readFileSync(join(__dirname, '..', 'testImages', 'encapsulated', 'multi-frame', 'CT0012.fragmented_no_bot_jpeg_baseline.51.dcm'))
        );
        const result = parse(bytes);
        expect(result.error).toBeUndefined();
        const element = result.dataSet.element('x7fe00010') as NonNullable<ReturnType<typeof result.dataSet.element>>;
        const table = createJpegBasicOffsetTable(result.bytes, element);
        expect(table[0]).toBe(0);
        expect(table.length).toBe(result.dataSet.intString('x00280008'));
    });
});

describe('nativePixelDataView (#73)', () => {
    function dataSetWith(elements: readonly Uint8Array[], littleEndian = true): DicomDataSet {
        const bytes = concat(elements);
        const result = readElements(new ByteStream(bytes, { littleEndian }), { explicitVr: true });
        expect(result.error).toBeUndefined();
        return new DicomDataSet(bytes, littleEndian, result.elements);
    }

    it('returns a Uint16Array for 16-bit unsigned pixel data', () => {
        const dataSet = dataSetWith([
            explicitEl('00280100', 'US', Uint8Array.from([16, 0])),
            explicitEl('00280103', 'US', Uint8Array.from([0, 0])),
            explicitEl('7FE00010', 'OW', Uint8Array.from([0x01, 0x02, 0x03, 0x04])),
        ]);
        const view = nativePixelDataView(dataSet);
        expect(view).toBeInstanceOf(Uint16Array);
        expect(Array.from(view as Uint16Array)).toEqual([0x0201, 0x0403]);
    });

    it('returns an Int16Array for signed pixel representation', () => {
        const dataSet = dataSetWith([
            explicitEl('00280100', 'US', Uint8Array.from([16, 0])),
            explicitEl('00280103', 'US', Uint8Array.from([1, 0])),
            explicitEl('7FE00010', 'OW', Uint8Array.from([0xff, 0xff, 0x00, 0x80])),
        ]);
        const view = nativePixelDataView(dataSet);
        expect(view).toBeInstanceOf(Int16Array);
        expect(Array.from(view as Int16Array)).toEqual([-1, -32768]);
    });

    it('returns Uint8Array/Int8Array for 8-bit pixel data', () => {
        const unsigned = dataSetWith([explicitEl('00280100', 'US', Uint8Array.from([8, 0])), explicitEl('7FE00010', 'OB', Uint8Array.from([1, 255]))]);
        expect(nativePixelDataView(unsigned)).toBeInstanceOf(Uint8Array);
        const signed = dataSetWith([
            explicitEl('00280100', 'US', Uint8Array.from([8, 0])),
            explicitEl('00280103', 'US', Uint8Array.from([1, 0])),
            explicitEl('7FE00010', 'OB', Uint8Array.from([0xff, 0x7f])),
        ]);
        const view = nativePixelDataView(signed);
        expect(view).toBeInstanceOf(Int8Array);
        expect(Array.from(view as Int8Array)).toEqual([-1, 127]);
    });

    it('copies when the absolute offset is unaligned', () => {
        // craft an unaligned start: subarray at odd offset within a parent buffer
        const parent = new Uint8Array(1 + 12 + 8 + 4 + 8 + 2 + 20);
        const content = concat([
            explicitEl('00280100', 'US', Uint8Array.from([16, 0])),
            explicitEl('7FE00010', 'OW', Uint8Array.from([0x01, 0x02, 0x03, 0x04])),
        ]);
        parent.set(content, 1);
        const bytes = parent.subarray(1, 1 + content.length);
        const result = readElements(new ByteStream(bytes), { explicitVr: true });
        const dataSet = new DicomDataSet(bytes, true, result.elements);
        const view = nativePixelDataView(dataSet);
        expect(view).toBeInstanceOf(Uint16Array);
        expect(Array.from(view as Uint16Array)).toEqual([0x0201, 0x0403]);
    });

    it('returns undefined for absent or encapsulated pixel data', () => {
        const noPixels = dataSetWith([explicitEl('00280100', 'US', Uint8Array.from([16, 0]))]);
        expect(nativePixelDataView(noPixels)).toBeUndefined();
        const result = parseFile([encapsulatedPixelData([Uint8Array.from([1, 2])], [])]);
        expect(nativePixelDataView(result.dataSet)).toBeUndefined();
    });

    it('rejects unsupported BitsAllocated', () => {
        const dataSet = dataSetWith([explicitEl('00280100', 'US', Uint8Array.from([32, 0])), explicitEl('7FE00010', 'OW', Uint8Array.from([1, 2, 3, 4]))]);
        expect(() => nativePixelDataView(dataSet)).toThrow(DicomError);
    });
});

describe('real encapsulated files', () => {
    it('extracts a frame from the multi-frame RLE fixture', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const bytes = new Uint8Array(readFileSync(join(__dirname, '..', 'testImages', 'encapsulated', 'multi-frame', 'CT0012.not_fragmented_bot_rle.dcm')));
        const result = parse(bytes);
        expect(result.error).toBeUndefined();
        const element = result.dataSet.element('x7fe00010') as NonNullable<ReturnType<typeof result.dataSet.element>>;
        const frame0 = readEncapsulatedImageFrame(result.bytes, element, 0);
        expect(frame0.length).toBeGreaterThan(0);
        // RLE frames begin with a 64-byte header whose first uint32 is the segment count
        const segments = new DataView(frame0.buffer, frame0.byteOffset).getUint32(0, true);
        expect(segments).toBeGreaterThan(0);
        expect(segments).toBeLessThanOrEqual(15);
    });
});
