import { assertPlainDate, expandRange, monthRange, rangeContains, type DateRange, type PlainDate, type PlainMonth } from "./dates.js";
import { timeToMinutes } from "./forms.js";
import { classifyDate, type DayKind } from "./holidays.js";
import type { AttendanceRecord, AttendanceSpot, LeaveRequest, TimeRange, TimesheetDay } from "./types.js";

/**
 * Fills in attendance for days that were worked but never clocked: the same hours on
 * every workday, minus days off, days already recorded, and the part of a day covered
 * by hourly leave. Pure.
 */
export interface AttendancePlanInput {
  month?: PlainMonth;
  dates?: PlainDate[];
  range?: DateRange;
  /** `HH:MM` */
  clockIn: string;
  /** `HH:MM` */
  clockOut: string;
  /** Jobcan requires a note on every manual record. */
  note: string;
  /** Spot id or name; the company's first spot when left out. */
  spot?: string;
  /** Record today as well. Off by default, since the day is not over. */
  includeToday?: boolean;
}

export interface AttendancePlanContext {
  today: PlainDate;
  /** Jobcan's timesheet for every month the input touches. */
  timesheet: TimesheetDay[];
  requests: LeaveRequest[];
  spots: AttendanceSpot[];
}

export type AttendanceSkipReason =
  | "weekend"
  | "national_holiday"
  | "company_holiday"
  | "future"
  | "today"
  | "already_recorded"
  | "pending_approval"
  | "full_day_leave"
  | "no_timesheet";

/** What must be settled with the user before the day can be recorded. */
export type AttendanceQuestion =
  | { kind: "leave_in_the_middle"; leave: TimeRange; requestId: string }
  | { kind: "half_day_without_hours"; unit: string; requestId: string }
  | { kind: "several_hourly_leaves"; requestIds: string[] };

export interface Clocks {
  clockIn?: string;
  clockOut?: string;
}

export interface AttendancePlanDay {
  date: PlainDate;
  decision: "record" | "skip" | "ask";
  dayKind: DayKind;
  before: Clocks;
  /** What the day will show once recorded; same as `before` when skipped. */
  after: Clocks;
  skipReason?: AttendanceSkipReason;
  /** Holiday name, request id, or the hours of leave the record works around. */
  detail?: string;
  question?: AttendanceQuestion;
  record?: AttendanceRecord;
}

export type AttendancePlanStatus = "ready" | "nothing_to_record" | "needs_input" | "invalid";

export interface AttendancePlan {
  status: AttendancePlanStatus;
  hours: TimeRange;
  note: string;
  spot?: AttendanceSpot;
  days: AttendancePlanDay[];
  toRecord: AttendanceRecord[];
  problems: string[];
}

const isActive = (r: LeaveRequest) => r.status === "pending" || r.status === "approved";

const fmt = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

function collectDates(input: AttendancePlanInput): PlainDate[] {
  const all = [
    ...(input.month ? expandRange(monthRange(input.month)) : []),
    ...(input.dates ?? []).map(assertPlainDate),
    ...(input.range ? expandRange(input.range) : []),
  ];
  return [...new Set(all)].sort();
}

/**
 * The hours left to work around one hourly leave: leave at the start of the day pushes
 * the clock-in later, leave at the end pulls the clock-out earlier. Leave in the middle
 * would need two blocks, which is a question for the user.
 */
export function workAround(hours: { start: number; end: number }, leave: { start: number; end: number }): { start: number; end: number } | "covered" | "middle" {
  if (leave.end <= hours.start || leave.start >= hours.end) return hours;
  if (leave.start <= hours.start && leave.end >= hours.end) return "covered";
  if (leave.start <= hours.start) return { start: leave.end, end: hours.end };
  if (leave.end >= hours.end) return { start: hours.start, end: leave.start };
  return "middle";
}

export function planAttendance(input: AttendancePlanInput, ctx: AttendancePlanContext): AttendancePlan {
  const hours = { start: input.clockIn, end: input.clockOut };
  const base = { hours, note: input.note, days: [] as AttendancePlanDay[], toRecord: [] as AttendanceRecord[] };
  const invalid = (problem: string): AttendancePlan => ({ ...base, status: "invalid", problems: [problem] });

  const [start, end] = [timeToMinutes(input.clockIn), timeToMinutes(input.clockOut)];
  if (start === undefined || end === undefined) return invalid(`Hours must be HH:MM to HH:MM, got ${input.clockIn} to ${input.clockOut}`);
  if (end <= start) return invalid(`Hours must end after they start, got ${input.clockIn} to ${input.clockOut}`);
  if (!input.note.trim()) return invalid("Jobcan requires a note on every manual record");

  let spot: AttendanceSpot | undefined;
  if (input.spot !== undefined) {
    spot = ctx.spots.find((s) => s.id === input.spot || s.name === input.spot);
    if (!spot) return invalid(`Unknown spot "${input.spot}"; the company has: ${ctx.spots.map((s) => s.name).join(", ")}`);
  } else spot = ctx.spots[0];

  let dates: PlainDate[];
  try {
    dates = collectDates(input);
  } catch (err) {
    return invalid((err as Error).message);
  }
  if (dates.length === 0) return invalid("No dates given");

  const timesheet = new Map(ctx.timesheet.map((d) => [d.date, d]));
  const days: AttendancePlanDay[] = [];
  const problems: string[] = [];

  for (const date of dates) {
    const sheet = timesheet.get(date);
    const before: Clocks = { ...(sheet?.clockIn ? { clockIn: sheet.clockIn } : {}), ...(sheet?.clockOut ? { clockOut: sheet.clockOut } : {}) };
    const day = classifyDate(date, sheet ? { date, isWorkday: sheet.isWorkday, ...(sheet.label ? { label: sheet.label } : {}) } : undefined);
    const skip = (skipReason: AttendanceSkipReason, detail?: string): AttendancePlanDay => ({
      date,
      decision: "skip",
      dayKind: day.kind,
      before,
      after: before,
      skipReason,
      ...(detail ? { detail } : {}),
    });
    const ask = (question: AttendanceQuestion, detail: string): AttendancePlanDay => ({
      date,
      decision: "ask",
      dayKind: day.kind,
      before,
      after: before,
      question,
      detail,
    });

    if (!sheet) {
      days.push(skip("no_timesheet"));
      continue;
    }
    if (day.kind !== "workday") {
      days.push(skip(day.kind, day.name));
      continue;
    }
    if (date > ctx.today) {
      days.push(skip("future"));
      continue;
    }
    if (date === ctx.today && !input.includeToday) {
      days.push(skip("today"));
      continue;
    }
    if (before.clockIn || before.clockOut) {
      days.push(skip("already_recorded", `${before.clockIn ?? "--:--"} to ${before.clockOut ?? "--:--"}`));
      continue;
    }
    // Jobcan hides manual records from the timesheet until they are approved, but marks the day
    if (sheet.pendingApproval) {
      days.push(skip("pending_approval"));
      continue;
    }

    const leaves = ctx.requests.filter((r) => isActive(r) && rangeContains(r, date));
    const fullDay = leaves.find((r) => r.unit === "full_day" || r.unit === "partial_day");
    if (fullDay) {
      days.push(skip("full_day_leave", fullDay.id));
      continue;
    }
    const halfWithoutHours = leaves.find((r) => (r.unit === "half_day_am" || r.unit === "half_day_pm") && !r.time);
    if (halfWithoutHours) {
      days.push(ask({ kind: "half_day_without_hours", unit: halfWithoutHours.unit, requestId: halfWithoutHours.id }, `request ${halfWithoutHours.id} (${halfWithoutHours.unit})`));
      continue;
    }
    const timed = leaves.filter((r) => r.time);
    if (timed.length > 1) {
      days.push(ask({ kind: "several_hourly_leaves", requestIds: timed.map((r) => r.id) }, timed.map((r) => `${r.id}: ${r.time!.start}-${r.time!.end}`).join(", ")));
      continue;
    }

    let block: { start: number; end: number } = { start, end };
    let detail: string | undefined;
    const leave = timed[0];
    if (leave) {
      const around = workAround(block, { start: timeToMinutes(leave.time!.start)!, end: timeToMinutes(leave.time!.end)! });
      if (around === "covered") {
        days.push(skip("full_day_leave", leave.id));
        continue;
      }
      if (around === "middle") {
        days.push(ask({ kind: "leave_in_the_middle", leave: leave.time!, requestId: leave.id }, `leave ${leave.time!.start}-${leave.time!.end} splits the day`));
        continue;
      }
      block = around;
      detail = `around leave ${leave.time!.start}-${leave.time!.end} (request ${leave.id})`;
    }

    const record: AttendanceRecord = {
      date,
      clockIn: fmt(block.start),
      clockOut: fmt(block.end),
      note: input.note,
      ...(spot ? { spot: spot.id } : {}),
    };
    days.push({
      date,
      decision: "record",
      dayKind: day.kind,
      before,
      after: { clockIn: record.clockIn, clockOut: record.clockOut },
      ...(detail ? { detail } : {}),
      record,
    });
  }

  const toRecord = days.filter((d) => d.record).map((d) => d.record!);
  const asks = days.filter((d) => d.decision === "ask");
  const status: AttendancePlanStatus =
    problems.length > 0 ? "invalid" : asks.length > 0 ? "needs_input" : toRecord.length === 0 ? "nothing_to_record" : "ready";
  return { ...base, ...(spot ? { spot } : {}), status, days, toRecord, problems };
}
