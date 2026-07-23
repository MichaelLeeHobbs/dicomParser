import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../src/parse';
import { DEFAULT_MAX_INFLATED_BYTES } from '../src/inflate';
import { TS, concat, encapsulatedPixelData, explicitEl, implicitEl, latin1, metaGroup, p10, p10Deflated, sqExplicit, sqExplicitUndefined } from './helpers/p10';

// Fuzz posture (PLAN.md backlog item 12, upstream #282): the parser must never
// throw, hang, or crash on malformed input — failures must surface as the
// typed error in the result. Targets the attack surface called out in
// SECURITY.md: length fields, offsets, delimiters, truncation, deflate.

/** parse() must return (never throw) and be reasonably fast for small inputs. */
function assertTotal(bytes: Uint8Array): void {
    const result = parse(bytes);
    expect(result.warnings).toBeDefined();
    expect(result.dataSet).toBeDefined();
}

const SMALL_BYTES = fc.uint8Array({ minLength: 0, maxLength: 2048 });

describe('fuzz: arbitrary bytes', () => {
    it('parse() is total on random input', () => {
        fc.assert(
            fc.property(SMALL_BYTES, bytes => {
                assertTotal(bytes);
            }),
            { numRuns: 300 }
        );
    });

    it('parse() is total on random input claiming to be a raw dataset', () => {
        fc.assert(
            fc.property(SMALL_BYTES, fc.constantFrom('1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2'), (bytes, transferSyntax) => {
                const result = parse(bytes, { transferSyntax });
                expect(result.dataSet).toBeDefined();
            }),
            { numRuns: 300 }
        );
    });
});

/** A well-formed synthetic file exercising sequences and encapsulation. */
function structuredFile(): Uint8Array {
    return p10(TS.jpegBaseline, [
        explicitEl('00080005', 'CS', latin1('ISO_IR 100')),
        explicitEl('00080018', 'UI', latin1('1.2.3.4\0')),
        sqExplicit('00081140', [concat([explicitEl('00080100', 'SH', latin1('AB'))])]),
        sqExplicitUndefined('00082218', [
            concat([Uint8Array.from([0xfe, 0xff, 0x00, 0xe0, 0x0a, 0x00, 0x00, 0x00]), explicitEl('00080100', 'SH', latin1('CD'))]),
        ]),
        encapsulatedPixelData([Uint8Array.from([1, 2, 3, 4]), Uint8Array.from([5, 6, 7, 8])], [0]),
    ]);
}

describe('fuzz: corpus mutation', () => {
    const base = structuredFile();

    it('single-byte mutations never crash the parser', () => {
        fc.assert(
            fc.property(fc.nat(base.length - 1), fc.integer({ min: 0, max: 255 }), (offset, value) => {
                const mutated = Uint8Array.from(base);
                mutated[offset] = value;
                assertTotal(mutated);
            }),
            { numRuns: 500 }
        );
    });

    it('multi-byte length-field-style mutations never crash the parser', () => {
        fc.assert(
            fc.property(fc.nat(Math.max(0, base.length - 4)), fc.constantFrom(0xffffffff, 0xfffffffe, 0x7fffffff, 0x80000000, 0), (offset, value) => {
                const mutated = Uint8Array.from(base);
                new DataView(mutated.buffer).setUint32(offset, value, true);
                assertTotal(mutated);
            }),
            { numRuns: 500 }
        );
    });

    it('truncation at every prefix length never crashes the parser', () => {
        // exhaustive over the synthetic file — every truncation point
        for (let end = 0; end <= base.length; end++) {
            assertTotal(base.subarray(0, end));
        }
    });

    it('mutated real-file slices never crash the parser', () => {
        const real = new Uint8Array(readFileSync(join(__dirname, '..', 'testImages', 'deflate', 'report_dfl')));
        fc.assert(
            fc.property(fc.nat(real.length - 1), fc.integer({ min: 0, max: 255 }), fc.nat(real.length), (offset, value, end) => {
                const mutated = Uint8Array.from(real);
                mutated[offset] = value;
                assertTotal(mutated.subarray(0, end));
            }),
            { numRuns: 150 }
        );
    });
});

describe('fuzz: hostile deflate', () => {
    it('rejects deflate bombs at the configured cap without allocating the output', () => {
        // a single 32 MiB element deflates to ~32 KiB; cap at 1 MiB
        const dataset = explicitEl('7FE00010', 'OB', new Uint8Array(32 * 1024 * 1024));
        const deflated = new Uint8Array(deflateRawSync(dataset));
        const file = concat([new Uint8Array(128), latin1('DICM'), metaGroup(TS.deflatedLE), deflated]);
        const result = parse(file, { maxInflatedBytes: 1024 * 1024 });
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe('malformed');
        expect(result.error?.message).toMatch(/maxInflatedBytes|inflate failed/);
        // and a cap above the payload size still parses it (the option is the gate)
        const allowed = parse(file, { maxInflatedBytes: 64 * 1024 * 1024 });
        expect(allowed.ok).toBe(true);
        expect(allowed.dataSet.element('x7fe00010')?.length).toBe(32 * 1024 * 1024);
    });

    it('random deflated payloads never crash the parser', () => {
        const header = p10Deflated([]);
        fc.assert(
            fc.property(fc.uint8Array({ minLength: 0, maxLength: 512 }), garbage => {
                assertTotal(concat([header, garbage]));
            }),
            { numRuns: 200 }
        );
    });
});

describe('fuzz: random element streams', () => {
    const vrArb = fc.constantFrom('OB', 'OW', 'SQ', 'UN', 'SH', 'US', 'UL', 'UT', 'SV', 'UV', 'ZZ');
    const tagArb = fc.tuple(fc.integer({ min: 1, max: 0xffff }), fc.integer({ min: 0, max: 0xffff }));
    const elementArb = fc.tuple(tagArb, vrArb, fc.uint8Array({ minLength: 0, maxLength: 64 })).map(([[group, element], vr, value]) => {
        const tag = `${group.toString(16).padStart(4, '0')}${element.toString(16).padStart(4, '0')}`;
        const even = value.length % 2 === 0 ? value : value.subarray(0, value.length - 1);
        return explicitEl(tag.toUpperCase(), vr, even);
    });

    it('files of random elements never crash the parser', () => {
        fc.assert(
            fc.property(fc.array(elementArb, { minLength: 0, maxLength: 12 }), elements => {
                assertTotal(p10(TS.explicitLE, elements));
            }),
            { numRuns: 250 }
        );
    });

    it('random implicit datasets never crash the parser', () => {
        fc.assert(
            fc.property(fc.array(fc.tuple(tagArb, fc.uint8Array({ minLength: 0, maxLength: 32 })), { minLength: 0, maxLength: 12 }), specs => {
                const elements = specs.map(([[group, element], value]) => {
                    const tag = `${group.toString(16).padStart(4, '0')}${element.toString(16).padStart(4, '0')}`;
                    return implicitEl(tag.toUpperCase(), value.length % 2 === 0 ? value : value.subarray(1));
                });
                assertTotal(p10(TS.implicitLE, elements));
            }),
            { numRuns: 250 }
        );
    });
});

describe('resource limits (adversarial review S1/S2/S3)', () => {
    const u32 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];

    function emptyItemBomb(count: number): Uint8Array {
        const parts: number[] = [0x09, 0x00, 0x01, 0x00, ...u32(0xffffffff)];
        for (let i = 0; i < count; i++) {
            parts.push(0xfe, 0xff, 0x00, 0xe0, 0, 0, 0, 0);
        }
        parts.push(0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0);
        return Uint8Array.from(parts);
    }

    it('caps structural amplification with a typed error and partial results, never OOM', () => {
        const result = parse(emptyItemBomb(200_000), { transferSyntax: '1.2.840.10008.1.2', maxElements: 1000 });
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe('limit-exceeded');
        // partial results survive the limit
        expect(result.dataSet).toBeDefined();
    });

    it('salvage after a limit hit does not re-throw (invariant: parse never throws)', () => {
        // a bomb inside a sequence that is itself on the stack when the limit trips
        expect(() => parse(emptyItemBomb(50_000), { transferSyntax: '1.2.840.10008.1.2', maxElements: 100 })).not.toThrow();
    });

    it('a modest real-shaped file parses well under the default cap', () => {
        const result = parse(emptyItemBomb(1000), { transferSyntax: '1.2.840.10008.1.2' });
        expect(result.ok).toBe(true);
    });

    it('the default inflated-size cap is a sane 256 MiB, not a multi-GB peak', () => {
        expect(DEFAULT_MAX_INFLATED_BYTES).toBe(256 * 1024 * 1024);
    });

    it('a deflated file parses under a large but valid cap (the splice guard is a latent-overflow backstop)', () => {
        // the S3 guard only fires on an actual >2 GiB allocation, which we cannot
        // materialize in a test; assert the happy path with a large valid cap
        const small = p10Deflated([explicitEl('00080060', 'CS', latin1('CT'))]);
        const result = parse(small, { maxInflatedBytes: 512 * 1024 * 1024 });
        expect(result.ok).toBe(true);
    });
});
