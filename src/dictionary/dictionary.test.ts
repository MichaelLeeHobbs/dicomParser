import { describe, expect, it } from 'vitest';
import { isKnownVr } from '../vr';
import { parse } from '../parse';
import { tag } from '../tag';
import { DICTIONARY_DATA, dictionaryVrLookup, lookupKeyword, lookupTag } from './index';
import { TS, concat, explicitEl, implicitEl, item, latin1, p10, tagBytes, uint32Bytes } from '../../tests/helpers/p10';

describe('dictionary — data integrity', () => {
    it('ships the full generated table with only standard VRs and valid shapes', () => {
        const entries = Object.entries(DICTIONARY_DATA);
        expect(entries.length).toBeGreaterThan(4500);
        for (const [key, packed] of entries) {
            expect(key).toMatch(/^[0-9A-F]{8}$/);
            expect(isKnownVr(packed[0]), `VR ${packed[0]} for ${key}`).toBe(true);
            expect(packed[2]).toBeGreaterThanOrEqual(0);
            if (packed[3] !== null) {
                expect(packed[3]).toBeGreaterThanOrEqual(packed[2]);
            }
        }
    });
});

describe('dictionary — lookupTag', () => {
    it('resolves well-known tags', () => {
        expect(lookupTag('x00100010')).toMatchObject({ keyword: 'PatientName', vr: 'PN', vm: [1, 1], retired: false });
        expect(lookupTag(0x7fe00010)).toMatchObject({ keyword: 'PixelData', vr: 'OW' });
        expect(lookupTag(tag(0x0008, 0x1110))).toMatchObject({ keyword: 'ReferencedStudySequence', vr: 'SQ' });
    });

    it('masks overlay repeating groups (even 60xx) to the stored representative', () => {
        const entry = lookupTag(0x60000010);
        expect(entry).toMatchObject({ vr: 'US', tag: 0x60000010 });
        expect(entry?.keyword).toContain('Overlay');
        expect(lookupTag(0x60fe0010)?.vr).toBe('US');
        // odd groups in the overlay range are private, never masked
        expect(lookupTag(0x60010010)).toBeUndefined();
    });

    it('masks retired curve repeating groups (even 50xx)', () => {
        const entry = lookupTag(0x50000005);
        expect(entry?.retired).toBe(true);
        expect(lookupTag(0x50010005)).toBeUndefined();
    });

    it('returns undefined for unknown tags', () => {
        expect(lookupTag(0x00090010)).toBeUndefined();
    });
});

describe('dictionary — lookupKeyword', () => {
    it('resolves keywords to entries', () => {
        expect(lookupKeyword('PatientName')?.tag).toBe(0x00100010);
        expect(lookupKeyword('TransferSyntaxUID')?.tag).toBe(0x00020010);
        expect(lookupKeyword('NoSuchKeyword')).toBeUndefined();
    });
});

describe('dictionary — dictionaryVrLookup integration', () => {
    it('supplies VRs for implicit streams', () => {
        expect(dictionaryVrLookup(0x00080018)).toBe('UI');
        expect(dictionaryVrLookup(0x00081110)).toBe('SQ');
        expect(dictionaryVrLookup(0x00090010)).toBeUndefined();
    });

    it('unlocks CP-246: explicit UN with defined length parses as a sequence when the dictionary says SQ', () => {
        // (0008,1110) as UN, defined length, containing one item — CP-246 says
        // parse as implicit-VR sequence when a lookup identifies SQ
        const itemBytes = item(implicitEl('00081150', latin1('1.2.840.10008.5.1.4.1.1.7\0')));
        const un = concat([tagBytes('00081110'), latin1('UN'), new Uint8Array(2), uint32Bytes(itemBytes.length, false), itemBytes]);
        const file = p10(TS.explicitLE, [un, explicitEl('00280010', 'US', Uint8Array.from([0x00, 0x02]))]);
        const withDict = parse(file, { vrLookup: dictionaryVrLookup });
        expect(withDict.dataSet.elements.get(0x00081110)?.kind).toBe('sequence');
        const without = parse(file);
        expect(without.dataSet.elements.get(0x00081110)?.kind).toBe('value');
    });
});
