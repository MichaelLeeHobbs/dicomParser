import { describe, expect, it } from 'vitest';
import { ByteStream } from './byteStream';
import type { EncapsulatedElement, SequenceElement, UnknownElement, ValueElement } from './element';
import { readElements } from './tokenizer';
import { tagFromString } from './tag';

// Ported from legacy readSequenceItemsExplicit_test.js,
// readSequenceItemsImplicit_test.js and the sequence/UN halves of
// readDicomElementExplicit_test.js / readDicomElementImplicit_test.js, plus new
// coverage for the corrected delimiter model (#244/#143/#266), stopAt ≥
// semantics (#104/#268/#52), typed errors with partial results (#46/#203/#277)
// and the depth bound.
//
// Byte-accounting divergence from legacy: `length` always excludes delimiters;
// `endOffset` includes them. Legacy folded delimiters into some lengths.

function streamOf(bytes: readonly number[], littleEndian = true): ByteStream {
    return new ByteStream(Uint8Array.from(bytes), { littleEndian });
}

function sq(element: unknown): SequenceElement {
    expect((element as SequenceElement).kind).toBe('sequence');
    return element as SequenceElement;
}

describe('readElements — explicit values', () => {
    it('reads consecutive value elements with exact offsets', () => {
        // (2210,4433) OB len 0 · (2211,4433) OB len 2
        const stream = streamOf([
            0x10, 0x22, 0x33, 0x44, 0x4f, 0x42, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44, 0x4f, 0x42, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
            0xaa, 0xbb,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        expect(result.elements.size).toBe(2);
        const second = result.elements.get(tagFromString('x22114433')) as ValueElement;
        expect(second.kind).toBe('value');
        expect(second.startOffset).toBe(12);
        expect(second.dataOffset).toBe(24);
        expect(second.length).toBe(2);
        expect(second.endOffset).toBe(26);
    });

    it('salvages parsed elements when a header is truncated (partial results, #203)', () => {
        const stream = streamOf([
            0x10, 0x22, 0x33, 0x44, 0x4f, 0x42, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            // 5 bytes of trailing garbage — not enough for a header
            0x11, 0x22, 0x33, 0x44, 0x4f,
        ]);
        const result = readElements(stream);
        expect(result.error?.code).toBe('buffer-overread');
        expect(result.elements.size).toBe(1);
        expect(result.elements.has(tagFromString('x22104433'))).toBe(true);
    });

    it('truncates a value overrunning end of data with a warning (legacy: silent seek past end)', () => {
        const stream = streamOf([0x11, 0x22, 0x33, 0x44, 0x53, 0x54, 0xff, 0x00, 0x41, 0x42]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x22114433')) as ValueElement;
        expect(element.length).toBe(2);
        expect(stream.warnings.some(w => w.code === 'unexpected-eof')).toBe(true);
    });
});

describe('readElements — explicit sequences', () => {
    it('parses a defined-length SQ with an empty item', () => {
        // (2211,4433) SQ len 8 · item len 0
        const stream = streamOf([0x11, 0x22, 0x33, 0x44, 0x53, 0x51, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x00, 0x00, 0x00, 0x00]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = sq(result.elements.get(tagFromString('x22114433')));
        expect(element.length).toBe(8);
        expect(element.items).toHaveLength(1);
        expect(element.items[0]?.length).toBe(0);
        expect(element.items[0]?.dataSet.elements.size).toBe(0);
    });

    it('parses an undefined-length SQ with undefined-length items; delimiters never surface as elements (#244)', () => {
        // (0008,1140) SQ undefined · item undefined · (0008,0100) SH len 2 'A ' ·
        // item delimiter · sequence delimiter
        const stream = streamOf([
            0x08, 0x00, 0x40, 0x11, 0x53, 0x51, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xff, 0x08, 0x00, 0x00, 0x01,
            0x53, 0x48, 0x02, 0x00, 0x41, 0x20, 0xfe, 0xff, 0x0d, 0xe0, 0x00, 0x00, 0x00, 0x00, 0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        expect(stream.warnings).toHaveLength(0);
        const element = sq(result.elements.get(tagFromString('x00081140')));
        expect(element.hadUndefinedLength).toBe(true);
        // content ends where the sequence delimiter starts; endOffset includes it
        expect(element.length).toBe(38 - 12);
        expect(element.endOffset).toBe(46);
        const item = element.items[0];
        expect(item?.hadUndefinedLength).toBe(true);
        expect(item?.length).toBe(10);
        expect(item?.endOffset).toBe(38);
        // the item's dataset holds only the real element — no xfffee00d leakage
        expect(item?.dataSet.elements.size).toBe(1);
        expect(item?.dataSet.element('x00080100')).toBeDefined();
        expect(item?.dataSet.element('xfffee00d')).toBeUndefined();
    });

    it('parses an undefined-length SQ containing a defined-length item (#181)', () => {
        const stream = streamOf([
            0x08, 0x00, 0x40, 0x11, 0x53, 0x51, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0x0a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x01,
            0x53, 0x48, 0x02, 0x00, 0x41, 0x20, 0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        expect(stream.warnings).toHaveLength(0);
        const element = sq(result.elements.get(tagFromString('x00081140')));
        expect(element.items).toHaveLength(1);
        expect(element.items[0]?.hadUndefinedLength).toBe(false);
        expect(element.items[0]?.length).toBe(10);
    });

    it('treats a non-zero sequence delimiter length as zero with a warning (#266)', () => {
        const stream = streamOf([
            0x08, 0x00, 0x40, 0x11, 0x53, 0x51, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0xdd, 0xe0, 0xff, 0xff, 0xff, 0xff,
            // a following element that a length-honoring seek would have skipped
            0x08, 0x00, 0x00, 0x01, 0x53, 0x48, 0x02, 0x00, 0x41, 0x20,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        expect(stream.warnings.some(w => w.code === 'nonzero-delimiter-length')).toBe(true);
        expect(sq(result.elements.get(tagFromString('x00081140'))).items).toHaveLength(0);
        expect(result.elements.get(tagFromString('x00080100'))).toBeDefined();
    });

    it('warns on eof before a sequence delimiter (legacy readSequenceItemsExplicit test)', () => {
        // SQ header with undefined length, then nothing
        const stream = streamOf([0x08, 0x00, 0x40, 0x11, 0x53, 0x51, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x00]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        expect(stream.warnings.some(w => w.code === 'missing-sequence-delimiter')).toBe(true);
        expect(sq(result.elements.get(tagFromString('x00081140'))).items).toHaveLength(0);
    });

    it('parses a UN element of undefined length as an implicit sequence (CP-246, legacy behavior)', () => {
        // (1001,2000) UN undefined · item undefined · nested empty explicit-style
        // SQ bytes read as implicit content · delimiters
        const stream = streamOf([
            0x01, 0x10, 0x00, 0x20, 0x55, 0x4e, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xff, 0x01, 0x10, 0x02, 0x20,
            0x53, 0x51, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x0d, 0xe0, 0x00, 0x00, 0x00, 0x00,
            0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = sq(result.elements.get(tagFromString('x10012000')));
        expect(element.vr).toBe('UN');
        expect(element.items).toHaveLength(1);
        expect(element.items[0]?.dataSet.elements.size).toBe(1);
        expect(element.items[0]?.dataSet.element('x10012002')).toBeDefined();
    });

    it('scans an undefined-length non-UN element to its delimiter as an unknown element', () => {
        // (2211,4433) OB undefined length (not pixel data) · garbage · item delimiter
        const stream = streamOf([
            0x11, 0x22, 0x33, 0x44, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0xfe, 0xff, 0x0d, 0xe0, 0x00, 0x00,
            0x00, 0x00,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x22114433')) as UnknownElement;
        expect(element.kind).toBe('unknown');
        expect(element.length).toBe(6);
        expect(element.endOffset).toBe(26);
        expect(element.hadUndefinedLength).toBe(true);
    });
});

describe('readElements — implicit', () => {
    const OW_LOOKUP = (tag: number): string | undefined => (tag === 0x7fe00010 ? 'OW' : undefined);

    it('detects an implicit SQ by peeking at an item tag (public tag, no lookup)', () => {
        const stream = streamOf([
            0x08, 0x00, 0x06, 0x00, 0x12, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x0a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x01, 0x02, 0x00, 0x00, 0x00,
            0x41, 0x20,
        ]);
        const result = readElements(stream, { explicitVr: false });
        expect(result.error).toBeUndefined();
        const element = sq(result.elements.get(tagFromString('x00080006')));
        expect(element.items).toHaveLength(1);
        const codeValue = element.items[0]?.dataSet.element('x00080100');
        expect(codeValue?.length).toBe(2);
        expect(codeValue?.dataOffset).toBe(24);
    });

    it('parses an implicit undefined-length empty sequence via peeking at the sequence delimiter', () => {
        const stream = streamOf([
            0x08, 0x00, 0x06, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x01, 0x02, 0x00, 0x00, 0x00,
            0x41, 0x20,
        ]);
        const result = readElements(stream, { explicitVr: false });
        expect(result.error).toBeUndefined();
        expect(sq(result.elements.get(tagFromString('x00080006'))).items).toHaveLength(0);
        expect(result.elements.get(tagFromString('x00080100'))).toBeDefined();
    });

    it('misdetects pixel-data bytes as a sequence without a lookup and reports a typed error (legacy threw)', () => {
        const stream = streamOf([0xe0, 0x7f, 0x10, 0x00, 0x08, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x0a, 0x00, 0x00, 0x00]);
        const result = readElements(stream, { explicitVr: false });
        expect(result.error?.code).toBe('malformed');
    });

    it('the VR lookup overrides peeking (item-tag-like pixel data)', () => {
        const stream = streamOf([0xe0, 0x7f, 0x10, 0x00, 0x08, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x0a, 0x00, 0x00, 0x00]);
        const result = readElements(stream, { explicitVr: false, vrLookup: OW_LOOKUP });
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x7fe00010')) as ValueElement;
        expect(element.kind).toBe('value');
        expect(element.vr).toBe('OW');
        expect(element.length).toBe(8);
    });

    it('the VR lookup overrides peeking (delimiter-tag-like pixel data)', () => {
        const stream = streamOf([0xe0, 0x7f, 0x10, 0x00, 0x0b, 0x00, 0x00, 0x00, 0xfe, 0xff, 0xdd, 0xe0, 0x0a, 0x00, 0x00, 0x00, 0x12, 0x43, 0x98]);
        const result = readElements(stream, { explicitVr: false, vrLookup: OW_LOOKUP });
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x7fe00010')) as ValueElement;
        expect(element.vr).toBe('OW');
        expect(element.length).toBe(11);
    });

    it('without a lookup, delimiter-tag-like pixel data reports a typed error (legacy threw)', () => {
        const stream = streamOf([0xe0, 0x7f, 0x10, 0x00, 0x0b, 0x00, 0x00, 0x00, 0xfe, 0xff, 0xdd, 0xe0, 0x0a, 0x00, 0x00, 0x00, 0x12, 0x43, 0x98]);
        const result = readElements(stream, { explicitVr: false });
        expect(result.error?.code).toBe('malformed');
    });

    it('keeps a private defined-length element opaque even when it looks like a sequence (#114)', () => {
        const stream = streamOf([
            0x09, 0x00, 0x06, 0x00, 0x1a, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xff, 0x08, 0x00, 0x18, 0x00, 0x02, 0x00, 0x00, 0x00,
            0x42, 0x20, 0xfe, 0xff, 0x0d, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x01, 0x02, 0x00, 0x00, 0x00, 0x41, 0x20,
        ]);
        const result = readElements(stream, { explicitVr: false });
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x00090006')) as ValueElement;
        expect(element.kind).toBe('value');
        expect(element.length).toBe(26);
        expect(result.elements.get(tagFromString('x00080100'))?.length).toBe(2);
    });

    it('parses a private undefined-length element structurally, keeping items (divergence: legacy discarded them)', () => {
        const stream = streamOf([
            0x09, 0x00, 0x06, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xff, 0x08, 0x00, 0x18, 0x00, 0x04, 0x00, 0x00, 0x00,
            0x41, 0x42, 0x43, 0x20, 0xfe, 0xff, 0x0d, 0xe0, 0x00, 0x00, 0x00, 0x00, 0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x01,
            0x02, 0x00, 0x00, 0x00, 0x41, 0x20,
        ]);
        const result = readElements(stream, { explicitVr: false });
        expect(result.error).toBeUndefined();
        const element = sq(result.elements.get(tagFromString('x00090006')));
        // content excludes the sequence delimiter: items + item delimiter = 28 bytes
        expect(element.length).toBe(28);
        expect(element.items).toHaveLength(1);
        expect(result.elements.get(tagFromString('x00080100'))?.length).toBe(2);
    });

    it('warns once for a truncated defined-length element (legacy parity)', () => {
        const stream = streamOf([0x06, 0x30, 0xa6, 0x00, 0x00, 0xff, 0xff, 0xff]);
        const result = readElements(stream, { explicitVr: false });
        expect(result.error).toBeUndefined();
        expect(result.elements.size).toBe(1);
        expect(stream.warnings).toHaveLength(1);
    });

    it('warns once for a truncated undefined-length element (legacy parity)', () => {
        const stream = streamOf([0x06, 0x30, 0xa6, 0x00, 0xff, 0xff, 0xff, 0xff]);
        const result = readElements(stream, { explicitVr: false });
        expect(result.error).toBeUndefined();
        expect(result.elements.size).toBe(1);
        expect(stream.warnings).toHaveLength(1);
    });

    it('reads an element that looks like SQ inside an undefined-length item with a lookup (legacy sequence test)', () => {
        const stream = streamOf([
            0x08, 0x00, 0x06, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xff, 0xe0, 0x7f, 0x10, 0x00, 0x08, 0x00, 0x00, 0x00,
            0xfe, 0xff, 0x00, 0xe0, 0x0a, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x0d, 0xe0, 0x00, 0x00, 0x00, 0x00, 0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00,
        ]);
        const result = readElements(stream, { explicitVr: false, vrLookup: OW_LOOKUP });
        expect(result.error).toBeUndefined();
        expect(stream.warnings).toHaveLength(0);
        const element = sq(result.elements.get(tagFromString('x00080006')));
        const item = element.items[0];
        expect(item?.length).toBe(16);
        expect(item?.endOffset).toBe(40);
        const pixelData = item?.dataSet.element('x7fe00010');
        expect(pixelData?.length).toBe(8);
        expect(pixelData?.vr).toBe('OW');
    });

    it('warns for missing item and sequence delimiters at eof (legacy sequence test)', () => {
        const stream = streamOf([
            0x08, 0x00, 0x06, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xff, 0xe0, 0x7f, 0x10, 0x00, 0x04, 0x00, 0x00, 0x00,
            0x01, 0x23, 0x45, 0x67,
        ]);
        const result = readElements(stream, { explicitVr: false, vrLookup: OW_LOOKUP });
        expect(result.error).toBeUndefined();
        const element = sq(result.elements.get(tagFromString('x00080006')));
        expect(element.items).toHaveLength(1);
        expect(element.items[0]?.dataSet.element('x7fe00010')?.length).toBe(4);
        expect(stream.warnings.some(w => w.code === 'missing-item-delimiter')).toBe(true);
        expect(stream.warnings.some(w => w.code === 'missing-sequence-delimiter')).toBe(true);
    });
});

describe('readElements — encapsulated pixel data', () => {
    // (7FE0,0010) OB undefined · empty BOT · one 4-byte fragment · delimiter
    const ENCAPSULATED = [
        0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0x00, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x04,
        0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00,
    ];

    it('parses the basic offset table and fragments', () => {
        const stream = streamOf(ENCAPSULATED);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x7fe00010')) as EncapsulatedElement;
        expect(element.kind).toBe('encapsulated');
        expect(element.basicOffsetTable).toEqual([]);
        expect(element.fragments).toHaveLength(1);
        expect(element.fragments[0]).toEqual({ offset: 0, position: 28, length: 4 });
        expect(element.length).toBe(32 - 12);
        expect(element.endOffset).toBe(40);
    });

    it('parses a populated basic offset table', () => {
        const bytes = [
            0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0xfe, 0xff, 0x00, 0xe0, 0x02, 0x00, 0x00, 0x00, 0x01, 0x02, 0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00,
        ];
        const result = readElements(streamOf(bytes));
        const element = result.elements.get(tagFromString('x7fe00010')) as EncapsulatedElement;
        expect(element.basicOffsetTable).toEqual([0]);
        expect(element.fragments[0]).toEqual({ offset: 0, position: 32, length: 2 });
    });

    it('treats a non-zero delimiter length as zero instead of seeking (#266)', () => {
        const bytes = [...ENCAPSULATED];
        // corrupt the closing delimiter's length to 0xFFFFFFFF
        bytes[36] = 0xff;
        bytes[37] = 0xff;
        bytes[38] = 0xff;
        bytes[39] = 0xff;
        const stream = streamOf(bytes);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x7fe00010')) as EncapsulatedElement;
        expect(element.fragments).toHaveLength(1);
        expect(stream.warnings.some(w => w.code === 'nonzero-delimiter-length')).toBe(true);
    });

    it('warns when the sequence delimiter is missing', () => {
        const stream = streamOf(ENCAPSULATED.slice(0, 32));
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x7fe00010')) as EncapsulatedElement;
        expect(element.fragments).toHaveLength(1);
        expect(stream.warnings.some(w => w.code === 'missing-sequence-delimiter')).toBe(true);
    });

    it('reports a typed error for a basic offset table with undefined length', () => {
        const stream = streamOf([0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xff]);
        const result = readElements(stream);
        expect(result.error?.code).toBe('malformed');
    });

    it('reports a typed error for a basic offset table longer than the data', () => {
        const stream = streamOf([0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0xf0, 0x00, 0x00, 0x00]);
        const result = readElements(stream);
        expect(result.error?.code).toBe('buffer-overread');
    });

    it('reports a typed error for a fragment with undefined length', () => {
        const stream = streamOf([
            0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0x00, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0,
            0xff, 0xff, 0xff, 0xff,
        ]);
        const result = readElements(stream);
        expect(result.error?.code).toBe('malformed');
    });

    it('clamps a fragment length overrunning the data with a warning', () => {
        const stream = streamOf([
            0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0x00, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0,
            0xf0, 0x00, 0x00, 0x00, 0x01, 0x02,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x7fe00010')) as EncapsulatedElement;
        expect(element.fragments[0]?.length).toBe(2);
        expect(stream.warnings.some(w => w.code === 'length-adjusted')).toBe(true);
        expect(stream.warnings.some(w => w.code === 'missing-sequence-delimiter')).toBe(true);
    });

    it('reports a typed error when the basic offset table is missing', () => {
        const stream = streamOf([0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
        const result = readElements(stream);
        expect(result.error?.code).toBe('malformed');
    });

    it('tolerates an unexpected tag as a final fragment with a warning (legacy behavior)', () => {
        const stream = streamOf([
            0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x01,
            0x02, 0x00, 0x00, 0x00, 0x41, 0x20,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x7fe00010')) as EncapsulatedElement;
        expect(element.fragments).toHaveLength(1);
        expect(stream.warnings.some(w => w.code === 'unexpected-tag')).toBe(true);
    });
});

describe('readElements — length pathologies', () => {
    it('reports a typed error when a defined-length SQ overruns its enclosing bound', () => {
        // SQ claims 0xF0 bytes but only 8 remain
        const stream = streamOf([0x11, 0x22, 0x33, 0x44, 0x53, 0x51, 0x00, 0x00, 0xf0, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x00, 0x00, 0x00, 0x00]);
        const result = readElements(stream);
        expect(result.error?.code).toBe('malformed');
    });

    it('warns when defined-length SQ content overruns the declared length', () => {
        // SQ len 8, but its single item declares 10 content bytes
        const stream = streamOf([
            0x11, 0x22, 0x33, 0x44, 0x53, 0x51, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x0a, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
            0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        expect(stream.warnings.some(w => w.code === 'length-adjusted')).toBe(true);
        expect(sq(result.elements.get(tagFromString('x22114433'))).items).toHaveLength(1);
    });

    it('reports a typed error when a sequence item overruns end of data', () => {
        const stream = streamOf([0x11, 0x22, 0x33, 0x44, 0x53, 0x51, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0xf0, 0x00, 0x00, 0x00]);
        const result = readElements(stream);
        expect(result.error?.code).toBe('malformed');
        // the sequence itself is salvaged
        expect(result.elements.size).toBe(1);
    });

    it('reports a typed error when a value overruns its enclosing item bound', () => {
        // item declares 10 bytes; the element inside claims 0x20
        const stream = streamOf([
            0x11, 0x22, 0x33, 0x44, 0x53, 0x51, 0x00, 0x00, 0x12, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x0a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x01,
            0x53, 0x48, 0x20, 0x00, 0x41, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ]);
        const result = readElements(stream);
        expect(result.error?.code).toBe('malformed');
    });
});

describe('readElements — stopAt (≥ semantics, #104/#268/#52)', () => {
    // (0008,0100) SH 'A ' · (0010,0010) PN 'X ' · (7FE0,0010) OB len 2
    const THREE_ELEMENTS = [
        0x08, 0x00, 0x00, 0x01, 0x53, 0x48, 0x02, 0x00, 0x41, 0x20, 0x10, 0x00, 0x10, 0x00, 0x50, 0x4e, 0x02, 0x00, 0x58, 0x20, 0xe0, 0x7f, 0x10, 0x00, 0x4f,
        0x42, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x02,
    ];

    it('stops inclusively at an exact match', () => {
        const result = readElements(streamOf(THREE_ELEMENTS), { stopAt: { tag: 'x00100010' } });
        expect(result.stoppedAt).toBe(tagFromString('x00100010'));
        expect(result.elements.size).toBe(2);
        expect(result.elements.has(tagFromString('x00100010'))).toBe(true);
        expect(result.elements.has(tagFromString('x7fe00010'))).toBe(false);
    });

    it('stops at the first tag greater than a missing tag (the #104 fix)', () => {
        const result = readElements(streamOf(THREE_ELEMENTS), { stopAt: { tag: 'x00100005' } });
        expect(result.stoppedAt).toBe(tagFromString('x00100010'));
        expect(result.elements.size).toBe(2);
    });

    it('excludes the triggering element when inclusive is false (#52)', () => {
        const result = readElements(streamOf(THREE_ELEMENTS), { stopAt: { tag: 'x00100010', inclusive: false } });
        expect(result.stoppedAt).toBe(tagFromString('x00100010'));
        expect(result.elements.size).toBe(1);
        expect(result.elements.has(tagFromString('x00100010'))).toBe(false);
    });

    it('does not stop inside sequence items', () => {
        const stream = streamOf([
            0x08, 0x00, 0x40, 0x11, 0x53, 0x51, 0x00, 0x00, 0x12, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x0a, 0x00, 0x00, 0x00, 0x10, 0x00, 0x10, 0x00,
            0x50, 0x4e, 0x02, 0x00, 0x58, 0x20,
        ]);
        const result = readElements(stream, { stopAt: { tag: 'x00100010' } });
        expect(result.stoppedAt).toBeUndefined();
        const element = sq(result.elements.get(tagFromString('x00081140')));
        expect(element.items[0]?.dataSet.element('x00100010')).toBeDefined();
    });
});

describe('readElements — depth bound', () => {
    it('reports a typed error when nesting exceeds maxDepth', () => {
        // Implicit SQ nesting: each level is an undefined-length element whose
        // content starts with an item that again starts a sequence-looking tag.
        const bytes: number[] = [];
        for (let i = 0; i < 8; i++) {
            bytes.push(0x08, 0x00, 0x06, 0x00, 0xff, 0xff, 0xff, 0xff);
            bytes.push(0xfe, 0xff, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xff);
        }
        const result = readElements(streamOf(bytes), { explicitVr: false, maxDepth: 6 });
        expect(result.error?.code).toBe('depth-exceeded');
        // partial results survive: the outermost sequence is present
        expect(result.elements.size).toBe(1);
    });
});
