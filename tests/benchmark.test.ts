import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import legacyParser from 'dicom-parser';
import { parse } from '../src/parse';
import { parseDicom } from '../src/compat';

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

    it('core parse stays within the absolute budget', () => {
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

    it.skipIf(process.env['CI'] !== undefined)('compat façade is not slower than dicom-parser@1.8.21 (local gate)', () => {
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
