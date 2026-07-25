/**
 * PS3.6 tag dictionary as an opt-in, tree-shakeable subpath
 * (`@ubercode/dicom-parser/dictionary`) — issue #36.
 *
 * The core parser stays dictionary-free by design (consumers supply VR
 * knowledge via `vrLookup`); importing the main entry never pulls this data.
 * Consumers who want keyword ↔ tag ↔ VR ↔ VM lookup import this subpath and
 * can plug {@link dictionaryVrLookup} straight into `ParseOptions.vrLookup`,
 * which also unlocks CP-246 `UN`-as-sequence and private implicit-SQ parsing.
 *
 * Repeating groups are masked on lookup: overlay tags `(60xx,eeee)` and
 * retired curve tags `(50xx,eeee)` (even group numbers, per PS3.6 §7.6)
 * resolve to their stored `60FF`/`50FF` representative while reporting the
 * queried tag. Retired keywords keep DCMTK's `RETIRED_` prefix.
 *
 * @module dictionary
 */

import type { VrLookup } from '../elementHeader';
import { toTag, type Tag, type TagLike } from '../tag';
import { DICTIONARY_DATA, type PackedEntry } from './data';

/** A resolved data-dictionary entry. */
export interface DictionaryEntry {
    /** The queried tag (masked repeating-group queries report the query, not the representative). */
    readonly tag: Tag;
    /** The PS3.6 keyword (e.g. `PatientName`); retired entries carry a `RETIRED_` prefix. */
    readonly keyword: string;
    /** The Value Representation code (DCMTK multi-VR aliases normalized: `US or SS` → `US`, `OB or OW` → `OW`). */
    readonly vr: string;
    /** Value multiplicity as `[min, max]`, `null` max meaning unbounded. */
    readonly vm: readonly [number, number | null];
    /** `true` when the tag is retired in the current standard. */
    readonly retired: boolean;
}

function hex8(tag: Tag): string {
    return tag.toString(16).padStart(8, '0').toUpperCase();
}

/**
 * Repeating-group mask (PS3.6 §7.6): overlays `(6000-60FE,eeee)` and retired
 * curves `(5000-50FE,eeee)` — even group numbers only; odd groups in those
 * ranges are private tags — are stored once under `60FF`/`50FF`.
 */
function packedFor(tag: Tag): PackedEntry | undefined {
    const key = hex8(tag);
    const direct = DICTIONARY_DATA[key];
    if (direct !== undefined) {
        return direct;
    }
    const group = Math.floor(tag / 0x10000);
    const groupBase = group & 0xff00;
    if ((group & 1) === 0 && (groupBase === 0x6000 || groupBase === 0x5000)) {
        return DICTIONARY_DATA[(groupBase === 0x6000 ? '60FF' : '50FF') + key.slice(4)];
    }
    return undefined;
}

function toEntry(tag: Tag, packed: PackedEntry): DictionaryEntry {
    return { tag, keyword: packed[1], vr: packed[0], vm: [packed[2], packed[3]], retired: packed[4] === 1 };
}

/**
 * Looks up a tag in the PS3.6 dictionary, masking repeating groups
 * (overlays/curves) to their stored representative.
 *
 * @param tag - The tag to resolve (number, `'xGGGGEEEE'`, or `'GGGGEEEE'` forms)
 * @returns The entry, or `undefined` when the tag is not in the dictionary
 */
export function lookupTag(tag: TagLike): DictionaryEntry | undefined {
    const resolved = toTag(tag);
    const packed = packedFor(resolved);
    return packed === undefined ? undefined : toEntry(resolved, packed);
}

let keywordIndex: ReadonlyMap<string, Tag> | undefined;

function buildKeywordIndex(): ReadonlyMap<string, Tag> {
    const map = new Map<string, Tag>();
    for (const [key, packed] of Object.entries(DICTIONARY_DATA)) {
        map.set(packed[1], Number.parseInt(key, 16));
    }
    return map;
}

/**
 * Looks up a tag by its PS3.6 keyword (lazily indexed on first use). For
 * repeating groups the returned tag is the stored `60FF`/`50FF`
 * representative.
 *
 * @param keyword - The keyword, e.g. `'PatientName'`
 * @returns The entry, or `undefined` for an unknown keyword
 */
export function lookupKeyword(keyword: string): DictionaryEntry | undefined {
    keywordIndex ??= buildKeywordIndex();
    const tag = keywordIndex.get(keyword);
    if (tag === undefined) {
        return undefined;
    }
    const packed = DICTIONARY_DATA[hex8(tag)] as PackedEntry;
    return toEntry(tag, packed);
}

/**
 * A `ParseOptions.vrLookup` backed by the PS3.6 dictionary: supplies VRs for
 * implicit-VR streams and identifies `SQ` tags for CP-246 `UN` handling.
 * Repeating groups are masked like {@link lookupTag}.
 *
 * @param tag - The tag to resolve
 * @returns The VR code, or `undefined` when unknown
 */
export const dictionaryVrLookup: VrLookup = (tag: Tag): string | undefined => packedFor(tag)?.[0];

export { DICTIONARY_DATA, type PackedEntry } from './data';
