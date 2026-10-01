import holidayJp from "@holiday-jp/holiday_jp";
import { assertPlainDate, isWeekend, type PlainDate } from "./dates.js";

/** One day as Jobcan's own calendar reports it. */
export interface CalendarDay {
  date: PlainDate;
  isWorkday: boolean;
  /** Jobcan's label for a non-workday, verbatim (e.g. 法定休日, 公休). */
  label?: string;
}

export type DayKind = "workday" | "weekend" | "national_holiday" | "company_holiday";

export interface DayClassification {
  date: PlainDate;
  kind: DayKind;
  isWorkday: boolean;
  /** Holiday name, or Jobcan's label for a company holiday. */
  name?: string;
  /** `jobcan` when Jobcan's calendar decided; `fallback` when it had no data for the day. */
  source: "jobcan" | "fallback";
}

export interface NationalHoliday {
  date: PlainDate;
  name: string;
  nameEn: string;
}

const NATIONAL_HOLIDAYS = holidayJp.holidays as Record<
  string,
  { date: string; name: string; name_en: string } | undefined
>;

/** Looked up by date string, so the machine's timezone never matters. */
export function nationalHoliday(date: PlainDate): NationalHoliday | undefined {
  const h = NATIONAL_HOLIDAYS[assertPlainDate(date)];
  return h && { date: h.date, name: h.name, nameEn: h.name_en };
}

/**
 * Jobcan's calendar is the source of truth for whether a day is a workday. The weekend
 * and national-holiday tables only explain why a day is off, and stand in when Jobcan
 * has no data for it.
 */
export function classifyDate(date: PlainDate, calendarDay?: CalendarDay): DayClassification {
  const holiday = nationalHoliday(date);
  const source = calendarDay ? "jobcan" : "fallback";

  if (calendarDay?.isWorkday) return { date, kind: "workday", isWorkday: true, source };
  if (holiday) return { date, kind: "national_holiday", isWorkday: false, name: holiday.name, source };
  if (isWeekend(date)) return { date, kind: "weekend", isWorkday: false, source };
  if (calendarDay) {
    return { date, kind: "company_holiday", isWorkday: false, name: calendarDay.label, source };
  }
  return { date, kind: "workday", isWorkday: true, source };
}

export function indexCalendar(days: CalendarDay[]): Map<PlainDate, CalendarDay> {
  return new Map(days.map((d) => [d.date, d]));
}
