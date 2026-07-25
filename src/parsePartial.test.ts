import { describe, expect, it } from 'vitest';
import { parse, parsePartial, parsePartialAsync, TS_GE_PRIVATE_DLX } from './parse';
import type { ParseOptions, ParseResult, PartialParseResult } from './parse';
import {
    TS,
    concat,
    encapsulatedPixelData,
    evenPad,
    explicitEl,
    implicitEl,
    latin1,
    metaGroup,
    p10,
    p10Deflated,
    sqExplicit,
    sqExplicitUndefined,
    tagBytes,
    undefinedLengthItem,
} from '../tests/helpers/p10';

// Differential suite for issue #34: parsePartial classifies a byte prefix as
// complete | needMoreBytes | malformed, with sized truncation hints, while the
// tolerant parse() behavior stays byte-for-byte unchanged.

const META_LEN = metaGroup(TS.explicitLE).length;
const DATASET_START = 132 + META_LEN;

/** An undefined-length OB value at a non-PixelData tag (scanUnknown path). */
function undefinedLengthOb(tag: string, content: Uint8Array): Uint8Array {
    return concat([
        tagBytes(tag),
        latin1('OB'),
        new Uint8Array(2),
        Uint8Array.from([0xff, 0xff, 0xff, 0xff]),
        content,
        tagBytes('FFFEE00D'),
        new Uint8Array(4),
    ]);
}

const COMPLEX_FILE = p10(TS.explicitLE, [
    explicitEl('00080018', 'UI', evenPad('1.2.840.10008.5.1.4.1.1.7.99', '\0')),
    sqExplicit('00081110', [concat([explicitEl('00081150', 'UI', evenPad('1.2.840.10008.5.1.4.1.1.7', '\0'))])]),
    sqExplicitUndefined('00082218', [undefinedLengthItem(explicitEl('00080100', 'SH', evenPad('AB')))]),
    undefinedLengthOb('00420011', latin1('binary-content')),
    explicitEl('00280010', 'US', Uint8Array.from([0x00, 0x02])),
]);

const ENCAP_FILE = p10(TS.jpegBaseline, [
    explicitEl('00080018', 'UI', evenPad('1.2.3.4', '\0')),
    encapsulatedPixelData([latin1('frag-one-payload'), latin1('frag-two')], [0, 24]),
]);

const IMPLICIT_FILE = p10(TS.implicitLE, [implicitEl('00080018', evenPad('1.2.3.4.5', '\0')), implicitEl('7fe00010', latin1('pixel-bytes-here'))]);

function needMore(outcome: PartialParseResult): { offset: number; totalNeeded: number } {
    expect(outcome.outcome).toBe('needMoreBytes');
    if (outcome.outcome !== 'needMoreBytes') {
        throw new Error('unreachable');
    }
    return outcome.truncation;
}

/**
 * Simulates the incremental-ingest loop the outcome is designed for: on every
 * needMoreBytes, extend the prefix to exactly totalNeeded (asserting monotonic
 * progress); on a `complete` that is only a boundary-consistent prefix, feed
 * one more byte, as a real transport with bytes left would. Must converge to
 * `complete` at exactly the full file.
 */
function resumeLoop(file: Uint8Array, options: ParseOptions = {}): ParseResult {
    let len = 0;
    for (let guard = 0; guard <= 2 * file.length + 16; guard++) {
        const outcome = parsePartial(file.subarray(0, len), options);
        expect(outcome.outcome, `prefix length ${len}`).not.toBe('malformed');
        if (outcome.outcome === 'needMoreBytes') {
            expect(outcome.truncation.totalNeeded).toBeGreaterThan(len);
            expect(outcome.truncation.totalNeeded).toBeLessThanOrEqual(file.length);
            len = outcome.truncation.totalNeeded;
            continue;
        }
        if (len >= file.length) {
            return (outcome as { result: ParseResult }).result;
        }
        len += 1;
    }
    throw new Error('resume loop did not converge');
}

function expectMatchesTolerantParse(result: ParseResult, file: Uint8Array): void {
    const full = parse(file);
    expect(result.ok).toBe(full.ok);
    expect(result.transferSyntax).toBe(full.transferSyntax);
    expect([...result.dataSet.elements.keys()]).toEqual([...full.dataSet.elements.keys()]);
    expect(result.warnings.map(w => w.code)).toEqual(full.warnings.map(w => w.code));
}

describe('parsePartial — resume loop over valid files', () => {
    it.each([
        ['explicit LE with sequences and undefined-length OB', COMPLEX_FILE],
        ['encapsulated pixel data', ENCAP_FILE],
        ['implicit LE', IMPLICIT_FILE],
    ])('converges to complete on %s', (_name, file) => {
        const result = resumeLoop(file);
        expectMatchesTolerantParse(result, file);
    });

    it.each([
        ['explicit LE with sequences and undefined-length OB', COMPLEX_FILE],
        ['encapsulated pixel data', ENCAP_FILE],
        ['implicit LE', IMPLICIT_FILE],
    ])('never reports malformed for any prefix of %s', (_name, file) => {
        for (let len = 0; len <= file.length; len++) {
            const outcome = parsePartial(file.subarray(0, len));
            expect(outcome.outcome, `prefix length ${len}`).not.toBe('malformed');
        }
        expect(parsePartial(file).outcome).toBe('complete');
    });
});

describe('parsePartial — the truncation/corruption split (#34)', () => {
    const uid = '1.2.840.10008.5.1.4.1.1.7.999';
    const valueFile = p10(TS.explicitLE, [explicitEl('00080018', 'UI', evenPad(uid, '\0'))]);

    it('resolves the clamp asymmetry: a truncated defined-length value is needMoreBytes, not ok-with-warning', () => {
        const prefix = valueFile.subarray(0, valueFile.length - 4);
        // tolerant parse: clamps and reports ok with only a warning
        const tolerant = parse(prefix);
        expect(tolerant.ok).toBe(true);
        expect(tolerant.warnings.some(w => w.code === 'unexpected-eof')).toBe(true);
        // partial parse: definite truncation with an exactly-sized hint
        const truncation = needMore(parsePartial(prefix));
        expect(truncation.offset).toBe(DATASET_START);
        expect(truncation.totalNeeded).toBe(valueFile.length);
    });

    it('classifies a truncated element header as needMoreBytes (tolerant parse fails here)', () => {
        const prefix = valueFile.subarray(0, DATASET_START + 6);
        expect(parse(prefix).ok).toBe(false);
        const truncation = needMore(parsePartial(prefix));
        expect(truncation.totalNeeded).toBeGreaterThan(prefix.length);
    });

    it('keeps interior corruption malformed: garbage inside an undefined-length sequence', () => {
        const garbageItems = [latin1('this is not an item tag!')];
        const file = p10(TS.explicitLE, [sqExplicitUndefined('00081110', garbageItems), explicitEl('00280010', 'US', Uint8Array.from([0x00, 0x02]))]);
        const outcome = parsePartial(file);
        expect(outcome.outcome).toBe('malformed');
        expect(outcome.result.error?.code).toBe('malformed');
        // truncating the file does not change the verdict — the corruption sits
        // before the cut, so more bytes cannot help
        expect(parsePartial(file.subarray(0, file.length - 10)).outcome).toBe('malformed');
    });

    it('keeps speculative-fallback recovery identical to parse: item overrunning its defined sequence stays complete', () => {
        // a defined-length SQ whose item declares past the sequence end, with a
        // trailing element after — parse rolls the SQ back to an opaque value
        const innerItem = concat([tagBytes('FFFEE000'), Uint8Array.from([0xf0, 0x00, 0x00, 0x00])]);
        const badSq = concat([tagBytes('00081110'), latin1('SQ'), new Uint8Array(2), Uint8Array.from([0x08, 0x00, 0x00, 0x00]), innerItem]);
        const file = p10(TS.explicitLE, [badSq, explicitEl('00280010', 'US', Uint8Array.from([0x00, 0x02]))]);
        expect(parse(file).ok).toBe(true);
        const outcome = parsePartial(file);
        expect(outcome.outcome).toBe('complete');
        expect(outcome.result.warnings.some(w => w.code === 'sequence-fallback')).toBe(true);
    });

    it('does not let a speculative sequence fallback swallow truncation at end of input', () => {
        // A defined-length SQ ending exactly at EOF whose child element declares
        // past the end: without the truncated-is-terminal guard the CP-246
        // speculative fallback would keep the SQ as an opaque value and report
        // the prefix complete.
        const childHeader = concat([tagBytes('00081150'), latin1('UI'), Uint8Array.from([0x40, 0x00]), latin1('1.2.')]);
        const itemBytes = concat([tagBytes('FFFEE000'), Uint8Array.from([childHeader.length & 0xff, 0x00, 0x00, 0x00]), childHeader]);
        const sq = concat([tagBytes('00081110'), latin1('SQ'), new Uint8Array(2), Uint8Array.from([itemBytes.length & 0xff, 0x00, 0x00, 0x00]), itemBytes]);
        const file = p10(TS.explicitLE, [sq]);
        expect(parse(file).ok).toBe(true); // tolerant: fallback keeps it opaque-ish
        const truncation = needMore(parsePartial(file));
        expect(truncation.totalNeeded).toBeGreaterThan(file.length);
    });

    it('does not let a speculative sequence fallback swallow a truncated header at end of input (review)', () => {
        // Same swallow shape, but the child dies on a header overread
        // (buffer-overread + totalNeeded) instead of a truncated value — the
        // fallback must treat that as terminal under strict EOF too.
        const partialChildHeader = concat([tagBytes('00081150'), latin1('UI')]); // 6 of ≥8 header bytes
        const itemBytes = concat([tagBytes('FFFEE000'), Uint8Array.from([partialChildHeader.length & 0xff, 0x00, 0x00, 0x00]), partialChildHeader]);
        const sq = concat([tagBytes('00081110'), latin1('SQ'), new Uint8Array(2), Uint8Array.from([itemBytes.length & 0xff, 0x00, 0x00, 0x00]), itemBytes]);
        const file = p10(TS.explicitLE, [sq]);
        expect(parse(file).ok).toBe(true); // tolerant: fallback keeps it opaque
        const truncation = needMore(parsePartial(file));
        expect(truncation.totalNeeded).toBeGreaterThan(file.length);
    });

    it('classifies resource-bound failures as malformed', () => {
        const outcome = parsePartial(COMPLEX_FILE, { maxElements: 2 });
        expect(outcome.outcome).toBe('malformed');
        expect(outcome.result.error?.code).toBe('limit-exceeded');
    });

    it('classifies an unsupported transfer syntax as malformed', () => {
        const outcome = parsePartial(p10(TS_GE_PRIVATE_DLX, [implicitEl('00080018', evenPad('1.2', '\0'))]));
        expect(outcome.outcome).toBe('malformed');
        expect(outcome.result.error?.code).toBe('unsupported');
    });
});

describe('parsePartial — preamble and meta group', () => {
    it('asks for the 132-byte prefix before judging short non-DICM input', () => {
        const truncation = needMore(parsePartial(latin1('x'.repeat(50))));
        expect(truncation.totalNeeded).toBe(132);
        expect(parsePartial(new Uint8Array(0)).outcome).toBe('needMoreBytes');
    });

    it('judges full-length non-DICM input malformed', () => {
        const outcome = parsePartial(latin1('x'.repeat(200)));
        expect(outcome.outcome).toBe('malformed');
        expect(outcome.result.error?.code).toBe('not-dicom');
    });

    it('classifies a cut inside a meta value as needMoreBytes (tolerant parse calls it malformed)', () => {
        const prefix = COMPLEX_FILE.subarray(0, DATASET_START - 3);
        expect(parse(prefix).error?.code).toBe('malformed');
        const truncation = needMore(parsePartial(prefix));
        expect(truncation.totalNeeded).toBeGreaterThan(prefix.length);
    });

    it('treats a prefix ending exactly at the meta/dataset boundary as needMoreBytes', () => {
        const prefix = COMPLEX_FILE.subarray(0, DATASET_START);
        const truncation = needMore(parsePartial(prefix));
        expect(truncation.offset).toBe(DATASET_START);
        expect(truncation.totalNeeded).toBe(DATASET_START + 8);
    });
});

describe('parsePartial — composition and modes', () => {
    it('composes with stopAt: everything before PixelData present means complete', () => {
        const pixelStart = DATASET_START + explicitEl('00080018', 'UI', evenPad('1.2.3.4', '\0')).length;
        const file = p10(TS.explicitLE, [explicitEl('00080018', 'UI', evenPad('1.2.3.4', '\0')), explicitEl('7FE00010', 'OW', new Uint8Array(64))]);
        const options: ParseOptions = { stopAt: { tag: 0x7fe00010 } };
        // cut mid pixel VALUE, full header present: the stop resolves first
        const midValue = parsePartial(file.subarray(0, pixelStart + 20), options);
        expect(midValue.outcome).toBe('complete');
        expect(midValue.result.stoppedAt).toBe(0x7fe00010);
        // cut mid pixel HEADER: the stop cannot resolve yet
        expect(parsePartial(file.subarray(0, pixelStart + 6), options).outcome).toBe('needMoreBytes');
    });

    it('supports raw datasets via options.transferSyntax', () => {
        const raw = concat([implicitEl('00080018', evenPad('1.2.3', '\0')), implicitEl('00280010', Uint8Array.from([0x00, 0x02, 0x00, 0x00]))]);
        const options: ParseOptions = { transferSyntax: TS.implicitLE };
        expect(parsePartial(raw, options).outcome).toBe('complete');
        const truncation = needMore(parsePartial(raw.subarray(0, raw.length - 2), options));
        expect(truncation.totalNeeded).toBe(raw.length);
    });

    it('keeps the partial dataset available on the needMoreBytes arm', () => {
        const outcome = parsePartial(COMPLEX_FILE.subarray(0, COMPLEX_FILE.length - 6));
        expect(outcome.outcome).toBe('needMoreBytes');
        expect(outcome.result.dataSet.elements.has(0x00080018)).toBe(true);
        expect(outcome.result.meta.elements.size).toBeGreaterThan(0);
    });

    it('classifies deflated payload truncation as malformed (documented limitation)', () => {
        const file = p10Deflated([explicitEl('00080018', 'UI', evenPad('1.2.3.4.5.6.7.8.9', '\0'))]);
        expect(parsePartial(file).outcome).toBe('complete');
        const outcome = parsePartial(file.subarray(0, file.length - 5));
        expect(outcome.outcome).toBe('malformed');
        expect(outcome.result.error?.code).toBe('malformed');
    });

    it('parsePartialAsync matches the sync classification', async () => {
        expect((await parsePartialAsync(ENCAP_FILE)).outcome).toBe('complete');
        const cut = await parsePartialAsync(ENCAP_FILE.subarray(0, ENCAP_FILE.length - 6));
        expect(cut.outcome).toBe('needMoreBytes');
    });
});

describe('parsePartial — robustness', () => {
    it('never throws on randomly corrupted random prefixes', () => {
        let seed = 0x2f6e2b1;
        const rand = (): number => {
            // mulberry32 — deterministic so failures reproduce
            seed = (seed + 0x6d2b79f5) | 0;
            let t = seed;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        for (let round = 0; round < 300; round++) {
            const mutated = Uint8Array.from(round % 2 === 0 ? COMPLEX_FILE : ENCAP_FILE);
            const flips = 1 + Math.floor(rand() * 8);
            for (let i = 0; i < flips; i++) {
                mutated[Math.floor(rand() * mutated.length)] = Math.floor(rand() * 256);
            }
            const prefix = mutated.subarray(0, Math.floor(rand() * (mutated.length + 1)));
            const outcome = parsePartial(prefix);
            expect(['complete', 'needMoreBytes', 'malformed']).toContain(outcome.outcome);
            if (outcome.outcome === 'needMoreBytes') {
                expect(outcome.truncation.totalNeeded).toBeGreaterThan(prefix.length);
            }
        }
    });
});
