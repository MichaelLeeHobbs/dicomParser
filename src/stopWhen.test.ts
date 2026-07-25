import { describe, expect, it } from 'vitest';
import { parse } from './parse';
import { PushParser } from './pushParser';
import { tag } from './tag';
import { TS, concat, evenPad, explicitEl, p10, sqExplicit } from '../tests/helpers/p10';

// Differential suite for issue #35: resolved-tag-set stop conditions. The
// motivating case is an SR-like object with no tag near the end of tag space —
// a (7FE0,0010) threshold never fires, so header extraction used to walk the
// entire content sequence.

const CONTENT_SQ = sqExplicit('0040A730', [concat([explicitEl('0040A160', 'UT', evenPad('a very long SR text payload '.repeat(20)))])]);

const SR_FILE = p10(TS.explicitLE, [
    explicitEl('00080018', 'UI', evenPad('1.2.840.10008.5.1.4.1.1.88.11', '\0')),
    explicitEl('00100010', 'PN', evenPad('DOE^JANE')),
    explicitEl('00100020', 'LO', evenPad('MRN-1234')),
    CONTENT_SQ,
]);

describe('stopAt resolved-tag sets (#35)', () => {
    it('stops once all wanted tags are answered — the trailing content sequence is never parsed', () => {
        const result = parse(SR_FILE, { stopAt: { tags: ['x00080018', 'x00100010'] } });
        expect(result.ok).toBe(true);
        expect(result.dataSet.elements.has(0x00080018)).toBe(true);
        expect(result.dataSet.elements.has(0x00100010)).toBe(true);
        // the terminating element marks the boundary and is not parsed
        expect(result.stoppedAt).toBe(0x00100020);
        expect(result.dataSet.elements.has(0x00100020)).toBe(false);
        expect(result.dataSet.elements.has(0x0040a730)).toBe(false);
    });

    it('resolves an absent tag by ordering proof and stops there', () => {
        // x00090010 is absent; the first greater root tag proves it
        const result = parse(SR_FILE, { stopAt: { tags: ['x00090010'] } });
        expect(result.stoppedAt).toBe(0x00100010);
        expect(result.dataSet.elements.has(0x00080018)).toBe(true);
        expect(result.dataSet.elements.has(0x00100010)).toBe(false);
    });

    it('resolves a mixed present + absent set at the correct boundary', () => {
        const result = parse(SR_FILE, { stopAt: { tags: ['x00090010', 'x00100020'] } });
        expect(result.stoppedAt).toBe(0x0040a730);
        expect(result.dataSet.elements.has(0x00100020)).toBe(true);
        expect(result.dataSet.elements.has(0x0040a730)).toBe(false);
    });

    it('parses to the end when the last wanted tag is the last element', () => {
        const result = parse(SR_FILE, { stopAt: { tags: ['x0040A730'] } });
        expect(result.ok).toBe(true);
        expect(result.stoppedAt).toBeUndefined();
        expect(result.dataSet.elements.has(0x0040a730)).toBe(true);
    });

    it('rejects an empty tag set', () => {
        expect(() => parse(SR_FILE, { stopAt: { tags: [] } })).toThrow(/must not be empty/);
    });

    it('group bounds are the existing single-tag threshold', () => {
        const result = parse(SR_FILE, { stopAt: { tag: tag(0x0009, 0x0000) } });
        expect(result.stoppedAt).toBe(0x00100010);
        expect(result.dataSet.elements.has(0x00080018)).toBe(true);
        expect(result.dataSet.elements.has(0x00100010)).toBe(false);
    });

    it('keeps the first occurrence of a non-conformant duplicate wanted tag (characterization)', () => {
        // A full parse keeps the last duplicate; a set stop resolves on the
        // first and stops before the second. Documented caveat, locked here.
        const file = p10(TS.explicitLE, [
            explicitEl('00100010', 'PN', evenPad('FIRST')),
            explicitEl('00100010', 'PN', evenPad('SECOND')),
            explicitEl('00280010', 'US', Uint8Array.from([0x00, 0x02])),
        ]);
        const result = parse(file, { stopAt: { tags: ['x00100010'] } });
        expect(result.stoppedAt).toBe(0x00100010);
        const element = result.dataSet.elements.get(0x00100010);
        expect(element).toBeDefined();
    });

    it('composes with parsePartial-style early availability through PushParser, chunked', () => {
        const options = { stopAt: { tags: ['x00080018', 'x00100020'] } };
        const emitted: number[] = [];
        const parser = new PushParser({ ...options, onElement: e => emitted.push(e.tag) });
        for (let at = 0; at < SR_FILE.length; at += 9) {
            parser.push(SR_FILE.subarray(at, at + 9));
        }
        const direct = parse(SR_FILE, options);
        const pushed = parser.end();
        expect(pushed.stoppedAt).toBe(direct.stoppedAt);
        expect([...pushed.dataSet.elements.keys()]).toEqual([...direct.dataSet.elements.keys()]);
        expect(emitted).toEqual([...direct.dataSet.elements.keys()]);
    });
});
