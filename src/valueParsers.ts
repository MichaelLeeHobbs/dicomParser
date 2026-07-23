/**
 * Value parsers for the DA, TM and PN string VRs.
 *
 * Ported from legacy `util/parseDA`, `util/parseTM` and `util/parsePN`, with
 * typed {@link DicomError}s replacing thrown strings.
 *
 * @module valueParsers
 */

import { DicomError } from './errors';

/** A parsed DA (date) value. */
export interface DicomDate {
    readonly year: number;
    readonly month: number;
    readonly day: number;
}

/** A parsed TM (time) value; fields absent from the string are `undefined`. */
export interface DicomTime {
    readonly hours: number;
    readonly minutes: number | undefined;
    readonly seconds: number | undefined;
    readonly fractionalSeconds: number | undefined;
}

/** A parsed PN (person name) value; absent components are `undefined`. */
export interface PersonName {
    readonly familyName: string | undefined;
    readonly givenName: string | undefined;
    readonly middleName: string | undefined;
    readonly prefix: string | undefined;
    readonly suffix: string | undefined;
}

function daysInMonth(month: number, year: number): number {
    if (month === 2) {
        return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
    }
    if (month === 4 || month === 6 || month === 9 || month === 11) {
        return 30;
    }
    return 31;
}

function isValidDate(year: number, month: number, day: number): boolean {
    return !Number.isNaN(year) && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(month, year);
}

/**
 * Parses a DA (YYYYMMDD) string.
 *
 * @param date - The DA string
 * @param validate - When `true`, throw on invalid input instead of returning it
 * @returns The parsed date, or `undefined` when the string is not 8 characters
 * @throws DicomError `invalid-argument` when `validate` is set and the date is invalid
 */
export function parseDA(date: string | undefined, validate = false): DicomDate | undefined {
    if (date === undefined || date.length !== 8) {
        if (validate) {
            throw new DicomError('invalid-argument', `parseDA: invalid DA '${String(date)}'`);
        }
        return undefined;
    }
    const year = Number.parseInt(date.substring(0, 4), 10);
    const month = Number.parseInt(date.substring(4, 6), 10);
    const day = Number.parseInt(date.substring(6, 8), 10);
    if (validate && !isValidDate(year, month, day)) {
        throw new DicomError('invalid-argument', `parseDA: invalid DA '${date}'`);
    }
    return { year, month, day };
}

/** `true` when the component is absent or a number in `[0, max]` (NaN fails). */
function componentInRange(value: number | undefined, max: number): boolean {
    return value === undefined || (value >= 0 && value <= max);
}

function validateTM(time: string, parsed: DicomTime): void {
    const valid =
        componentInRange(parsed.hours, 23) &&
        componentInRange(parsed.minutes, 59) &&
        componentInRange(parsed.seconds, 59) &&
        componentInRange(parsed.fractionalSeconds, 999999);
    if (!valid) {
        throw new DicomError('invalid-argument', `parseTM: invalid TM '${time}'`);
    }
}

/**
 * Parses a TM (HHMMSS.FFFFFF) string. Missing components are `undefined`;
 * fractional seconds are normalized to microseconds.
 *
 * @param time - The TM string
 * @param validate - When `true`, throw on invalid input instead of returning it
 * @returns The parsed time, or `undefined` for strings shorter than 2 characters
 * @throws DicomError `invalid-argument` when `validate` is set and the time is invalid
 */
export function parseTM(time: string | undefined, validate = false): DicomTime | undefined {
    if (time === undefined || time.length < 2) {
        if (validate) {
            throw new DicomError('invalid-argument', `parseTM: invalid TM '${String(time)}'`);
        }
        return undefined;
    }
    const hours = Number.parseInt(time.substring(0, 2), 10);
    const minutes = time.length >= 4 ? Number.parseInt(time.substring(2, 4), 10) : undefined;
    const seconds = time.length >= 6 ? Number.parseInt(time.substring(4, 6), 10) : undefined;
    const fractionalStr = time.length >= 8 ? time.substring(7, 13) : undefined;
    const fractionalSeconds = fractionalStr === undefined ? undefined : Number.parseInt(fractionalStr, 10) * Math.pow(10, 6 - fractionalStr.length);
    const parsed: DicomTime = { hours, minutes, seconds, fractionalSeconds };
    if (validate) {
        validateTM(time, parsed);
    }
    return parsed;
}

/**
 * Parses a PN string into its caret-separated components.
 *
 * @param personName - The PN string (a single component group)
 * @returns The parsed name, or `undefined` when the input is `undefined`
 */
export function parsePN(personName: string | undefined): PersonName | undefined {
    if (personName === undefined) {
        return undefined;
    }
    const values = personName.split('^');
    return {
        familyName: values[0],
        givenName: values[1],
        middleName: values[2],
        prefix: values[3],
        suffix: values[4],
    };
}
