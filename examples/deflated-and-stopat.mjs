// Deflated transfer syntax + metadata-only fast path.
// Run from the repo root: node examples/deflated-and-stopat.mjs
import { readFileSync } from 'node:fs';
import { parse, parseAsync } from '@ubercode/dicom-parser';

const bytes = new Uint8Array(readFileSync('testImages/deflate/image_dfl'));

// sync (node:zlib); in browsers without an injected inflater use parseAsync()
const sync = parse(bytes);
console.log('sync   :', sync.transferSyntax, sync.dataSet.elements.size, 'elements');

const async = await parseAsync(bytes);
console.log('async  :', async.dataSet.uint16('x00280010'), 'rows');

// stop before pixel data — works even when the exact tag is absent (≥ semantics)
const meta = parse(new Uint8Array(readFileSync('testImages/CT1_UNC.explicit_little_endian.dcm')), {
    stopAt: { tag: 'x7fe00010', inclusive: false },
});
console.log('stopAt :', meta.stoppedAt?.toString(16), '— parsed', meta.dataSet.elements.size, 'elements, skipped pixel data');
