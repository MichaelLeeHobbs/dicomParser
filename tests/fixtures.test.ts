import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EncapsulatedElement, ValueElement } from '../src/element';
import { parse, parseAsync, TS_DEFLATED_LE, TS_EXPLICIT_BE, TS_EXPLICIT_LE, TS_IMPLICIT_LE, type ParseResult } from '../src/parse';

// Real-file gate over the retained upstream fixture corpus (testImages/).
// DCMTK ground truth for CT1_UNC: Modality CT, Rows 512, Columns 512,
// PixelData OW 524288 bytes (explicit LE variant).

const IMAGES = join(__dirname, '..', 'testImages');

function load(...parts: string[]): Uint8Array {
    return new Uint8Array(readFileSync(join(IMAGES, ...parts)));
}

function uint16At(result: ParseResult, tag: string): number {
    const element = result.dataSet.element(tag);
    expect(element, `element ${tag}`).toBeDefined();
    const view = new DataView(result.bytes.buffer, result.bytes.byteOffset);
    return view.getUint16((element as ValueElement).dataOffset, result.dataSet.littleEndian);
}

function expectCt512(result: ParseResult): void {
    expect(result.error).toBeUndefined();
    expect(uint16At(result, 'x00280010')).toBe(512);
    expect(uint16At(result, 'x00280011')).toBe(512);
}

describe('CT1_UNC variants', () => {
    it('parses the explicit little endian file', () => {
        const result = parse(load('CT1_UNC.explicit_little_endian.dcm'));
        expect(result.transferSyntax).toBe(TS_EXPLICIT_LE);
        expectCt512(result);
        const pixelData = result.dataSet.element('x7fe00010') as ValueElement;
        expect(pixelData.kind).toBe('value');
        expect(pixelData.length).toBe(524288);
    });

    it('parses the explicit big endian file', () => {
        const result = parse(load('CT1_UNC.explicit_big_endian.dcm'));
        expect(result.transferSyntax).toBe(TS_EXPLICIT_BE);
        expectCt512(result);
        expect(result.dataSet.element('x7fe00010')?.length).toBe(524288);
    });

    it('parses the implicit little endian file', () => {
        const result = parse(load('CT1_UNC.implicit_little_endian.dcm'));
        expect(result.transferSyntax).toBe(TS_IMPLICIT_LE);
        expectCt512(result);
        expect(result.dataSet.element('x7fe00010')?.length).toBe(524288);
    });
});

describe('deflated transfer syntax files', () => {
    it.each(['image_dfl', 'report_dfl', 'wave_dfl'])('parses %s via node:zlib', name => {
        const result = parse(load('deflate', name));
        expect(result.error).toBeUndefined();
        expect(result.transferSyntax).toBe(TS_DEFLATED_LE);
        expect(result.dataSet.elements.size).toBeGreaterThan(5);
    });

    it('parses image_dfl via parseAsync', async () => {
        const result = await parseAsync(load('deflate', 'image_dfl'));
        expect(result.error).toBeUndefined();
        expect(uint16At(result, 'x00280010')).toBeGreaterThan(0);
    });
});

describe('encapsulated pixel data files', () => {
    it('parses a fragmented single-frame file with a basic offset table', () => {
        const result = parse(load('encapsulated', 'single-frame', 'CT1_UNC.fragmented_bot_jpeg_ls.80.dcm'));
        expect(result.error).toBeUndefined();
        const pixelData = result.dataSet.element('x7fe00010') as EncapsulatedElement;
        expect(pixelData.kind).toBe('encapsulated');
        expect(pixelData.basicOffsetTable.length).toBeGreaterThan(0);
        expect(pixelData.fragments.length).toBeGreaterThan(1);
    });

    it('parses a non-fragmented single-frame file without a basic offset table', () => {
        const result = parse(load('encapsulated', 'single-frame', 'CT1_UNC.not_fragmented_no_bot_jpeg_ls.80.dcm'));
        expect(result.error).toBeUndefined();
        const pixelData = result.dataSet.element('x7fe00010') as EncapsulatedElement;
        expect(pixelData.kind).toBe('encapsulated');
        expect(pixelData.basicOffsetTable).toHaveLength(0);
        expect(pixelData.fragments).toHaveLength(1);
    });

    it('parses a multi-frame RLE file with a basic offset table', () => {
        const result = parse(load('encapsulated', 'multi-frame', 'CT0012.not_fragmented_bot_rle.dcm'));
        expect(result.error).toBeUndefined();
        const pixelData = result.dataSet.element('x7fe00010') as EncapsulatedElement;
        expect(pixelData.kind).toBe('encapsulated');
        expect(pixelData.basicOffsetTable.length).toBeGreaterThan(1);
        expect(pixelData.fragments.length).toBe(pixelData.basicOffsetTable.length);
    });
});

describe('whole-corpus smoke', () => {
    const files: string[] = [];
    const queue = [IMAGES];
    while (queue.length > 0) {
        const dir = queue.pop() as string;
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) {
                queue.push(path);
            } else if (entry.endsWith('.dcm') || entry.endsWith('_dfl')) {
                files.push(path);
            }
        }
    }

    it('found the corpus', () => {
        expect(files.length).toBeGreaterThan(15);
    });

    it.each(files.map(f => [f.slice(IMAGES.length + 1)]))('parses %s without error', relative => {
        const result = parse(new Uint8Array(readFileSync(join(IMAGES, relative))));
        expect(result.error).toBeUndefined();
        expect(result.dataSet.elements.size).toBeGreaterThan(0);
        expect(result.dataSet.element('x7fe00010') ?? result.dataSet.element('x00080018')).toBeDefined();
    });
});
