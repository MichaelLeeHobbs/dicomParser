import { describe, expect, it } from 'vitest';
import type { DicomElement } from './element';
import { parse, type ParseOptions, type ParseResult } from './parse';
import { PushParser, type PushStatus } from './pushParser';
import {
    TS,
    concat,
    encapsulatedPixelData,
    evenPad,
    explicitEl,
    implicitEl,
    latin1,
    p10,
    p10Deflated,
    sqExplicit,
    sqExplicitUndefined,
    undefinedLengthItem,
} from '../tests/helpers/p10';

// Differential suite for issue #33: the push parser's end() must equal a
// whole-buffer parse regardless of chunking, incremental signals must be
// consistent with stream order, and elements must emit exactly once.

const COMPLEX_FILE = p10(TS.explicitLE, [
    explicitEl('00080018', 'UI', evenPad('1.2.840.10008.5.1.4.1.1.7.99', '\0')),
    sqExplicit('00081110', [concat([explicitEl('00081150', 'UI', evenPad('1.2.840.10008.5.1.4.1.1.7', '\0'))])]),
    sqExplicitUndefined('00082218', [undefinedLengthItem(explicitEl('00080100', 'SH', evenPad('AB')))]),
    explicitEl('00280010', 'US', Uint8Array.from([0x00, 0x02])),
    explicitEl('7FE00010', 'OW', latin1('pixel-data-bytes')),
]);

const ENCAP_FILE = p10(TS.jpegBaseline, [
    explicitEl('00080018', 'UI', evenPad('1.2.3.4', '\0')),
    encapsulatedPixelData([latin1('frag-one-payload'), latin1('frag-two')], [0, 24]),
]);

const IMPLICIT_FILE = p10(TS.implicitLE, [implicitEl('00080018', evenPad('1.2.3.4.5', '\0')), implicitEl('7fe00010', latin1('pixel-bytes-here'))]);

const DEFLATED_FILE = p10Deflated([
    explicitEl('00080018', 'UI', evenPad('1.2.3.4.5.6.7.8.9', '\0')),
    explicitEl('00280010', 'US', Uint8Array.from([0x00, 0x02])),
]);

const RAW_FILE = concat([implicitEl('00080018', evenPad('1.2.3', '\0')), implicitEl('00280010', Uint8Array.from([0x00, 0x02, 0x00, 0x00]))]);

function feed(parser: PushParser, file: Uint8Array, chunkSizes: (index: number) => number): PushStatus {
    let status = parser.status;
    let at = 0;
    for (let i = 0; at < file.length; i++) {
        const size = Math.max(1, chunkSizes(i));
        status = parser.push(file.subarray(at, Math.min(file.length, at + size)));
        at += size;
    }
    return status;
}

function expectResultsEqual(actual: ParseResult, expected: ParseResult): void {
    expect(actual.ok).toBe(expected.ok);
    expect(actual.error?.code).toBe(expected.error?.code);
    expect(actual.transferSyntax).toBe(expected.transferSyntax);
    expect(actual.stoppedAt).toBe(expected.stoppedAt);
    expect(actual.warnings.map(w => w.code)).toEqual(expected.warnings.map(w => w.code));
    expect([...actual.dataSet.elements.keys()]).toEqual([...expected.dataSet.elements.keys()]);
    for (const [tag, element] of expected.dataSet.elements) {
        const got = actual.dataSet.elements.get(tag) as DicomElement;
        expect(got.kind).toBe(element.kind);
        expect(got.startOffset).toBe(element.startOffset);
        expect(got.dataOffset).toBe(element.dataOffset);
        expect(got.length).toBe(element.length);
        expect(got.endOffset).toBe(element.endOffset);
    }
    expect([...actual.meta.elements.keys()]).toEqual([...expected.meta.elements.keys()]);
}

describe('PushParser — chunk-invariance identity', () => {
    const files: [string, Uint8Array, ParseOptions][] = [
        ['explicit LE with sequences', COMPLEX_FILE, {}],
        ['encapsulated pixel data', ENCAP_FILE, {}],
        ['implicit LE', IMPLICIT_FILE, {}],
        ['deflated', DEFLATED_FILE, {}],
        ['raw dataset', RAW_FILE, { transferSyntax: TS.implicitLE }],
    ];
    const chunkings: [string, (i: number) => number][] = [
        ['whole-buffer', () => Number.MAX_SAFE_INTEGER],
        ['1-byte', () => 1],
        ['7-byte', () => 7],
        ['mixed', i => (i % 3 === 0 ? 1 : i % 3 === 1 ? 13 : 64)],
    ];
    for (const [fileName, file, options] of files) {
        for (const [chunkName, chunker] of chunkings) {
            it(`end() equals parse() for ${fileName} fed in ${chunkName} chunks`, () => {
                const parser = new PushParser(options);
                feed(parser, file, chunker);
                const result = parser.end();
                expectResultsEqual(result, parse(file, options));
                expect([...parser.bytes()]).toEqual([...file]);
            });
        }
    }
});

describe('PushParser — incremental signals', () => {
    it('emits each root element exactly once, in stream order, under 1-byte chunking', () => {
        const emitted: number[] = [];
        const parser = new PushParser({ onElement: element => emitted.push(element.tag) });
        feed(parser, COMPLEX_FILE, () => 1);
        parser.end();
        expect(emitted).toEqual([...parse(COMPLEX_FILE).dataSet.elements.keys()]);
    });

    it('resolves wanted tags (present and provably absent) before the pixel bytes arrive', () => {
        // x00090010 is absent; a settled tag above it proves absence
        const parser = new PushParser({ wanted: ['x00080018', 'x00090010'] });
        const pixelStart = COMPLEX_FILE.length - explicitEl('7FE00010', 'OW', latin1('pixel-data-bytes')).length;
        // feed everything before PixelData, plus its 12-byte header only
        let status = parser.push(COMPLEX_FILE.subarray(0, pixelStart + 12));
        expect(status.wantedResolved).toBe(true);
        expect(status.beforePixelData).toBe(true);
        expect(status.outcome.kind).toBe('needMoreBytes');
        // an unrelated early cut must NOT claim resolution
        const early = new PushParser({ wanted: ['x00280010'] });
        status = early.push(COMPLEX_FILE.subarray(0, 200));
        expect(status.wantedResolved).toBe(false);
    });

    it('reports needMoreBytes with progress-making hints and never malformed on a valid stream', () => {
        const parser = new PushParser();
        let at = 0;
        while (at < COMPLEX_FILE.length) {
            const status = parser.push(COMPLEX_FILE.subarray(at, at + 5));
            at = Math.min(at + 5, COMPLEX_FILE.length);
            expect(status.outcome.kind).not.toBe('malformed');
            if (status.outcome.kind === 'needMoreBytes') {
                expect(status.outcome.truncation.totalNeeded).toBeGreaterThan(0);
            }
        }
        expect(parser.status.outcome.kind).toBe('complete');
        expect(parser.status.beforePixelData).toBe(true);
    });

    it('exposes settled elements early via dataSet()', () => {
        const parser = new PushParser();
        const pixelLength = explicitEl('7FE00010', 'OW', latin1('pixel-data-bytes')).length;
        parser.push(COMPLEX_FILE.subarray(0, COMPLEX_FILE.length - pixelLength + 4));
        expect(parser.dataSet().element('x00080018')).toBeDefined();
    });

    it('keeps malformed sticky and matches parse at end()', () => {
        const file = p10(TS.explicitLE, [
            sqExplicitUndefined('00081110', [latin1('this is not an item tag!')]),
            explicitEl('00280010', 'US', Uint8Array.from([0x00, 0x02])),
        ]);
        const parser = new PushParser();
        let sawMalformed = false;
        for (let at = 0; at < file.length; at += 16) {
            const status = parser.push(file.subarray(at, at + 16));
            if (status.outcome.kind === 'malformed') {
                sawMalformed = true;
            } else {
                expect(sawMalformed, 'malformed must be sticky').toBe(false);
            }
        }
        expect(parser.status.outcome.kind).toBe('malformed');
        expectResultsEqual(parser.end(), parse(file));
    });

    it('honors stopAt exactly like parse (no elements settle past the stop)', () => {
        const options: ParseOptions = { stopAt: { tag: 0x7fe00010 } };
        const emitted: number[] = [];
        const parser = new PushParser({ ...options, onElement: e => emitted.push(e.tag) });
        feed(parser, COMPLEX_FILE, () => 9);
        const result = parser.end();
        expectResultsEqual(result, parse(COMPLEX_FILE, options));
        expect(emitted).toEqual([...parse(COMPLEX_FILE, options).dataSet.elements.keys()]);
    });
});

describe('PushParser — lifecycle and deflated', () => {
    it('push after end throws; end is idempotent', () => {
        const parser = new PushParser();
        feed(parser, COMPLEX_FILE, () => 64);
        const first = parser.end();
        expect(parser.end()).toBe(first);
        expect(() => parser.push(new Uint8Array(1))).toThrow(/already ended/);
        expect(() => new PushParser().push('nope' as unknown as Uint8Array)).toThrow(/Uint8Array/);
    });

    it('buffers deflated input (signals resolve at end) and endAsync matches', async () => {
        const parser = new PushParser();
        const status = feed(parser, DEFLATED_FILE, () => 32);
        expect(status.outcome.kind).toBe('needMoreBytes');
        expectResultsEqual(await parser.endAsync(), parse(DEFLATED_FILE));
    });
});

describe('PushParser — robustness', () => {
    it('chunking never changes the outcome, even on corrupted input', () => {
        let seed = 0x51a7b3;
        const rand = (): number => {
            seed = (seed + 0x6d2b79f5) | 0;
            let t = seed;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        for (let round = 0; round < 150; round++) {
            const mutated = Uint8Array.from(round % 2 === 0 ? COMPLEX_FILE : ENCAP_FILE);
            const flips = 1 + Math.floor(rand() * 6);
            for (let i = 0; i < flips; i++) {
                mutated[Math.floor(rand() * mutated.length)] = Math.floor(rand() * 256);
            }
            const parser = new PushParser();
            feed(parser, mutated, () => 1 + Math.floor(rand() * 48));
            const pushed = parser.end();
            const direct = parse(mutated);
            expect(pushed.ok).toBe(direct.ok);
            expect(pushed.error?.code).toBe(direct.error?.code);
            expect([...pushed.dataSet.elements.keys()]).toEqual([...direct.dataSet.elements.keys()]);
        }
    });
});
