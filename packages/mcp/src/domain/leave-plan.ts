import { availableBalance, roundDays } from "./balance.js";
import { assertPlainDate, expandRange, rangeContains, type DateRange, type PlainDate } from "./dates.js";
import { buildFormValues, timeToMinutes, validateFormValues, type FormIssue, type FormSchema } from "./forms.js";
import { classifyDate, indexCalendar, type CalendarDay, type DayKind } from "./holidays.js";
import type { LeaveBalance, LeaveCategory, LeaveRequest, LeaveType, LeaveUnit, TimeRange } from "./types.js";

export interface LeavePlanInput {
  dates?: PlainDate[];
  range?: DateRange;
  /** Leave type id, or its exact name. */
  leaveType: string;
  /** Hourly leave only: the hours off on each date. */
  time?: TimeRange;
  reason?: string;
  /** Values for company-defined fields, keyed by field name or label. */
  fields?: Record<string, string>;
  /** File for dates before today. Off unless asked for. */
  allowPast?: boolean;
}

export interface LeavePlanContext {
  today: PlainDate;
  leaveTypes: LeaveType[];
  balances: LeaveBalance[];
  requests: LeaveRequest[];
  calendar: CalendarDay[];
  form: FormSchema;
}

export type SkipReason = "past_date" | "weekend" | "national_holiday" | "company_holiday" | "already_requested";

export interface PlanDay {
  date: PlainDate;
  decision: "file" | "skip";
  dayKind: DayKind;
  skipReason?: SkipReason;
  /** Holiday name, or the id of the request already covering the day. */
  detail?: string;
}

export interface BalancePreview {
  key: string;
  category: LeaveCategory;
  /** False when Jobcan reports no balance for the leave type, so nothing is checked. */
  tracked: boolean;
  remaining?: number;
  pending?: number;
  available?: number;
  cost: number;
  after?: number;
}

/** Ways forward when the balance is short. The user chooses; nothing here is applied. */
export type PlanOption =
  | { kind: "fewer_dates"; maxDates: number }
  | {
      kind: "other_leave_type";
      leaveTypeId: string;
      name: string;
      unit: LeaveUnit;
      cost: number;
      /** Undefined when the type's balance is not tracked. */
      available?: number;
    };

export type LeavePlanStatus = "ready" | "nothing_to_file" | "insufficient_balance" | "needs_input" | "invalid";

/** Where the plan's reason came from. Anything but `given` must be shown to the user before filing. */
export type ReasonSource = "given" | "history" | "default";

export interface LeavePlan {
  status: LeavePlanStatus;
  leaveType?: LeaveType;
  time?: TimeRange;
  reason?: string;
  reasonSource?: ReasonSource;
  fields?: Record<string, string>;
  /** Unique dates asked for. */
  requestedCount: number;
  days: PlanDay[];
  toFile: PlainDate[];
  /** Dates that appeared more than once in the input. */
  duplicates: PlainDate[];
  /** Balance used per date filed. */
  costPerDate: number;
  balance?: BalancePreview;
  options: PlanOption[];
  /** Required form fields with no value yet. Ask the user for these. */
  missingFields: FormIssue[];
  problems: string[];
  formFingerprint: string;
}

/** Used when the form insists on a reason, the user gave none, and their history has none either. */
export const DEFAULT_REASON = "私用のため";

const HALF_DAYS: LeaveUnit[] = ["half_day_am", "half_day_pm"];

/** A morning and an afternoon half day can share a date. Anything else collides. */
export function unitsConflict(a: LeaveUnit, b: LeaveUnit): boolean {
  if (HALF_DAYS.includes(a) && HALF_DAYS.includes(b)) return a === b;
  return true;
}

function timesOverlap(a: TimeRange, b: TimeRange): boolean {
  const [aStart, aEnd, bStart, bEnd] = [a.start, a.end, b.start, b.end].map(timeToMinutes);
  if ([aStart, aEnd, bStart, bEnd].some((m) => m === undefined)) return true;
  return aStart! < bEnd! && bStart! < aEnd!;
}

const isActive = (r: LeaveRequest) => r.status === "pending" || r.status === "approved";

/**
 * The request already on a date that a new one would collide with. Two hourly requests
 * only collide when their hours overlap; when either side's hours are unknown they are
 * assumed to.
 */
export function findConflict(requests: LeaveRequest[], date: PlainDate, unit: LeaveUnit, time?: TimeRange): LeaveRequest | undefined {
  return requests.find((r) => {
    if (!isActive(r) || !rangeContains(r, date)) return false;
    if (r.unit === "hourly" && unit === "hourly") return !r.time || !time || timesOverlap(r.time, time);
    return unitsConflict(r.unit, unit);
  });
}

export function resolveLeaveType(leaveTypes: LeaveType[], idOrName: string): LeaveType | undefined {
  return leaveTypes.find((t) => t.id === idOrName) ?? leaveTypes.find((t) => t.name === idOrName);
}

function collectDates(input: LeavePlanInput): { unique: PlainDate[]; duplicates: PlainDate[] } {
  const all = [...(input.dates ?? []).map(assertPlainDate), ...(input.range ? expandRange(input.range) : [])];
  const seen = new Set<PlainDate>();
  const duplicates = new Set<PlainDate>();
  for (const d of all) (seen.has(d) ? duplicates : seen).add(d);
  return { unique: [...seen].sort(), duplicates: [...duplicates].sort() };
}

/** Minutes of an hourly request, or the problem with it. */
function hourlyMinutes(type: LeaveType, time: TimeRange | undefined): { minutes: number } | { problem: string } | { missing: true } {
  if (!type.minutesPerDay) return { problem: `Jobcan did not say how many minutes make a day for "${type.name}"` };
  if (!time) return { missing: true };
  const [start, end] = [timeToMinutes(time.start), timeToMinutes(time.end)];
  if (start === undefined || end === undefined) return { problem: `Time must be HH:MM to HH:MM, got ${time.start} to ${time.end}` };
  if (end <= start) return { problem: `Time must end after it starts, got ${time.start} to ${time.end}` };
  if (end - start > type.minutesPerDay) return { problem: `Time is longer than a day (${type.minutesPerDay} minutes): ${time.start} to ${time.end}` };
  return { minutes: end - start };
}

function planDay(date: PlainDate, type: LeaveType, input: LeavePlanInput, ctx: LeavePlanContext, calendar: Map<PlainDate, CalendarDay>): PlanDay {
  const day = classifyDate(date, calendar.get(date));
  const skip = (skipReason: SkipReason, detail?: string): PlanDay => ({
    date,
    decision: "skip",
    dayKind: day.kind,
    skipReason,
    ...(detail ? { detail } : {}),
  });

  if (date < ctx.today && !input.allowPast) return skip("past_date");
  if (day.kind !== "workday") return skip(day.kind, day.name);
  const conflict = findConflict(ctx.requests, date, type.unit, input.time);
  if (conflict) return skip("already_requested", conflict.id);
  return { date, decision: "file", dayKind: day.kind };
}

function previewBalance(type: LeaveType, costPerDate: number, dateCount: number, ctx: LeavePlanContext): BalancePreview {
  const cost = roundDays(dateCount * costPerDate);
  const key = type.balanceKey;
  const balance = ctx.balances.find((b) => b.key === key);
  if (!balance) return { key, category: type.category, tracked: false, cost };
  const { remaining, pending, available } = availableBalance(balance, ctx.requests);
  const after = roundDays(available - cost);
  return { key, category: type.category, tracked: true, remaining, pending, available, cost, after };
}

function optionsWhenShort(type: LeaveType, costPerDate: number, toFile: PlainDate[], available: number, ctx: LeavePlanContext): PlanOption[] {
  const options: PlanOption[] = [];

  const maxDates = costPerDate > 0 ? Math.floor(available / costPerDate) : 0;
  if (maxDates >= 1) options.push({ kind: "fewer_dates", maxDates });

  for (const other of ctx.leaveTypes) {
    if (other.id === type.id || other.unit === "hourly") continue;
    if (toFile.some((d) => findConflict(ctx.requests, d, other.unit))) continue;
    const preview = previewBalance(other, other.days, toFile.length, ctx);
    if (preview.tracked && preview.after! < 0) continue;
    options.push({
      kind: "other_leave_type",
      leaveTypeId: other.id,
      name: other.name,
      unit: other.unit,
      cost: preview.cost,
      ...(preview.tracked ? { available: preview.available } : {}),
    });
  }
  return options;
}

/** Whether the form insists on a reason for this leave type. */
function reasonRequired(form: FormSchema, type: LeaveType): boolean {
  const field = form.fields.find((f) => f.role === "reason");
  if (!field?.required) return false;
  return !field.onlyWhen || field.onlyWhen.in.includes(type.id);
}

/**
 * A reason the user did not give: the one they last used for this leave type, then for
 * any leave, then a stock phrase. Only used when the form insists on one.
 */
export function suggestReason(type: LeaveType, requests: LeaveRequest[]): { reason: string; source: ReasonSource } {
  const withReason = requests
    .filter((r) => r.reason && r.status !== "rejected")
    .sort((a, b) => (b.requestedOn ?? "").localeCompare(a.requestedOn ?? "") || Number(b.id) - Number(a.id));
  const same = withReason.find((r) => r.leaveTypeId === type.id) ?? withReason.find((r) => r.category === type.category);
  const any = withReason[0];
  const pick = same ?? any;
  return pick ? { reason: pick.reason!, source: "history" } : { reason: DEFAULT_REASON, source: "default" };
}

/**
 * Works out what a leave request would do, without doing it. Pure: the same input and
 * context always give the same plan.
 */
export function planLeaveRequest(input: LeavePlanInput, ctx: LeavePlanContext): LeavePlan {
  const base = {
    time: input.time,
    reason: input.reason,
    reasonSource: (input.reason !== undefined ? "given" : undefined) as ReasonSource | undefined,
    fields: input.fields,
    requestedCount: 0,
    days: [] as PlanDay[],
    toFile: [] as PlainDate[],
    duplicates: [] as PlainDate[],
    costPerDate: 0,
    options: [] as PlanOption[],
    missingFields: [] as FormIssue[],
    formFingerprint: ctx.form.fingerprint,
  };
  const invalid = (problem: string, extra: Partial<LeavePlan> = {}): LeavePlan => ({
    ...base,
    ...extra,
    status: "invalid",
    problems: [problem],
  });

  const type = resolveLeaveType(ctx.leaveTypes, input.leaveType);
  if (!type) return invalid(`Unknown leave type "${input.leaveType}"`);

  let costPerDate = type.days;
  let timeMissing = false;
  if (type.unit === "hourly") {
    const hours = hourlyMinutes(type, input.time);
    if ("problem" in hours) return invalid(hours.problem, { leaveType: type });
    if ("missing" in hours) timeMissing = true;
    else costPerDate = hours.minutes / type.minutesPerDay!;
  } else if (input.time) {
    return invalid(`"${type.name}" is not hourly leave, so it takes no time range`, { leaveType: type });
  }

  let collected: ReturnType<typeof collectDates>;
  try {
    collected = collectDates(input);
  } catch (err) {
    return invalid((err as Error).message, { leaveType: type });
  }
  const { unique, duplicates } = collected;
  if (unique.length === 0) return invalid("No dates given", { leaveType: type });

  const calendar = indexCalendar(ctx.calendar);
  const days = unique.map((date) => planDay(date, type, input, ctx, calendar));
  const toFile = days.filter((d) => d.decision === "file").map((d) => d.date);
  const plan = { ...base, leaveType: type, requestedCount: unique.length, days, toFile, duplicates, costPerDate };

  if (toFile.length === 0) return { ...plan, status: "nothing_to_file", problems: [] };

  const balance = previewBalance(type, costPerDate, toFile.length, ctx);
  const short = balance.tracked && balance.after! < 0;
  const options = short ? optionsWhenShort(type, costPerDate, toFile, balance.available!, ctx) : [];

  let reason = input.reason;
  let reasonSource = base.reasonSource;
  if (reason === undefined && reasonRequired(ctx.form, type)) ({ reason, source: reasonSource } = suggestReason(type, ctx.requests));

  const values = buildFormValues(ctx.form, {
    leaveTypeId: type.id,
    date: toFile[0]!,
    time: input.time,
    reason,
    fields: input.fields,
  });
  const issues = validateFormValues(ctx.form, values);
  const missingFields = issues.filter((i) => i.kind === "missing_required");
  const formAsksForTime = ctx.form.fields.some((f) => f.role === "start_time" || f.role === "end_time");
  if (timeMissing && !formAsksForTime) {
    missingFields.push({ kind: "missing_required", field: "time", label: "Time", message: `"${type.name}" needs a start and end time` });
  }
  const problems = issues.filter((i) => i.kind !== "missing_required").map((i) => i.message);

  const status: LeavePlanStatus =
    problems.length > 0 ? "invalid" : short ? "insufficient_balance" : missingFields.length > 0 ? "needs_input" : "ready";

  return { ...plan, reason, reasonSource, status, balance, options, missingFields, problems };
}
