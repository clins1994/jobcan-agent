/**
 * Calendar dates as plain `YYYY-MM-DD` strings.
 *
 * Leave is filed for calendar days, not instants, so nothing here goes through a
 * local-timezone `Date`. Arithmetic uses UTC epoch days, which have no DST.
 */
export type PlainDate = string;

/** `YYYY-MM` */
export type PlainMonth = string;

export interface DateRange {
  from: PlainDate;
  to: PlainDate;
}

export class InvalidDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDateError";
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Longest range `expandRange` accepts. A guard against typos like a wrong year. */
export const MAX_RANGE_DAYS = 366;

export const DEFAULT_TIME_ZONE = "Asia/Tokyo";

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isPlainDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function assertPlainDate(value: string): PlainDate {
  if (!isPlainDate(value)) throw new InvalidDateError(`Not a valid date (expected YYYY-MM-DD): "${value}"`);
  return value;
}

export function toParts(date: PlainDate): { year: number; month: number; day: number } {
  assertPlainDate(date);
  return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) };
}

export function fromParts(year: number, month: number, day: number): PlainDate {
  return assertPlainDate(`${pad(year, 4)}-${pad(month)}-${pad(day)}`);
}

function toEpochDay(date: PlainDate): number {
  const { year, month, day } = toParts(date);
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

function fromEpochDay(epochDay: number): PlainDate {
  const d = new Date(epochDay * MS_PER_DAY);
  return fromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function addDays(date: PlainDate, days: number): PlainDate {
  return fromEpochDay(toEpochDay(date) + days);
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export function daysBetween(from: PlainDate, to: PlainDate): number {
  return toEpochDay(to) - toEpochDay(from);
}

/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(date: PlainDate): number {
  const { year, month, day } = toParts(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function isWeekend(date: PlainDate): boolean {
  const dow = dayOfWeek(date);
  return dow === 0 || dow === 6;
}

/** Every calendar day from `from` to `to`, inclusive. */
export function expandRange(range: DateRange): PlainDate[] {
  const span = daysBetween(range.from, range.to);
  if (span < 0) throw new InvalidDateError(`Range ends before it starts: ${range.from} to ${range.to}`);
  if (span >= MAX_RANGE_DAYS) {
    throw new InvalidDateError(`Range is longer than ${MAX_RANGE_DAYS} days: ${range.from} to ${range.to}`);
  }
  return Array.from({ length: span + 1 }, (_, i) => addDays(range.from, i));
}

export function monthOf(date: PlainDate): PlainMonth {
  assertPlainDate(date);
  return date.slice(0, 7);
}

export function monthRange(month: PlainMonth): DateRange {
  const m = MONTH_RE.exec(month);
  const [year, mon] = m ? [Number(m[1]), Number(m[2])] : [NaN, NaN];
  if (!m || mon < 1 || mon > 12) throw new InvalidDateError(`Not a valid month (expected YYYY-MM): "${month}"`);
  return { from: fromParts(year, mon, 1), to: fromParts(year, mon, daysInMonth(year, mon)) };
}

export function rangeContains(range: DateRange, date: PlainDate): boolean {
  return range.from <= date && date <= range.to;
}

/** The calendar date at `now` in the given timezone. Jobcan runs on Japan time. */
export function todayIn(timeZone: string = DEFAULT_TIME_ZONE, now: Date = new Date()): PlainDate {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return assertPlainDate(`${get("year")}-${get("month")}-${get("day")}`);
}
