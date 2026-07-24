import { describe, expect, it } from 'vitest';
import { parse, parseAsync, TS_DEFLATED_LE } from '../../src/parse';
import { buildMetaGroup, writeFile } from '../../src/writeFile';
import { encodeDataSet } from '../../src/writer';
import { dataSet, element } from '../../src/writeModel';

// Browser smoke suite: runs in a real browser (Playwright/Chrome) to prove the
// zero-dependency bundle loads and executes without any Node APIs, and that the
// browser inflate path (DecompressionStream, not node:zlib) works end to end.

const SPEC = [
    element('00080016', 'UI', '1.2.840.10008.5.1.4.1.1.7'),
    element('00080018', 'UI', '1.2.3.4.5'),
    element('00080060', 'CS', 'CT'),
    element('00100010', 'PN', 'Doe^Jane'),
];

/** Raw-deflates bytes using the browser's CompressionStream (no node:zlib). */
async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    void writer.write(bytes as Uint8Array<ArrayBuffer>);
    void writer.close();
    const chunks: Uint8Array[] = [];
    const reader = cs.readable.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

describe('browser smoke', () => {
    it('runs in a real browser environment (no node process)', () => {
        expect(typeof window).toBe('object');
        expect(typeof (globalThis as { process?: unknown }).process).toBe('undefined');
    });

    it('parses a written Part-10 file synchronously', () => {
        const file = writeFile({ dataSet: dataSet(SPEC) });
        const result = parse(file);
        expect(result.error).toBeUndefined();
        expect(result.dataSet.string('x00080060')).toBe('CT');
        expect(result.dataSet.string('x00100010')).toBe('Doe^Jane');
    });

    it('inflates a deflated file via DecompressionStream (parseAsync)', async () => {
        const body = encodeDataSet(dataSet(SPEC), { explicitVr: true });
        const deflated = await deflateRaw(body);
        const meta = buildMetaGroup(TS_DEFLATED_LE, '1.2.840.10008.5.1.4.1.1.7', '1.2.3.4.5');
        const file = new Uint8Array(132 + meta.length + deflated.length);
        file.set([0x44, 0x49, 0x43, 0x4d], 128); // 'DICM'
        file.set(meta, 132);
        file.set(deflated, 132 + meta.length);

        const result = await parseAsync(file);
        expect(result.error).toBeUndefined();
        expect(result.transferSyntax).toBe(TS_DEFLATED_LE);
        expect(result.dataSet.string('x00080060')).toBe('CT');
        expect(result.dataSet.string('x00100010')).toBe('Doe^Jane');
    });
});
