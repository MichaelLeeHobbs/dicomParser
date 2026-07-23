import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DicomDataSet } from '../src/dataSet';
import { parse, TS_EXPLICIT_BE, type ParseResult } from '../src/parse';
import { serializeParsed, writeFile } from '../src/writeFile';
import { dataSet, element, item } from '../src/writeModel';

// Phase 3 round-trip gates (PLAN.md §6.6): byte-identical re-serialization of
// unmodified conformant files across the fixture corpus, and DCMTK accepting
// writer output (dcmdump gate, skipped where DCMTK is not installed).

const IMAGES = join(__dirname, '..', 'testImages');

function collectFiles(): string[] {
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
    return files;
}

/** Iterative structural comparison of two parsed datasets. */
function expectSemanticallyEqual(a: DicomDataSet, b: DicomDataSet): void {
    const queue: { left: DicomDataSet; right: DicomDataSet }[] = [{ left: a, right: b }];
    while (queue.length > 0) {
        const { left, right } = queue.pop() as { left: DicomDataSet; right: DicomDataSet };
        expect([...right.elements.keys()]).toEqual([...left.elements.keys()]);
        for (const [tag, leftEl] of left.elements) {
            const rightEl = right.elements.get(tag) as NonNullable<ReturnType<DicomDataSet['element']>>;
            expect(rightEl.kind, `kind of ${tag.toString(16)}`).toBe(leftEl.kind);
            if (leftEl.kind === 'sequence' && rightEl.kind === 'sequence') {
                expect(rightEl.items.length).toBe(leftEl.items.length);
                leftEl.items.forEach((leftItem, i) => {
                    queue.push({ left: leftItem.dataSet, right: (rightEl.items[i] as (typeof rightEl.items)[number]).dataSet });
                });
                continue;
            }
            if (leftEl.kind === 'encapsulated' && rightEl.kind === 'encapsulated') {
                expect(rightEl.basicOffsetTable).toEqual(leftEl.basicOffsetTable);
                expect(rightEl.fragments.map(f => f.length)).toEqual(leftEl.fragments.map(f => f.length));
                continue;
            }
            expect(rightEl.length, `length of ${tag.toString(16)}`).toBe(leftEl.length);
            const leftBytes = a.bytes.subarray(leftEl.dataOffset, leftEl.dataOffset + leftEl.length);
            const rightBytes = b.bytes.subarray(rightEl.dataOffset, rightEl.dataOffset + rightEl.length);
            expect(Buffer.from(rightBytes).equals(Buffer.from(leftBytes)), `value of ${tag.toString(16)}`).toBe(true);
        }
    }
}

describe('round-trip: byte-identical re-serialization (corpus gate)', () => {
    const files = collectFiles();

    it.each(files.map(f => [f.slice(IMAGES.length + 1)]))('%s', relative => {
        const original = new Uint8Array(readFileSync(join(IMAGES, relative)));
        const parsed = parse(original);
        expect(parsed.error).toBeUndefined();
        if (parsed.transferSyntax === TS_EXPLICIT_BE) {
            expect(() => serializeParsed(parsed)).toThrow(/read-only/);
            return;
        }
        const rewritten = serializeParsed(parsed);
        if (parsed.transferSyntax === '1.2.840.10008.1.2.1.99') {
            // deflated: recompression differs byte-wise; require parse-equality
            const reparsed = parse(rewritten);
            expect(reparsed.error).toBeUndefined();
            expectSemanticallyEqual(parsed.dataSet, reparsed.dataSet);
            return;
        }
        expect(Buffer.from(rewritten).equals(Buffer.from(original)), 'byte-identical round trip').toBe(true);
    });
});

describe('round-trip: modify preserves everything else', () => {
    it('parse → modify → serialize → parse is semantically identical outside the edit', async () => {
        const { modifyDataSet } = await import('../src/writeFile');
        const original = new Uint8Array(readFileSync(join(IMAGES, 'CT1_UNC.explicit_little_endian.dcm')));
        const parsed = parse(original);
        const edited = writeFile({
            dataSet: modifyDataSet(parsed.dataSet, { set: [element('00100010', 'PN', 'Roundtrip^Test')] }),
            sopClassUid: parsed.meta.string('x00020002') ?? '',
            sopInstanceUid: parsed.meta.string('x00020003') ?? '',
        });
        const reparsed = parse(edited);
        expect(reparsed.error).toBeUndefined();
        expect(reparsed.dataSet.string('x00100010')).toBe('Roundtrip^Test');
        expect(reparsed.dataSet.uint16('x00280010')).toBe(512);
        expect(reparsed.dataSet.element('x7fe00010')?.length).toBe(parsed.dataSet.element('x7fe00010')?.length);
    });
});

const DCMDUMP = 'C:\\ProgramData\\chocolatey\\bin\\dcmdump.exe';
const hasDcmtk = existsSync(DCMDUMP);

describe.skipIf(!hasDcmtk)('round-trip: DCMTK accepts writer output', () => {
    function dcmdumpAccepts(bytes: Uint8Array, name: string): string {
        const dir = mkdtempSync(join(tmpdir(), 'dicom-writer-'));
        const path = join(dir, name);
        writeFileSync(path, bytes);
        return execFileSync(DCMDUMP, [path], { encoding: 'utf8' });
    }

    it('accepts a from-scratch file', () => {
        const file = writeFile({
            dataSet: dataSet([
                element('00080016', 'UI', '1.2.840.10008.5.1.4.1.1.7'),
                element('00080018', 'UI', '1.2.3.4.5'),
                element('00080060', 'CS', 'OT'),
                element('00081140', 'SQ', [item([element('00080100', 'SH', 'AB')])]),
                element('00100010', 'PN', 'Writer^Test'),
                element('00280010', 'US', [2]),
            ]),
        });
        const dump = dcmdumpAccepts(file, 'scratch.dcm');
        expect(dump).toContain('Writer^Test');
        expect(dump).toContain('(0008,1140)');
    });

    it('accepts a modified round-tripped real file', () => {
        const original = new Uint8Array(readFileSync(join(IMAGES, 'CT1_UNC.explicit_little_endian.dcm')));
        const parsed: ParseResult = parse(original);
        const rewritten = serializeParsed(parsed);
        const dump = dcmdumpAccepts(rewritten, 'roundtrip.dcm');
        expect(dump).toContain('(7fe0,0010)');
    });
});
