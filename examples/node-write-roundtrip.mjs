// Node writing example: build a file, parse it back, modify, round-trip.
// Run from the repo root: node examples/node-write-roundtrip.mjs
import { parse, writeFile, serializeParsed, modifyDataSet, dataSet, element, item } from '@ubercode/dicom-parser';

const file = writeFile({
    dataSet: dataSet([
        element('00080016', 'UI', '1.2.840.10008.5.1.4.1.1.7'),
        element('00080018', 'UI', '1.2.826.0.1.3680043.10.1561.1'),
        element('00080060', 'CS', 'OT'),
        element('00100010', 'PN', 'Example^Patient'),
        element('00081140', 'SQ', [item([element('00080100', 'SH', 'CODE')])]),
        element('00280010', 'US', [2]),
    ]),
});
console.log('wrote', file.length, 'bytes');

const parsed = parse(file);
console.log('round-trip byte-identical:', Buffer.from(serializeParsed(parsed)).equals(Buffer.from(file)));

const edited = writeFile({ dataSet: modifyDataSet(parsed.dataSet, { set: [element('00100010', 'PN', 'Renamed^Patient')] }) });
console.log('edited patient:', parse(edited).dataSet.string('x00100010'));
