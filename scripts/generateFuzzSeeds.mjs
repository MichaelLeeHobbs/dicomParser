/**
 * Generates the curated seeds of the fuzz crash-regression corpus
 * (`tests/fuzz-corpus/`) — shapes that historically broke this parser or its
 * upstream. Counterexamples found later are added as raw `.bin` files (see the
 * corpus README); this script only reproduces the curated set.
 *
 * Usage: node scripts/generateFuzzSeeds.mjs [outDir]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

const dir = process.argv[2] ?? 'tests/fuzz-corpus';
mkdirSync(dir, { recursive: true });

const cat = (...parts) => {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
};
const latin1 = value => Uint8Array.from([...value].map(c => c.charCodeAt(0) & 0xff));
const u16 = value => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, value, true);
    return b;
};
const u32 = value => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value >>> 0, true);
    return b;
};
const tag = value => cat(u16(Number.parseInt(value.slice(0, 4), 16)), u16(Number.parseInt(value.slice(4, 8), 16)));
const LONG_FORM = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
const el = (t, vr, value) => (LONG_FORM.has(vr) ? cat(tag(t), latin1(vr), new Uint8Array(2), u32(value.length), value) : cat(tag(t), latin1(vr), u16(value.length), value));
const pad = (value, padChar = ' ') => latin1(value.length % 2 ? value + padChar : value);
const metaGroup = ts => {
    const sopClass = el('00020002', 'UI', pad('1.2.840.10008.5.1.4.1.1.7', '\0'));
    const syntax = el('00020010', 'UI', pad(ts, '\0'));
    return cat(el('00020000', 'UL', u32(sopClass.length + syntax.length)), sopClass, syntax);
};
const p10 = (ts, ...elements) => cat(new Uint8Array(128), latin1('DICM'), metaGroup(ts), ...elements);

const UNDEFINED = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
const JPEG = '1.2.840.10008.1.2.4.50';
const EXPLICIT_LE = '1.2.840.10008.1.2.1';
const DEFLATED = '1.2.840.10008.1.2.1.99';
const write = (name, bytes) => {
    writeFileSync(`${dir}/${name}`, bytes);
    console.log(`${name} (${bytes.length} bytes)`);
};

// fork #67: an undefined-length fragment item inside encapsulated pixel data
write(
    'encapsulated-undefined-length-fragment.bin',
    p10(JPEG, cat(tag('7FE00010'), latin1('OB'), new Uint8Array(2), UNDEFINED, tag('FFFEE000'), u32(0), tag('FFFEE000'), UNDEFINED, latin1('payload!'), tag('FFFEE0DD'), u32(0)))
);

// upstream #266: a delimitation item carrying 0xFFFFFFFF as its length
write('nonzero-sequence-delimiter-length.bin', p10(EXPLICIT_LE, cat(tag('00081110'), latin1('SQ'), new Uint8Array(2), UNDEFINED, tag('FFFEE000'), u32(0), tag('FFFEE0DD'), UNDEFINED)));

// a defined-length sequence item declaring far past end of file
write('sequence-item-overruns-eof.bin', p10(EXPLICIT_LE, cat(tag('00081110'), latin1('SQ'), new Uint8Array(2), u32(16), tag('FFFEE000'), u32(0x7fffffff), latin1('short'))));

// the file meta group cut mid-value
write('truncated-meta-group.bin', p10(EXPLICIT_LE).subarray(0, 150));

// an element whose declared length overruns end of data
write('value-length-overruns-eof.bin', p10(EXPLICIT_LE, cat(tag('00081030'), latin1('LO'), u16(0xfffe), latin1('short value'))));

// a corrupt deflate payload under the deflated transfer syntax
const deflated = new Uint8Array(deflateRawSync(Buffer.from(el('00080060', 'CS', pad('CT')))));
deflated[Math.floor(deflated.length / 2)] ^= 0xff;
write('corrupt-deflate-stream.bin', cat(new Uint8Array(128), latin1('DICM'), metaGroup(DEFLATED), deflated));

write('empty.bin', new Uint8Array(0));
write('prefix-only.bin', cat(new Uint8Array(128), latin1('DICM')));
