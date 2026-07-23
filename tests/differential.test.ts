import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import legacyParser from 'dicom-parser';
import { parseDicom, type DataSet as CompatDataSet, type Element as CompatElement } from '../src/compat';

// Verification oracle #2 (PLAN.md §6): the whole dcmtk.js sample corpus parsed
// by the fork's compat façade vs dicom-parser@1.8.21, tag-for-tag, except
// where the fork deliberately fixes upstream. Runs only where the sibling
// corpus exists (this repo never copies it — size/PHI hygiene); skipped in CI.

const CORPUS = 'C:\\Users\\mhobb\\WebstormProjects\\dcmtk.js\\dicomSamples';
const hasCorpus = existsSync(CORPUS);

function collectFiles(): string[] {
    const files: string[] = [];
    const queue = [CORPUS];
    while (queue.length > 0) {
        const dir = queue.pop() as string;
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) {
                if (entry !== 'bad') {
                    queue.push(path);
                }
            } else {
                files.push(path);
            }
        }
    }
    return files;
}

interface LegacyElement {
    tag: string;
    vr?: string;
    length: number;
    dataOffset: number;
    hadUndefinedLength?: boolean;
    items?: unknown[];
    fragments?: unknown[];
}

interface LegacyDataSet {
    elements: Record<string, LegacyElement>;
    byteArray: Uint8Array;
    string(tag: string): string | undefined;
    uint16(tag: string): number | undefined;
}

/** Tags whose value the fork must reproduce identically (common metadata). */
const VALUE_TAGS = ['x00080016', 'x00080018', 'x00080060', 'x0020000d', 'x0020000e', 'x00080050'];

function compareFile(bytes: Uint8Array): void {
    let legacy: LegacyDataSet;
    try {
        legacy = (legacyParser as unknown as { parseDicom(b: Uint8Array): LegacyDataSet }).parseDicom(bytes);
    } catch {
        // legacy failed (e.g. UV derailment, #281) — the fork must still parse
        const fork = parseDicom(bytes);
        expect(Object.keys(fork.elements).length).toBeGreaterThan(0);
        return;
    }
    const fork: CompatDataSet = parseDicom(bytes);
    const legacyKeys = Object.keys(legacy.elements)
        .filter(k => !k.startsWith('xfffe'))
        .sort();
    const forkKeys = Object.keys(fork.elements)
        .filter(k => !k.startsWith('xfffe'))
        .sort();
    expect(forkKeys).toEqual(legacyKeys);
    for (const key of legacyKeys) {
        compareElement(legacy.elements[key] as LegacyElement, fork.elements[key] as CompatElement, key);
    }
    compareValues(legacy, fork);
}

function isLeafElement(el: { items?: unknown; fragments?: unknown; hadUndefinedLength?: boolean }): boolean {
    return el.items === undefined && el.fragments === undefined && el.hadUndefinedLength !== true;
}

function compareElement(legacyEl: LegacyElement, forkEl: CompatElement, key: string): void {
    if (legacyEl.vr !== undefined && forkEl.vr !== undefined) {
        expect(forkEl.vr, `vr of ${key}`).toBe(legacyEl.vr);
    }
    // defined-length leaf elements must agree exactly on the value range
    if (isLeafElement(legacyEl) && isLeafElement(forkEl)) {
        expect(forkEl.dataOffset, `dataOffset of ${key}`).toBe(legacyEl.dataOffset);
        expect(forkEl.length, `length of ${key}`).toBe(legacyEl.length);
    }
    if (legacyEl.fragments !== undefined) {
        expect(forkEl.fragments?.length, `fragment count of ${key}`).toBe(legacyEl.fragments.length);
    }
}

function compareValues(legacy: LegacyDataSet, fork: CompatDataSet): void {
    for (const tag of VALUE_TAGS) {
        if (legacy.elements[tag] !== undefined && legacy.elements[tag].hadUndefinedLength !== true) {
            expect(fork.string(tag), `string(${tag})`).toBe(legacy.string(tag));
        }
    }
    const legacyRows = legacy.uint16('x00280010');
    if (legacyRows !== undefined) {
        expect(fork.uint16('x00280010')).toBe(legacyRows);
    }
}

describe.skipIf(!hasCorpus)('differential: fork compat vs dicom-parser@1.8.21 (dcmtk.js corpus)', () => {
    const files = hasCorpus ? collectFiles() : [];

    it('found the full corpus', () => {
        expect(files.length).toBeGreaterThanOrEqual(198);
    });

    it.each(files.map(f => [f.slice(CORPUS.length + 1)]))('%s', relative => {
        compareFile(new Uint8Array(readFileSync(join(CORPUS, relative))));
    });
});
