import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DicomError } from './errors';
import { parse, TS_DEFLATED_LE, TS_EXPLICIT_BE, TS_EXPLICIT_LE, TS_IMPLICIT_LE } from './parse';
import { encodeDataSet, encodeDataSetInto, encodeDataSetTo, encodePlanInto, encodedLength, planEncode } from './writer';
import { modifyDataSet, writeFile, writeFileTo } from './writeFile';
import { dataSet, element, item, toWriteModel } from './writeModel';
import { collectTestImages } from '../tests/helpers/corpus';

// #41: the sized two-pass encoder can emit into a caller's buffer or to a
// sink, so the write path no longer has to hold the dataset and the assembled
// file at the same time. Every variant must be byte-identical to encodeDataSet.

function concat(chunks: readonly Uint8Array[]): Uint8Array {
    const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
}

function bigValue(): Uint8Array {
    const big = new Uint8Array(200_000);
    big.forEach((_, i) => (big[i] = i & 0xff));
    return big;
}

/** Sequences plus a value far larger than any chunk (native syntaxes). */
function nativeDataSet(): ReturnType<typeof dataSet> {
    return dataSet([
        element('00080060', 'CS', 'CT'),
        element('00081110', 'SQ', [item([element('00080100', 'SH', 'AB'), element('00081150', 'UI', '1.2.3')]), item([element('00080100', 'SH', 'CD')])]),
        element('00281201', 'OW', bigValue()),
        element('7FE00010', 'OW', new Uint8Array(4096)),
    ]);
}

/** The same, with multi-fragment encapsulated pixel data (compressed syntaxes). */
function richDataSet(): ReturnType<typeof dataSet> {
    return dataSet([
        element('00080060', 'CS', 'CT'),
        element('00081110', 'SQ', [item([element('00080100', 'SH', 'AB'), element('00081150', 'UI', '1.2.3')]), item([element('00080100', 'SH', 'CD')])]),
        element('00281201', 'OW', bigValue()),
        {
            ...element('7FE00010', 'OB', { kind: 'fragments', basicOffsetTable: [0], fragments: [new Uint8Array(90_000), new Uint8Array(1_000)] }),
            undefinedLength: true,
        },
    ]);
}

describe('encodedLength / encodeDataSetInto (#41)', () => {
    it('sizes exactly what encodeDataSet produces', () => {
        for (const explicitVr of [true, false]) {
            const model = richDataSet();
            expect(encodedLength(model, { explicitVr })).toBe(encodeDataSet(model, { explicitVr }).length);
        }
    });

    it('encodes into a caller buffer at an offset without touching the surroundings', () => {
        const model = richDataSet();
        const expected = encodeDataSet(model);
        const target = new Uint8Array(16 + expected.length + 16).fill(0xaa);
        const written = encodeDataSetInto(model, target, 16);
        expect(written).toBe(expected.length);
        expect([...target.subarray(16, 16 + expected.length)]).toEqual([...expected]);
        expect([...target.subarray(0, 16)]).toEqual(new Array(16).fill(0xaa));
        expect([...target.subarray(16 + expected.length)]).toEqual(new Array(16).fill(0xaa));
    });

    it('refuses a target that cannot hold the encoding', () => {
        const model = richDataSet();
        const exact = encodedLength(model);
        expect(() => encodeDataSetInto(model, new Uint8Array(exact - 1))).toThrow(DicomError);
        expect(() => encodeDataSetInto(model, new Uint8Array(exact), 1)).toThrow(/do not fit/);
        expect(() => encodeDataSetInto(model, new Uint8Array(exact), -1)).toThrow(/do not fit/);
        expect(() => encodeDataSetInto(model, new Uint8Array(exact), 0)).not.toThrow();
    });
});

describe('planEncode / encodePlanInto (#41)', () => {
    it('sizes once and emits without re-sizing', () => {
        const model = richDataSet();
        const plan = planEncode(model);
        expect(plan.total).toBe(encodedLength(model));
        const target = new Uint8Array(plan.total);
        expect(encodePlanInto(plan, target)).toBe(plan.total);
        expect([...target]).toEqual([...encodeDataSet(model)]);
    });

    it('honours the options the plan was built with', () => {
        const model = richDataSet();
        const implicitPlan = planEncode(model, { explicitVr: false });
        const target = new Uint8Array(implicitPlan.total);
        encodePlanInto(implicitPlan, target);
        expect([...target]).toEqual([...encodeDataSet(model, { explicitVr: false })]);
    });

    it('rejects a target that cannot hold the plan', () => {
        const plan = planEncode(richDataSet());
        expect(() => encodePlanInto(plan, new Uint8Array(plan.total - 1))).toThrow(/do not fit/);
        expect(() => encodePlanInto(plan, new Uint8Array(plan.total), 1)).toThrow(/do not fit/);
    });
});

describe('encodeDataSetTo (#41)', () => {
    it('rejects an invalid chunkSize instead of silently clamping it', () => {
        const model = dataSet([element('00080060', 'CS', 'CT')]);
        for (const chunkSize of [0, 1, 15, -64, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => encodeDataSetTo(() => undefined, model, { chunkSize }), `chunkSize ${chunkSize}`).toThrow(/chunkSize must be an integer/);
        }
        expect(() => encodeDataSetTo(() => undefined, model, { chunkSize: 16 })).not.toThrow();
    });

    it('streams bytes identical to encodeDataSet, at every chunk size', () => {
        const model = richDataSet();
        const expected = encodeDataSet(model);
        for (const chunkSize of [16, 64, 1024, 64 * 1024, 1_000_000]) {
            const chunks: Uint8Array[] = [];
            const written = encodeDataSetTo(chunk => chunks.push(chunk), model, { chunkSize });
            expect(written, `chunkSize ${chunkSize}`).toBe(expected.length);
            expect([...concat(chunks)], `chunkSize ${chunkSize}`).toEqual([...expected]);
        }
    });

    it('keeps peak buffering at the chunk size: big values pass through uncopied', () => {
        const fragment = new Uint8Array(90_000).fill(7);
        const model = dataSet([{ ...element('7FE00010', 'OB', { kind: 'fragments', basicOffsetTable: [], fragments: [fragment] }), undefinedLength: true }]);
        const chunks: Uint8Array[] = [];
        encodeDataSetTo(chunk => chunks.push(chunk), model, { chunkSize: 1024 });
        // the fragment reaches the sink as a view over the caller's own array,
        // never staged through the rolling buffer
        expect(chunks.some(chunk => chunk.buffer === fragment.buffer && chunk.length === fragment.length)).toBe(true);
        expect(Math.max(...chunks.filter(c => c.buffer !== fragment.buffer).map(c => c.length))).toBeLessThanOrEqual(1024);
    });

    it('hands the sink chunks that stay valid after it returns (no reused buffer)', () => {
        const model = richDataSet();
        const chunks: Uint8Array[] = [];
        encodeDataSetTo(chunk => chunks.push(chunk), model, { chunkSize: 512 });
        // queueing every chunk and concatenating afterwards must still match
        expect([...concat(chunks)]).toEqual([...encodeDataSet(model)]);
    });

    it('reports unencodable input rather than emitting a partial stream', () => {
        const bad = dataSet([element('00081030', 'LO', new Uint8Array(3))]);
        const chunks: Uint8Array[] = [];
        expect(() => encodeDataSetTo(chunk => chunks.push(chunk), bad)).toThrow(/odd/);
        expect(chunks).toHaveLength(0); // sizing fails before a byte is emitted
    });
});

describe('writeFileTo (#41)', () => {
    const cases: [string, string, () => ReturnType<typeof dataSet>][] = [
        ['explicit LE', TS_EXPLICIT_LE, nativeDataSet],
        ['implicit LE', TS_IMPLICIT_LE, nativeDataSet],
        ['JPEG baseline (encapsulated)', '1.2.840.10008.1.2.4.50', richDataSet],
    ];
    for (const [name, transferSyntax, build] of cases) {
        it(`streams a byte-identical file for ${name}`, () => {
            const options = { dataSet: build(), transferSyntax };
            const expected = writeFile(options);
            const chunks: Uint8Array[] = [];
            const written = writeFileTo(chunk => chunks.push(chunk), { ...options, chunkSize: 4096 });
            expect(written).toBe(expected.length);
            expect([...concat(chunks)]).toEqual([...expected]);
            expect(parse(concat(chunks)).error).toBeUndefined();
        });
    }

    it('streams the deflated syntax as a single payload chunk (documented limit)', () => {
        const options = { dataSet: dataSet([element('00080060', 'CS', 'CT')]), transferSyntax: TS_DEFLATED_LE };
        const expected = writeFile(options);
        const chunks: Uint8Array[] = [];
        const written = writeFileTo(chunk => chunks.push(chunk), options);
        expect(written).toBe(expected.length);
        expect([...concat(chunks)]).toEqual([...expected]);
        expect(chunks).toHaveLength(4); // preamble, DICM, meta, deflated payload
    });

    it('matches writeFile across the fixture corpus round trip', () => {
        const images = collectTestImages();
        expect(images.length).toBeGreaterThan(0);
        let compared = 0;
        for (const path of images.slice(0, 12)) {
            const parsed = parse(new Uint8Array(readFileSync(path)));
            // the write path is little-endian, and deflate cannot stream
            if (!parsed.ok || parsed.transferSyntax === TS_DEFLATED_LE || parsed.transferSyntax === TS_EXPLICIT_BE) {
                continue;
            }
            const options = { dataSet: toWriteModel(parsed.dataSet), transferSyntax: parsed.transferSyntax };
            const chunks: Uint8Array[] = [];
            writeFileTo(chunk => chunks.push(chunk), { ...options, chunkSize: 8192 });
            expect([...concat(chunks)], path).toEqual([...writeFile(options)]);
            compared++;
        }
        expect(compared).toBeGreaterThan(0);
    });

    it('serves the modify path: edit, stream out, re-parse', () => {
        const original = writeFile({ dataSet: dataSet([element('00100010', 'PN', 'Doe^Jane'), element('00280010', 'US', [512])]) });
        const parsed = parse(original);
        const edited = modifyDataSet(parsed.dataSet, { set: [element('00100010', 'PN', 'ANON^ANON')] });
        const chunks: Uint8Array[] = [];
        writeFileTo(chunk => chunks.push(chunk), { dataSet: edited, chunkSize: 256 });
        const result = parse(concat(chunks));
        expect(result.error).toBeUndefined();
        expect(result.dataSet.string('x00100010')).toBe('ANON^ANON');
        expect(result.dataSet.uint16('x00280010')).toBe(512);
    });
});
