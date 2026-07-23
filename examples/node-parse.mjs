// Node parsing example: metadata + pixel data access.
// Run from the repo root: node examples/node-parse.mjs <file.dcm>
import { readFileSync } from 'node:fs';
import { parse, nativePixelDataView } from '@ubercode/dicom-parser';

const path = process.argv[2] ?? 'testImages/CT1_UNC.explicit_little_endian.dcm';
const result = parse(new Uint8Array(readFileSync(path)));

if (!result.ok) {
    console.error(`parse failed: [${result.error?.code}] ${result.error?.message}`);
    console.error(`salvaged ${result.dataSet.elements.size} elements before the failure`);
}

console.log('transfer syntax :', result.transferSyntax);
console.log('modality        :', result.dataSet.string('x00080060'));
console.log('patient         :', result.dataSet.string('x00100010'));
console.log('rows × columns  :', result.dataSet.uint16('x00280010'), '×', result.dataSet.uint16('x00280011'));
console.log('warnings        :', result.warnings.length);

const pixelData = result.dataSet.element('x7fe00010');
if (pixelData?.kind === 'encapsulated') {
    console.log('encapsulated    :', pixelData.fragments.length, 'fragments,', pixelData.basicOffsetTable.length, 'BOT entries');
} else if (pixelData?.kind === 'value') {
    const view = nativePixelDataView(result.dataSet);
    console.log('native pixels   :', view?.constructor.name, view?.length, 'samples');
}
