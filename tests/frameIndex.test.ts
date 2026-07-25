import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EncapsulatedElement } from '../src/element';
import { frameFragments, framePayload, readFrameIndexAsync, type FrameIndex, type FrameRange } from '../src/frameIndex';
import { parseHeadAsync, type RangeReader } from '../src/headRead';
import { parse } from '../src/parse';
import { collectTestImages } from './helpers/corpus';
import { concat, evenPad, explicitEl, implicitEl, latin1, p10, p10Deflated, tagBytes, TS, uint32Bytes } from './helpers/p10';

// Differential suite for issue #38: the ranged frame index must locate exactly
// the bytes a whole-file parse would, from the header + offset tables alone —
// never the pixel payload.

function memReader(bytes: Uint8Array): RangeReader & { totalRead: number } {
    const r = {
        size: bytes.length,
        totalRead: 0,
        read(offset: number, length: number): Uint8Array {
            const end = Math.min(bytes.length, offset + length);
            r.totalRead += Math.max(0, end - offset);
            return bytes.slice(offset, end);
        },
    };
    return r;
}

/** Builds an undefined-length encapsulated PixelData element with explicit control of the BOT. */
function encapsulated(botEntries: readonly number[], fragments: readonly Uint8Array[], implicitVr = false): Uint8Array {
    const undefinedLength = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
    const head = implicitVr
        ? concat([tagBytes('7FE00010'), undefinedLength])
        : concat([tagBytes('7FE00010'), latin1('OB'), new Uint8Array(2), undefinedLength]);
    const bot = concat([tagBytes('FFFEE000'), uint32Bytes(botEntries.length * 4, false), ...botEntries.map(entry => uint32Bytes(entry, false))]);
    const items = fragments.map(fragment => concat([tagBytes('FFFEE000'), uint32Bytes(fragment.length, false), fragment]));
    return concat([head, bot, ...items, tagBytes('FFFEE0DD'), new Uint8Array(4)]);
}

/** Encodes raw 64-bit values (used for out-of-JS-range Extended Offset Table entries). */
function ovBigBytes(values: readonly bigint[]): Uint8Array {
    const out = new Uint8Array(values.length * 8);
    const view = new DataView(out.buffer);
    values.forEach((value, i) => view.setBigUint64(i * 8, value, true));
    return out;
}

/** Encodes 64-bit values for an OV element (Extended Offset Table). */
function ovBytes(values: readonly number[]): Uint8Array {
    const out = new Uint8Array(values.length * 8);
    const view = new DataView(out.buffer);
    values.forEach((value, i) => view.setBigUint64(i * 8, BigInt(value), true));
    return out;
}

const frag = (label: string, length: number): Uint8Array => {
    const bytes = new Uint8Array(length);
    bytes.set(latin1(label).subarray(0, Math.min(label.length, length)), 0);
    bytes[length - 1] = 0x2a;
    return bytes;
};

interface ImageDescription {
    readonly rows: number;
    readonly columns: number;
    readonly bits: number;
    readonly frames: number;
    readonly samples?: number;
}

function imageDescription(spec: ImageDescription): Uint8Array[] {
    const u16 = (value: number): Uint8Array => Uint8Array.from([value & 0xff, (value >> 8) & 0xff]);
    return [
        explicitEl('00280002', 'US', u16(spec.samples ?? 1)),
        explicitEl('00280008', 'IS', evenPad(String(spec.frames))),
        explicitEl('00280010', 'US', u16(spec.rows)),
        explicitEl('00280011', 'US', u16(spec.columns)),
        explicitEl('00280100', 'US', u16(spec.bits)),
    ];
}

/** Slices each frame range out of the file and returns the codec-ready payloads. */
function payloads(bytes: Uint8Array, frames: readonly FrameRange[]): Uint8Array[] {
    return frames.map(frame => framePayload(bytes.subarray(frame.offset, frame.offset + frame.length)));
}

function expectResolved(index: FrameIndex): Extract<FrameIndex, { frames: readonly FrameRange[] }> {
    expect(index.kind, 'reason' in index ? index.reason : '').not.toBe('unavailable');
    if (index.kind === 'unavailable') {
        throw new Error(index.reason);
    }
    return index;
}

describe('readFrameIndexAsync — encapsulated frames', () => {
    const fragments = [frag('one', 16), frag('two', 24), frag('three', 8)];
    // BOT entries are relative to the first fragment item tag
    const botEntries = [0, 8 + 16, 8 + 16 + 8 + 24];

    it('resolves frames from the basic offset table and yields exactly the parsed fragment bytes', () => {
        const file = p10(TS.jpegBaseline, [...imageDescription({ rows: 4, columns: 4, bits: 8, frames: 3 }), encapsulated(botEntries, fragments)]);
        return readFrameIndexAsync(memReader(file)).then(index => {
            const resolved = expectResolved(index);
            expect(resolved.kind).toBe('encapsulated');
            expect(resolved.frameSource).toBe('basic-offset-table');
            expect(resolved.frames).toHaveLength(3);
            // differential: the same bytes an in-memory parse reports per fragment
            const element = parse(file).dataSet.element('x7fe00010') as EncapsulatedElement;
            expect(resolved.frames.map(f => f.offset + 8)).toEqual(element.fragments.map(f => f.position));
            expect(payloads(file, resolved.frames).map(p => [...p])).toEqual(fragments.map(f => [...f]));
        });
    });

    it('prefers the Extended Offset Table (7FE0,0001)/(7FE0,0002) over an empty BOT', async () => {
        const eotOffsets = ovBytes(botEntries);
        const eotLengths = ovBytes(fragments.map(f => f.length));
        const file = p10(TS.jpegBaseline, [
            explicitEl('7FE00001', 'OV', eotOffsets),
            explicitEl('7FE00002', 'OV', eotLengths),
            ...imageDescription({ rows: 4, columns: 4, bits: 8, frames: 3 }),
            encapsulated([], fragments),
        ]);
        const resolved = expectResolved(await readFrameIndexAsync(memReader(file)));
        expect(resolved.frameSource).toBe('extended-offset-table');
        expect(payloads(file, resolved.frames).map(p => [...p])).toEqual(fragments.map(f => [...f]));
    });

    it('falls back to the BOT when the EOT has no matching lengths', async () => {
        const file = p10(TS.jpegBaseline, [
            explicitEl('7FE00001', 'OV', ovBytes(botEntries)),
            ...imageDescription({ rows: 4, columns: 4, bits: 8, frames: 3 }),
            encapsulated(botEntries, fragments),
        ]);
        const resolved = expectResolved(await readFrameIndexAsync(memReader(file)));
        expect(resolved.frameSource).toBe('basic-offset-table');
        expect(resolved.warnings.map(w => w.code)).toContain('length-adjusted');
    });

    it('ignores an out-of-range EOT rather than reporting bytes outside the value', async () => {
        const file = p10(TS.jpegBaseline, [
            explicitEl('7FE00001', 'OV', ovBytes([0, 999999])),
            explicitEl('7FE00002', 'OV', ovBytes([16, 24])),
            ...imageDescription({ rows: 4, columns: 4, bits: 8, frames: 3 }),
            encapsulated(botEntries, fragments),
        ]);
        const resolved = expectResolved(await readFrameIndexAsync(memReader(file)));
        expect(resolved.frameSource).toBe('basic-offset-table');
    });

    it('reads an Extended Offset Table that was kept in the dataset (implicit VR, no lookup)', async () => {
        const file = p10(TS.implicitLE, [
            implicitEl('7FE00001', ovBytes(botEntries)),
            implicitEl('7FE00002', ovBytes(fragments.map(f => f.length))),
            implicitEl('00280008', evenPad('3')),
            encapsulated([], fragments, true),
        ]);
        const resolved = expectResolved(await readFrameIndexAsync(memReader(file)));
        expect(resolved.frameSource).toBe('extended-offset-table');
        expect(payloads(file, resolved.frames).map(p => [...p])).toEqual(fragments.map(f => [...f]));
    });

    it('ignores Extended Offset Table entries beyond the safe integer range', async () => {
        const file = p10(TS.jpegBaseline, [
            explicitEl('7FE00001', 'OV', ovBigBytes([0n, 0xffffffffffffffffn])),
            explicitEl('7FE00002', 'OV', ovBytes([16, 24])),
            ...imageDescription({ rows: 4, columns: 4, bits: 8, frames: 3 }),
            encapsulated(botEntries, fragments),
        ]);
        const resolved = expectResolved(await readFrameIndexAsync(memReader(file)));
        expect(resolved.frameSource).toBe('basic-offset-table');
    });

    it('ignores a basic offset table whose entries fall outside the fragment stream', async () => {
        const file = p10(TS.jpegBaseline, [...imageDescription({ rows: 4, columns: 4, bits: 8, frames: 3 }), encapsulated([0, 999999, 1000000], fragments)]);
        const resolved = expectResolved(await readFrameIndexAsync(memReader(file)));
        expect(resolved.frameSource).toBe('fragment-walk');
        expect(resolved.warnings.map(w => w.code)).toContain('length-adjusted');
    });

    it('treats an empty BOT with one frame as a single span covering every fragment', async () => {
        const file = p10(TS.jpegBaseline, [...imageDescription({ rows: 4, columns: 4, bits: 8, frames: 1 }), encapsulated([], [frag('a', 16), frag('b', 8)])]);
        const resolved = expectResolved(await readFrameIndexAsync(memReader(file)));
        expect(resolved.frameSource).toBe('single-frame');
        expect(resolved.frames).toHaveLength(1);
        expect(frameFragments(file.subarray(resolved.frames[0]!.offset, resolved.frames[0]!.offset + resolved.frames[0]!.length))).toHaveLength(2);
    });

    it('walks fragment headers when an empty BOT maps 1:1 onto the frames', async () => {
        const file = p10(TS.jpegBaseline, [...imageDescription({ rows: 4, columns: 4, bits: 8, frames: 3 }), encapsulated([], fragments)]);
        const resolved = expectResolved(await readFrameIndexAsync(memReader(file)));
        expect(resolved.frameSource).toBe('fragment-walk');
        expect(payloads(file, resolved.frames).map(p => [...p])).toEqual(fragments.map(f => [...f]));
    });

    it('reports unavailable — never a guess — when fragments do not map onto frames', async () => {
        const file = p10(TS.jpegBaseline, [...imageDescription({ rows: 4, columns: 4, bits: 8, frames: 3 }), encapsulated([], [frag('a', 16), frag('b', 8)])]);
        const index = await readFrameIndexAsync(memReader(file));
        expect(index.kind).toBe('unavailable');
        expect(index.kind === 'unavailable' && index.reason).toMatch(/do not map onto 3 frames/);
        expect(index.pixelData).toBeDefined();
    });

    it('honors allowFragmentWalk: false', async () => {
        const file = p10(TS.jpegBaseline, [...imageDescription({ rows: 4, columns: 4, bits: 8, frames: 3 }), encapsulated([], fragments)]);
        const index = await readFrameIndexAsync(memReader(file), { allowFragmentWalk: false });
        expect(index.kind).toBe('unavailable');
        expect(index.kind === 'unavailable' && index.reason).toMatch(/allowFragmentWalk/);
    });

    it('groups multiple fragments per frame from the BOT', async () => {
        const parts = [frag('a1', 16), frag('a2', 8), frag('b1', 12)];
        const entries = [0, 8 + 16 + 8 + 8];
        const file = p10(TS.jpegBaseline, [...imageDescription({ rows: 4, columns: 4, bits: 8, frames: 2 }), encapsulated(entries, parts)]);
        const resolved = expectResolved(await readFrameIndexAsync(memReader(file)));
        expect(resolved.frames).toHaveLength(2);
        const first = file.subarray(resolved.frames[0]!.offset, resolved.frames[0]!.offset + resolved.frames[0]!.length);
        expect(frameFragments(first)).toHaveLength(2);
        expect([...framePayload(first)]).toEqual([...parts[0]!, ...parts[1]!]);
    });
});

describe('readFrameIndexAsync — native frames', () => {
    it('computes contiguous equal-sized frames', async () => {
        const pixels = new Uint8Array(2 * 2 * 3);
        pixels.forEach((_, i) => (pixels[i] = i));
        const file = p10(TS.explicitLE, [...imageDescription({ rows: 2, columns: 2, bits: 8, frames: 3 }), explicitEl('7FE00010', 'OW', pixels)]);
        const resolved = expectResolved(await readFrameIndexAsync(memReader(file)));
        expect(resolved.kind).toBe('native');
        expect(resolved.frameSource).toBe('computed');
        expect(resolved.frames.map(f => f.length)).toEqual([4, 4, 4]);
        expect(resolved.frames.map(f => f.offset - resolved.pixelData.offset)).toEqual([0, 4, 8]);
        expect([...file.subarray(resolved.frames[1]!.offset, resolved.frames[1]!.offset + 4)]).toEqual([4, 5, 6, 7]);
    });

    it('accounts for SamplesPerPixel and BitsAllocated 16', async () => {
        const file = p10(TS.explicitLE, [
            ...imageDescription({ rows: 2, columns: 2, bits: 16, frames: 2, samples: 3 }),
            explicitEl('7FE00010', 'OW', new Uint8Array(2 * 2 * 3 * 2 * 2)),
        ]);
        const resolved = expectResolved(await readFrameIndexAsync(memReader(file)));
        expect(resolved.frames.map(f => f.length)).toEqual([24, 24]);
    });

    it('warns and reports only whole frames when the value is shorter than declared', async () => {
        const file = p10(TS.explicitLE, [...imageDescription({ rows: 2, columns: 2, bits: 8, frames: 4 }), explicitEl('7FE00010', 'OW', new Uint8Array(10))]);
        const resolved = expectResolved(await readFrameIndexAsync(memReader(file)));
        expect(resolved.frames).toHaveLength(2);
        expect(resolved.warnings.map(w => w.code)).toContain('length-adjusted');
    });

    it('reports unavailable for bit-packed frames that are not byte-aligned', async () => {
        const file = p10(TS.explicitLE, [...imageDescription({ rows: 3, columns: 3, bits: 1, frames: 2 }), explicitEl('7FE00010', 'OW', new Uint8Array(4))]);
        const index = await readFrameIndexAsync(memReader(file));
        expect(index.kind).toBe('unavailable');
        expect(index.kind === 'unavailable' && index.reason).toMatch(/bit-packed/);
    });

    it('reports unavailable when the image-pixel description is missing', async () => {
        const file = p10(TS.explicitLE, [explicitEl('7FE00010', 'OW', new Uint8Array(8))]);
        const index = await readFrameIndexAsync(memReader(file));
        expect(index.kind).toBe('unavailable');
        expect(index.kind === 'unavailable' && index.reason).toMatch(/Rows/);
    });

    it('defaults to one frame when NumberOfFrames is absent', async () => {
        const file = p10(TS.explicitLE, [
            explicitEl('00280010', 'US', Uint8Array.from([2, 0])),
            explicitEl('00280011', 'US', Uint8Array.from([2, 0])),
            explicitEl('00280100', 'US', Uint8Array.from([8, 0])),
            explicitEl('7FE00010', 'OW', new Uint8Array(4)),
        ]);
        const resolved = expectResolved(await readFrameIndexAsync(memReader(file)));
        expect(resolved.frames).toEqual([{ offset: resolved.pixelData.offset, length: 4 }]);
    });
});

describe('readFrameIndexAsync — IO, reuse and unavailability', () => {
    it('reads far less than the file: never the pixel payload', async () => {
        const fragments = [frag('a', 200_000), frag('b', 200_000)];
        const file = p10(TS.jpegBaseline, [...imageDescription({ rows: 400, columns: 500, bits: 8, frames: 2 }), encapsulated([0, 8 + 200_000], fragments)]);
        const reader = memReader(file);
        const resolved = expectResolved(await readFrameIndexAsync(reader));
        expect(resolved.frames).toHaveLength(2);
        expect(resolved.bytesRead).toBeLessThan(file.length / 10);
        expect(reader.totalRead).toBeLessThan(file.length / 10);
    });

    it('reuses a supplied head read instead of walking again', async () => {
        const file = p10(TS.jpegBaseline, [...imageDescription({ rows: 4, columns: 4, bits: 8, frames: 1 }), encapsulated([0], [frag('a', 32)])]);
        const reader = memReader(file);
        const head = await parseHeadAsync(reader);
        const before = reader.totalRead;
        const resolved = expectResolved(await readFrameIndexAsync(reader, { head }));
        expect(resolved.head).toBe(head);
        expect(reader.totalRead - before).toBeLessThan(200); // tables only, no second walk
    });

    it('reports unavailable for deflated objects (offsets would be inflated coordinates)', async () => {
        const file = p10Deflated([...imageDescription({ rows: 2, columns: 2, bits: 8, frames: 1 }), explicitEl('7FE00010', 'OW', new Uint8Array(4))]);
        const index = await readFrameIndexAsync(memReader(file));
        expect(index.kind).toBe('unavailable');
        expect(index.kind === 'unavailable' && index.reason).toMatch(/deflated|no pixel data/);
    });

    it('reports unavailable when the object has no pixel data', async () => {
        const file = p10(TS.explicitLE, [explicitEl('00080060', 'CS', evenPad('CT'))]);
        const index = await readFrameIndexAsync(memReader(file));
        expect(index.kind).toBe('unavailable');
        expect(index.kind === 'unavailable' && index.reason).toMatch(/no pixel data/);
        expect(index.pixelData).toBeUndefined();
    });
});

describe('frameFragments / framePayload', () => {
    it('rejects bytes that are not a fragment-item stream', () => {
        expect(() => frameFragments(latin1('not an item at all!!'))).toThrow(/fragment item/);
        const overrun = concat([tagBytes('FFFEE000'), uint32Bytes(64, false), latin1('short')]);
        expect(() => frameFragments(overrun)).toThrow(/overruns/);
    });

    it('returns a zero-copy view for a single fragment and a copy for several', () => {
        const single = concat([tagBytes('FFFEE000'), uint32Bytes(4, false), latin1('abcd')]);
        expect(framePayload(single).buffer).toBe(single.buffer);
        const many = concat([single, tagBytes('FFFEE000'), uint32Bytes(2, false), latin1('ef')]);
        expect([...framePayload(many)]).toEqual([...latin1('abcdef')]);
        expect(framePayload(many).buffer).not.toBe(many.buffer);
    });
});

describe('readFrameIndexAsync — real fixtures', () => {
    const images = collectTestImages();
    it.runIf(images.length > 0)('locates the same frame bytes a whole-file parse does', async () => {
        let checked = 0;
        for (const path of images) {
            const bytes = new Uint8Array(readFileSync(path));
            const full = parse(bytes);
            const element = full.dataSet.element('x7fe00010');
            if (!full.ok || element?.kind !== 'encapsulated' || element.fragments.length === 0) {
                continue;
            }
            const index = await readFrameIndexAsync(memReader(bytes));
            if (index.kind === 'unavailable') {
                continue; // indeterminate boundaries are reported, never guessed
            }
            checked++;
            const fetched = payloads(bytes, index.frames);
            // every frame's payload must be a run of the parsed fragment bytes
            const parsedTotal = element.fragments.reduce((sum, f) => sum + f.length, 0);
            expect(
                fetched.reduce((sum, part) => sum + part.length, 0),
                path
            ).toBeLessThanOrEqual(parsedTotal);
            const firstFragment = element.fragments[0]!;
            expect([...(fetched[0] as Uint8Array).subarray(0, 8)], path).toEqual([...bytes.subarray(firstFragment.position, firstFragment.position + 8)]);
        }
        expect(checked).toBeGreaterThan(0);
    });
});
