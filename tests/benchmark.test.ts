import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import legacyParser from 'dicom-parser';
import { parse } from '../src/parse';
import { parseDicom } from '../src/compat';
import { TS, evenPad, explicitEl, p10 } from './helpers/p10';

// Phase 5 performance gate (PLAN.md §6.5, upstream #54/#56 done properly):
// bulk parsing must be at least on par with dicom-parser@1.8.21. The strict
// comparison runs outside CI (shared runners are too noisy); CI enforces an
// absolute sanity budget instead. Recorded baselines: docs/benchmark.md.

const IMAGES = join(__dirname, '..', 'testImages');

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] as number;
}

function bench(run: () => void, iterations: number): number {
    // warmup
    for (let i = 0; i < 10; i++) {
        run();
    }
    const times: number[] = [];
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        run();
        times.push(performance.now() - start);
    }
    return median(times);
}

describe('benchmark: bulk parse', () => {
    const files = [
        new Uint8Array(readFileSync(join(IMAGES, 'CT1_UNC.explicit_little_endian.dcm'))),
        new Uint8Array(readFileSync(join(IMAGES, 'CT1_UNC.implicit_little_endian.dcm'))),
        new Uint8Array(readFileSync(join(IMAGES, 'encapsulated', 'single-frame', 'CT1_UNC.fragmented_bot_jpeg_ls.80.dcm'))),
    ];

    // Timing assertions are unreliable under CI runners and v8 coverage
    // instrumentation (which slows execution several-fold), so the budget checks
    // run only under `pnpm run bench` (which sets BENCH=1). Correctness on these
    // files is covered by tests/fixtures.test.ts; this is a regression tripwire.
    it.skipIf(process.env['BENCH'] === undefined)('core parse stays within the absolute budget', () => {
        const perFile = bench(() => {
            for (const file of files) {
                const result = parse(file);
                if (result.error !== undefined) {
                    throw result.error;
                }
            }
        }, 50);
        // 3 CT files ≈ 1.2 MB total; anything near 50ms would be a regression
        expect(perFile).toBeLessThan(50);
    });

    it.skipIf(process.env['BENCH'] === undefined)('compat façade is not slower than dicom-parser@1.8.21 (local gate)', () => {
        const legacy = legacyParser as unknown as { parseDicom(bytes: Uint8Array): unknown };
        const legacyTime = bench(() => {
            for (const file of files) {
                legacy.parseDicom(file);
            }
        }, 100);
        const forkTime = bench(() => {
            for (const file of files) {
                parseDicom(file);
            }
        }, 100);
        console.error(`benchmark: legacy=${legacyTime.toFixed(3)}ms fork-compat=${forkTime.toFixed(3)}ms (median of 100, 3 files)`);
        // allow 25% noise margin on top of parity
        expect(forkTime).toBeLessThan(legacyTime * 1.25);
    });
});

// The dominant production workload is header extraction, not full-file parsing:
// `parseDicom(bytes, { untilTag: PixelData })` / `parse(bytes, { stopAt })` on
// every C-STORE, where the ~512 KB pixel payload is never read. The bulk bench
// above is a single O(1) seek over that payload, so it says nothing about the hot
// path — this exercises header-dense tokenization + the stopAt short-circuit
// (review D5). Fixture built here because the repo has no header-dense file.
describe('benchmark: header-only (stopAt / untilTag)', () => {
    const PIXEL_DATA = 'x7fe00010';

    function headerDenseFile(elementCount = 400): Uint8Array {
        const elements: Uint8Array[] = [];
        for (let i = 0; i < elementCount; i++) {
            elements.push(explicitEl(`0009${(0x1000 + i).toString(16).padStart(4, '0')}`, 'LO', evenPad(`value-${i}`)));
        }
        elements.push(explicitEl('7FE00010', 'OW', new Uint8Array(512 * 1024)));
        return p10(TS.explicitLE, elements);
    }

    it.skipIf(process.env['BENCH'] === undefined)('stopAt short-circuits the pixel payload and stays on par with legacy untilTag', () => {
        const file = headerDenseFile();
        const legacy = legacyParser as unknown as { parseDicom(bytes: Uint8Array, options: { untilTag: string }): unknown };
        const coreHeader = bench(() => {
            const result = parse(file, { stopAt: { tag: PIXEL_DATA, inclusive: false } });
            if (result.error !== undefined) {
                throw result.error;
            }
        }, 200);
        const coreFull = bench(() => {
            const result = parse(file);
            if (result.error !== undefined) {
                throw result.error;
            }
        }, 200);
        const compatHeader = bench(() => parseDicom(file, { untilTag: PIXEL_DATA }), 200);
        const legacyHeader = bench(() => legacy.parseDicom(file, { untilTag: PIXEL_DATA }), 200);
        console.error(
            `benchmark header-only: core-stopAt=${coreHeader.toFixed(4)}ms core-full=${coreFull.toFixed(4)}ms ` +
                `compat-untilTag=${compatHeader.toFixed(4)}ms legacy-untilTag=${legacyHeader.toFixed(4)}ms (median of 200)`
        );
        // The payload is one O(1)-seek element, so stopAt ≈ full here; the cost is
        // header-dense tokenization. The meaningful gate is fork vs legacy on that:
        // core parse is on par or better than legacy's untilTag...
        expect(coreHeader).toBeLessThan(legacyHeader * 1.25);
        // ...and the compat façade — which also converts to v1 shapes — stays
        // within a documented margin (adopt core on the hot path; see migration-v1).
        expect(compatHeader).toBeLessThan(legacyHeader * 1.75);
    });
});
