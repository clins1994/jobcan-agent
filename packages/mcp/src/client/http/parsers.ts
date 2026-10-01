import { parse, type HTMLElement } from "node-html-parser";
import { fromParts, isPlainDate, type PlainDate } from "../../domain/dates.js";
import { defineForm, type FormField, type FormSchema, type TimePartsField } from "../../domain/forms.js";
import type { LeaveCategory, LeaveRequestStatus, LeaveType, LeaveUnit, TimesheetDay } from "../../domain/types.js";

/**
 * HTML in, plain data out. Pages are expected in English (the session pins the UI
 * language), and anything positional is checked so that a layout change fails loudly
 * instead of producing wrong data.
 */
export class ParseError extends Error {
  constructor(page: string, problem: string) {
    super(`Could not read Jobcan's ${page} page: ${problem}. Jobcan's layout may have changed.`);
    this.name = "ParseError";
  }
}

const clean = (text: string | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

const isTime = (text: string) => /^\d{1,2}:\d{2}$/.test(text);

function minutes(text: string): number | undefined {
  const m = /^(\d{1,3}):(\d{2})$/.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

// --- attendance ------------------------------------------------------------------

export interface BalanceRow {
  label: string;
  remainingDays: number;
}

export interface AttendancePage {
  days: TimesheetDay[];
  balances: BalanceRow[];
}

const ATTENDANCE_COLUMNS = 11;
const BALANCE_HEADING = /remaining vacations/i;

function attendanceDate(row: HTMLElement): PlainDate | undefined {
  for (const link of row.querySelectorAll("a[href]")) {
    const href = (link.getAttribute("href") ?? "").replace(/&amp;/g, "&");
    const m = /[?&]year=(\d{4})&month=(\d{1,2})&day=(\d{1,2})/.exec(href);
    if (m) return fromParts(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  return undefined;
}

export function parseAttendancePage(html: string): AttendancePage {
  const root = parse(html);

  const days: TimesheetDay[] = [];
  for (const row of root.querySelectorAll("table tbody tr")) {
    const date = attendanceDate(row);
    if (!date) continue;
    const cells = row.querySelectorAll("td").filter((td) => td.parentNode === row);
    if (cells.length !== ATTENDANCE_COLUMNS) {
      throw new ParseError("attendance", `a day has ${cells.length} columns, expected ${ATTENDANCE_COLUMNS}`);
    }
    const text = (i: number) => clean(cells[i]!.text);
    const label = text(1);
    const day: TimesheetDay = { date, isWorkday: label === "" };
    if (label) day.label = label;
    if (/jbc-table-warning/.test(row.getAttribute("class") ?? "")) day.pendingApproval = true;
    if (isTime(text(3))) day.clockIn = text(3);
    if (isTime(text(4))) day.clockOut = text(4);
    const worked = minutes(text(5));
    if (worked !== undefined) day.workedMinutes = worked;
    const rest = minutes(text(9));
    if (rest !== undefined) day.breakMinutes = rest;
    days.push(day);
  }
  if (days.length === 0) throw new ParseError("attendance", "no days found");

  const balances: BalanceRow[] = [];
  const card = root.querySelectorAll(".card").find((c) => {
    const heading = c.querySelector(".card-header");
    return heading !== null && BALANCE_HEADING.test(heading.text) && c.querySelectorAll(".card").length === 0;
  });
  for (const row of card?.querySelectorAll("tr") ?? []) {
    const label = clean(row.querySelector("th")?.text);
    const value = Number(clean(row.querySelector("td")?.text));
    if (label && Number.isFinite(value)) balances.push({ label, remainingDays: value });
  }
  return { days: days.sort((a, b) => a.date.localeCompare(b.date)), balances };
}

// --- leave form ------------------------------------------------------------------

/** A leave type as Jobcan describes it in the request form's embedded data. */
export interface JobcanHoliday extends LeaveType {
  /** Name of the balance the type draws from, as shown on the attendance page. */
  balanceLabel: string;
}

export interface LeaveFormPage {
  holidays: JobcanHoliday[];
  form: FormSchema;
  /** The request form's hidden fields, sent back untouched with a request. */
  hidden: Record<string, string>;
  /** How many minutes of hourly leave make one day of balance. */
  hourlyLeaveDayMinutes?: number;
}

/** Pulls `var <name> = {...}` out of an inline script. The value must be JSON. */
export function extractScriptJson(html: string, name: string): unknown {
  const marker = new RegExp(`var\\s+${name}\\s*=\\s*`).exec(html);
  if (!marker) return undefined;
  const start = marker.index + marker[0].length;
  const open = html[start];
  if (open !== "{" && open !== "[") return undefined;
  const close = open === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function categoryOf(holidayType: string): LeaveCategory {
  if (holidayType === "paid" || holidayType === "compensatory" || holidayType === "substitute") return holidayType;
  return holidayType.startsWith("special") ? "special" : "other";
}

/**
 * `paid_type` as the page's own script reads it: 10 (and 0) is a full day, -1 is hourly,
 * and any other value is that many tenths of a day.
 */
function unitAndDays(raw: Record<string, string>): { unit: LeaveUnit; days: number } {
  const paidType = Number(raw.paid_type);
  if (paidType === 10 || paidType === 0) return { unit: "full_day", days: 1 };
  if (paidType === -1) return { unit: "hourly", days: 0 };
  const days = Math.round(paidType * 0.1 * 1e6) / 1e6;
  if (days !== 0.5) return { unit: "partial_day", days };
  const name = raw.name ?? "";
  if (/午前|前半|\bAM\b/i.test(name)) return { unit: "half_day_am", days };
  if (/午後|後半|\bPM\b/i.test(name)) return { unit: "half_day_pm", days };
  const startsAt = Number(raw.time_start_minutes);
  return { unit: startsAt > 0 && startsAt < 12 * 60 ? "half_day_am" : "half_day_pm", days };
}

function parseHolidays(html: string): JobcanHoliday[] {
  const data = extractScriptJson(html, "holidays");
  if (!data || typeof data !== "object") throw new ParseError("leave request", "leave type data not found");
  const order = (extractScriptJson(html, "holiday_order") ?? {}) as Record<string, string>;
  const position = new Map(Object.entries(order).map(([pos, id]) => [String(id), Number(pos)]));

  const holidays: JobcanHoliday[] = [];
  for (const [id, versions] of Object.entries(data as Record<string, Record<string, Record<string, string>>>)) {
    const raw = Object.values(versions ?? {}).at(-1);
    if (!raw?.name || !raw.holiday_type) throw new ParseError("leave request", `leave type ${id} has no name or type`);
    holidays.push({
      id: String(raw.holiday_id ?? id),
      name: raw.name,
      category: categoryOf(raw.holiday_type),
      balanceKey: raw.holiday_type,
      balanceLabel: raw.type ?? raw.holiday_type,
      ...unitAndDays(raw),
    });
  }
  if (holidays.length === 0) throw new ParseError("leave request", "no leave types found");
  const rank = (h: JobcanHoliday) => position.get(h.id) ?? Number.MAX_SAFE_INTEGER;
  return holidays.sort((a, b) => rank(a) - rank(b));
}

const partsNamed = (prefix: string) => ({ year: `${prefix}year`, month: `${prefix}month`, day: `${prefix}day` });

/**
 * The page marks the reason rule with two spans, and its script shows one or the other:
 * only "required" present means every type needs a reason; both present means every type
 * but annual paid leave does; only "optional" (or neither) means none does.
 */
function reasonRule(root: HTMLElement, holidays: JobcanHoliday[]): { required: boolean; onlyFor?: string[] } {
  const hasRequired = root.querySelector("#holiday-reason-required") !== null;
  const hasOptional = root.querySelector("#holiday-reason-optional") !== null;
  if (!hasRequired) return { required: false };
  if (!hasOptional) return { required: true };
  return { required: true, onlyFor: holidays.filter((h) => h.balanceKey !== "paid").map((h) => h.id) };
}

function timePartsField(form: HTMLElement, role: "start_time" | "end_time", hourlyIds: string[]): TimePartsField | undefined {
  const prefix = role === "start_time" ? "start" : "end";
  const hour = form.querySelector(`select[name="${prefix}[h][0]"]`);
  const minute = form.querySelector(`select[name="${prefix}[m][0]"]`);
  if (!hour || !minute) return undefined;
  const steps = minute.querySelectorAll("option").map((o) => Number(o.getAttribute("value"))).filter((v) => v > 0);
  const minuteStep = steps.length > 0 ? Math.min(...steps) : undefined;
  const hours = hour
    .querySelectorAll("option")
    .map((o) => ({ value: o.getAttribute("value") ?? "", label: clean(o.text) }))
    .filter((o) => o.value !== "" && /^\d{1,2}$/.test(o.label));
  if (hours.length === 0) throw new ParseError("leave request", `the ${prefix} hour select has no readable hours`);
  const plain = hours.every((o) => Number(o.value) === Number(o.label));
  return {
    kind: "time_parts",
    name: `${prefix}_time`,
    label: role === "start_time" ? "Start time" : "End time",
    required: true,
    role,
    parts: { hour: `${prefix}[h][0]`, minute: `${prefix}[m][0]` },
    ...(plain ? {} : { hours }),
    ...(minuteStep ? { minuteStep } : {}),
    ...(hourlyIds.length > 0 ? { onlyWhen: { field: "holiday_id[0]", in: hourlyIds } } : {}),
  };
}

export function parseLeaveFormPage(html: string): LeaveFormPage {
  const dayMinutes = Number(/var\s+hourlyLeaveDayMin\s*=\s*"?(\d+)"?/.exec(html)?.[1]);
  const holidays = parseHolidays(html).map((h) => (h.unit === "hourly" && dayMinutes > 0 ? { ...h, minutesPerDay: dayMinutes } : h));
  const root = parse(html);
  const form = root.querySelectorAll("form").find((f) => (f.getAttribute("action") ?? "").includes("/holiday/confirm"));
  if (!form) throw new ParseError("leave request", "request form not found");

  const has = (name: string) => form.querySelector(`[name="${name}"]`) !== null;
  const fields: FormField[] = [];

  const typeSelect = form.querySelectorAll("select").find((s) => /^holiday_id(\[|$)/.test(s.getAttribute("name") ?? ""));
  if (!typeSelect) throw new ParseError("leave request", "leave type field not found");
  fields.push({
    kind: "select",
    name: typeSelect.getAttribute("name")!,
    label: "Leave type",
    required: true,
    role: "leave_type",
    // the page fills this select by script, so the options come from the same data
    options: holidays.map((h) => ({ value: h.id, label: h.name })),
  });

  for (const [prefix, role, label] of [
    ["holiday_", "from_date", "From"],
    ["to_holiday_", "to_date", "To"],
  ] as const) {
    const parts = partsNamed(prefix);
    if (!Object.values(parts).every(has)) throw new ParseError("leave request", `date fields "${prefix}*" not found`);
    fields.push({ kind: "date_parts", name: `${prefix}date`, label, required: true, role, parts });
  }

  const hourlyIds = holidays.filter((h) => h.unit === "hourly").map((h) => h.id);
  for (const role of ["start_time", "end_time"] as const) {
    const field = timePartsField(form, role, hourlyIds);
    if (field) fields.push(field);
    else if (hourlyIds.length > 0) throw new ParseError("leave request", `${role.replace("_", " ")} fields not found`);
  }

  const reason = form.querySelector("textarea");
  if (reason?.getAttribute("name")) {
    const maxLength = Number(reason.getAttribute("maxlength"));
    const rule = reasonRule(root, holidays);
    fields.push({
      kind: "textarea",
      name: reason.getAttribute("name")!,
      label: "Reason",
      required: rule.required || reason.hasAttribute("required"),
      role: "reason",
      ...(Number.isFinite(maxLength) && maxLength > 0 ? { maxLength } : {}),
      ...(rule.onlyFor ? { onlyWhen: { field: typeSelect.getAttribute("name")!, in: rule.onlyFor } } : {}),
    });
  }
  const hidden: Record<string, string> = {};
  for (const input of form.querySelectorAll('input[type="hidden"]')) {
    const name = input.getAttribute("name");
    if (name) hidden[name] = input.getAttribute("value") ?? "";
  }
  return {
    holidays,
    form: defineForm("leave", fields),
    hidden,
    ...(dayMinutes > 0 ? { hourlyLeaveDayMinutes: dayMinutes } : {}),
  };
}

// --- clock-edit page ---------------------------------------------------------------

export interface ClockEditPage {
  /** The record form's hidden fields (token, ids, date), sent back untouched. */
  hidden: Record<string, string>;
  spots: { id: string; name: string }[];
  noteRequired: boolean;
}

export function parseClockEditPage(html: string): ClockEditPage {
  const root = parse(html);
  const form = root.querySelectorAll("form").find((f) => (f.getAttribute("action") ?? "").includes("/adit/insert"));
  if (!form) throw new ParseError("clock edit", "record form not found");
  const hidden: Record<string, string> = {};
  for (const input of form.querySelectorAll('input[type="hidden"]')) {
    const name = input.getAttribute("name");
    if (name) hidden[name] = input.getAttribute("value") ?? "";
  }
  if (!hidden.token) throw new ParseError("clock edit", "no token");
  for (const name of ["time", "notice"]) {
    if (!form.querySelector(`[name="${name}"]`)) throw new ParseError("clock edit", `"${name}" field not found`);
  }
  const spots = form
    .querySelectorAll('select[name="group_id"] option')
    .map((o) => ({ id: o.getAttribute("value") ?? "", name: clean(o.text) }))
    .filter((s) => s.id);
  const noteRequired = form.querySelectorAll("th, label, .jbc-title").some((el) => /notes?\s*\(required\)|備考.*必須|必須/i.test(clean(el.text)));
  return { hidden, spots, noteRequired };
}

/** The punch endpoint answers JSON: `{result: 1}` on success, `{result: 0, errors: {field: code}}` otherwise. */
export function parseRecordResult(body: string): { ok: true } | { ok: false; errors: string[] } {
  let json: { result?: number; errors?: Record<string, string> };
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, errors: ["Jobcan did not answer with a result (was the session lost?)"] };
  }
  if (json.result) return { ok: true };
  const errors = Object.entries(json.errors ?? {}).map(([field, code]) => `${field}: ${code}`);
  return { ok: false, errors: errors.length > 0 ? errors : ["Jobcan refused the record without saying why"] };
}

// --- leave review and withdraw pages ------------------------------------------------

export interface ReviewPage {
  /** The save form's fields, in order, ready to be sent back as they are. */
  saveForm: Record<string, string | string[]>;
}

/** Error texts a Jobcan page shows for a refused form. */
export function pageErrors(root: HTMLElement): string[] {
  return [...new Set(root.querySelectorAll(".jbc-text-danger, .invalid-feedback, .alert-danger, .alert").map((el) => clean(el.text)).filter(Boolean))];
}

/** The review step either returns the save form or the request form again with errors. */
export function parseReviewPage(html: string): ReviewPage | { errors: string[] } {
  const root = parse(html);
  const form = root.querySelectorAll("form").find((f) => (f.getAttribute("action") ?? "").includes("/holiday/save"));
  if (!form) {
    const errors = pageErrors(root).filter((e) => !/\(required|\(if any/i.test(e));
    return { errors: errors.length > 0 ? errors : ["Jobcan did not accept the request and gave no reason"] };
  }
  const saveForm: Record<string, string | string[]> = {};
  for (const input of form.querySelectorAll("input")) {
    const name = input.getAttribute("name");
    const type = (input.getAttribute("type") ?? "text").toLowerCase();
    if (!name || type === "button" || type === "submit") continue;
    const value = input.getAttribute("value") ?? "";
    const existing = saveForm[name];
    if (existing === undefined) saveForm[name] = name.endsWith("[]") ? [value] : value;
    else saveForm[name] = [...(Array.isArray(existing) ? existing : [existing]), value];
  }
  if (!("token" in saveForm)) return { errors: ["The review page has no token to save with"] };
  return { saveForm };
}

/** The withdraw link on the confirmation page, path and query, or undefined when the request cannot be withdrawn. */
export function parseWithdrawPage(html: string): string | undefined {
  const link = parse(html).querySelectorAll("a[href]").find((a) => /\/employee\/holiday\/delete\/?\?/.test(a.getAttribute("href") ?? ""));
  return link?.getAttribute("href")?.replace(/&amp;/g, "&");
}

// --- leave list ------------------------------------------------------------------

export interface LeaveListRow {
  id: string;
  from: PlainDate;
  to: PlainDate;
  status: LeaveRequestStatus;
  /** Jobcan's wording for the status, verbatim. */
  statusText: string;
  leaveTypeName: string;
  requestedOn?: PlainDate;
  days?: number;
  /** Set instead of `days` for hourly leave, which Jobcan shows as a time range. */
  minutes?: number;
  time?: { start: string; end: string };
  reason?: string;
}

const LEAVE_LIST_COLUMNS = 7;

/** Reads every date in a cell, whichever of Jobcan's formats it uses. */
export function datesIn(text: string): PlainDate[] {
  const found: PlainDate[] = [];
  const pattern = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})|(\d{1,2})\/(\d{1,2})\/(\d{4})/g;
  for (const m of text.matchAll(pattern)) {
    const [y, mo, d] = m[1] ? [m[1], m[2], m[3]] : [m[6], m[4], m[5]];
    const date = `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
    if (isPlainDate(date)) found.push(date);
  }
  return found;
}

export function statusOf(text: string): LeaveRequestStatus {
  if (/cancel|取消|取り消/i.test(text)) return "cancelled";
  if (/reject|却下|否認/i.test(text)) return "rejected";
  if (/unapproved|未承認/i.test(text)) return "pending";
  if (/approved|承認済/i.test(text)) return "approved";
  // anything unrecognised counts as still open, so the date stays protected
  return "pending";
}

export function parseLeaveListPage(html: string): LeaveListRow[] {
  const root = parse(html);
  const rows: LeaveListRow[] = [];

  for (const row of root.querySelectorAll("table tbody tr")) {
    const link = row.querySelector('a[href*="applied_id="]');
    if (!link) continue;
    const id = /applied_id=(\d+)/.exec(link.getAttribute("href") ?? "")?.[1];
    const cells = row.querySelectorAll("td").filter((td) => td.parentNode === row);
    if (!id) continue;
    if (cells.length !== LEAVE_LIST_COLUMNS) {
      throw new ParseError("leave list", `a request has ${cells.length} columns, expected ${LEAVE_LIST_COLUMNS}`);
    }
    const text = (i: number) => clean(cells[i]!.text);

    const dates = datesIn(text(1));
    if (dates.length === 0) throw new ParseError("leave list", `request ${id} has no readable date`);
    const amount = /([\d.]+)\s*(?:day|日)/i.exec(text(5));
    const span = /(\d{1,2}:\d{2})\s*[～~〜-]\s*(\d{1,2}:\d{2})/.exec(text(5));
    const length = span ? minutes(span[2]!)! - minutes(span[1]!)! : undefined;

    rows.push({
      id,
      from: dates[0]!,
      to: dates.at(-1)!,
      status: statusOf(text(2)),
      statusText: text(2),
      leaveTypeName: text(3),
      ...(datesIn(text(4))[0] ? { requestedOn: datesIn(text(4))[0] } : {}),
      ...(amount ? { days: Number(amount[1]) } : length !== undefined && length > 0 ? { minutes: length, time: { start: span![1]!, end: span![2]! } } : {}),
      ...(text(6) ? { reason: text(6) } : {}),
    });
  }
  return rows;
}

/** True when the page has the list's table, even with no requests in it. */
export function hasLeaveListTable(html: string): boolean {
  return parse(html).querySelectorAll("table thead th").length >= LEAVE_LIST_COLUMNS;
}
