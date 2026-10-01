import { createHash } from "node:crypto";
import { isPlainDate, toParts } from "./dates.js";
import type { LeaveSubmission } from "./types.js";

const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/** Minutes since midnight, or undefined when the text is not `HH:MM`. Hours may pass 24 for night shifts. */
export function timeToMinutes(text: string): number | undefined {
  const m = TIME_RE.exec(text);
  if (!m) return undefined;
  const [hours, minutes] = [Number(m[1]), Number(m[2])];
  return minutes < 60 ? hours * 60 + minutes : undefined;
}

/**
 * Request forms differ per company and per employee type, so they are described by a
 * discovered schema instead of fixed selectors. Everything here is pure.
 */
export type FormRequestType = "leave" | "correction";

/** What a field means to us. Fields without a role are company-defined. */
export type FieldRole = "leave_type" | "from_date" | "to_date" | "reason" | "start_time" | "end_time";

export interface FormOption {
  value: string;
  label: string;
}

/** The field only applies while another field holds one of these values. */
export interface FieldCondition {
  field: string;
  in: string[];
}

interface FieldBase {
  name: string;
  label: string;
  required: boolean;
  role?: FieldRole;
  onlyWhen?: FieldCondition;
}

export interface TextField extends FieldBase {
  kind: "text" | "textarea";
  maxLength?: number;
}

export interface SelectField extends FieldBase {
  kind: "select";
  options: FormOption[];
}

/** A single input holding `YYYY-MM-DD`. */
export interface DateField extends FieldBase {
  kind: "date";
}

/** A date split across three inputs, usually year/month/day selects. */
export interface DatePartsField extends FieldBase {
  kind: "date_parts";
  parts: { year: string; month: string; day: string };
}

/** A time split across an hour select and a minute select. */
export interface TimePartsField extends FieldBase {
  kind: "time_parts";
  parts: { hour: string; minute: string };
  /**
   * The hour select's options when its values are not the hours themselves (Jobcan's
   * day starts at 03:00, so value 7 shows as "10"). Labels are the hours shown.
   */
  hours?: FormOption[];
  /** Minutes the minute select offers, e.g. every 10. */
  minuteStep?: number;
}

export type FormField = TextField | SelectField | DateField | DatePartsField | TimePartsField;

export interface FormSchema {
  requestType: FormRequestType;
  fields: FormField[];
  /** Changes when the form's structure changes. Wording changes do not affect it. */
  fingerprint: string;
}

export type FormValues = Record<string, string>;

export type FormIssueKind = "missing_required" | "invalid_option" | "invalid_date" | "invalid_time" | "too_long" | "unknown_field";

export interface FormIssue {
  kind: FormIssueKind;
  field: string;
  label: string;
  message: string;
  /** Choices to offer when the field is a select. */
  options?: FormOption[];
}

export interface FormDiff {
  changed: boolean;
  added: string[];
  removed: string[];
  modified: string[];
}

/** Labels are left out on purpose: they change with the UI language. */
function structureOf(field: FormField) {
  return {
    name: field.name,
    kind: field.kind,
    required: field.required,
    role: field.role ?? null,
    onlyWhen: field.onlyWhen ? { field: field.onlyWhen.field, in: [...field.onlyWhen.in].sort() } : null,
    options: field.kind === "select" ? field.options.map((o) => o.value).sort() : null,
    parts: field.kind === "date_parts" || field.kind === "time_parts" ? field.parts : null,
    minuteStep: field.kind === "time_parts" ? (field.minuteStep ?? null) : null,
    hours: field.kind === "time_parts" && field.hours ? field.hours.map((o) => `${o.value}=${Number(o.label)}`) : null,
    maxLength: field.kind === "text" || field.kind === "textarea" ? (field.maxLength ?? null) : null,
  };
}

export function fingerprintFields(fields: FormField[]): string {
  const canonical = fields.map(structureOf).sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

export function defineForm(requestType: FormRequestType, fields: FormField[]): FormSchema {
  const names = fields.map((f) => f.name);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate) throw new Error(`Form has two fields named "${duplicate}"`);
  return { requestType, fields, fingerprint: fingerprintFields(fields) };
}

export function diffForms(before: FormSchema, after: FormSchema): FormDiff {
  const old = new Map(before.fields.map((f) => [f.name, JSON.stringify(structureOf(f))]));
  const now = new Map(after.fields.map((f) => [f.name, JSON.stringify(structureOf(f))]));
  const added = [...now.keys()].filter((n) => !old.has(n));
  const removed = [...old.keys()].filter((n) => !now.has(n));
  const modified = [...now.keys()].filter((n) => old.has(n) && old.get(n) !== now.get(n));
  return { changed: added.length + removed.length + modified.length > 0, added, removed, modified };
}

function fieldByRole(schema: FormSchema, role: FieldRole): FormField | undefined {
  return schema.fields.find((f) => f.role === role);
}

/** Company-defined fields can be addressed by name or by label. */
function findField(schema: FormSchema, key: string): FormField | undefined {
  return schema.fields.find((f) => f.name === key) ?? schema.fields.find((f) => f.label === key);
}

/** Selects accept either the option value or its visible label. */
function resolveOption(field: SelectField, input: string): string {
  const option = field.options.find((o) => o.value === input) ?? field.options.find((o) => o.label === input);
  return option ? option.value : input;
}

function setDate(values: FormValues, field: FormField, date: string) {
  if (field.kind === "date_parts" && isPlainDate(date)) {
    const { year, month, day } = toParts(date);
    values[field.parts.year] = String(year);
    values[field.parts.month] = String(month);
    values[field.parts.day] = String(day);
  } else {
    values[field.name] = date;
  }
}

/** The value the hour select sends for an hour shown, or undefined when it does not offer it. */
function hourValue(field: TimePartsField, hour: number): string | undefined {
  if (!field.hours) return String(hour);
  return field.hours.find((o) => Number(o.label) === hour)?.value;
}

/** The hour shown for a value the hour select sends. */
function hourShown(field: TimePartsField, value: string): string {
  if (!field.hours) return value;
  const option = field.hours.find((o) => o.value === value);
  return option ? String(Number(option.label)) : `?${value}`;
}

function setTime(values: FormValues, field: TimePartsField, time: string) {
  const minutes = timeToMinutes(time);
  const value = minutes === undefined ? undefined : hourValue(field, Math.floor(minutes / 60));
  if (minutes === undefined || value === undefined) {
    // left unusable on purpose, so validation reports it
    values[field.parts.hour] = `?${time}`;
    return;
  }
  values[field.parts.hour] = value;
  values[field.parts.minute] = String(minutes % 60);
}

function getTime(values: FormValues, field: TimePartsField): string | undefined {
  const [h, m] = [values[field.parts.hour], values[field.parts.minute]];
  if (h === undefined && m === undefined) return undefined;
  return `${h === undefined ? "" : hourShown(field, h)}:${(m ?? "").padStart(2, "0")}`;
}

function getDate(values: FormValues, field: DateField | DatePartsField): string | undefined {
  if (field.kind === "date") return values[field.name];
  const [y, m, d] = [values[field.parts.year], values[field.parts.month], values[field.parts.day]];
  if (y === undefined && m === undefined && d === undefined) return undefined;
  return `${(y ?? "").padStart(4, "0")}-${(m ?? "").padStart(2, "0")}-${(d ?? "").padStart(2, "0")}`;
}

/** Turns a submission into the values the form expects. Unknown keys are kept so validation reports them. */
export function buildFormValues(schema: FormSchema, submission: LeaveSubmission): FormValues {
  const values: FormValues = {};

  const leaveType = fieldByRole(schema, "leave_type");
  if (leaveType) values[leaveType.name] = submission.leaveTypeId;

  const from = fieldByRole(schema, "from_date");
  if (from) setDate(values, from, submission.date);
  const to = fieldByRole(schema, "to_date");
  if (to) setDate(values, to, submission.date);

  const reason = fieldByRole(schema, "reason");
  if (reason && submission.reason !== undefined) values[reason.name] = submission.reason;

  for (const [role, time] of [
    ["start_time", submission.time?.start],
    ["end_time", submission.time?.end],
  ] as const) {
    const field = fieldByRole(schema, role);
    if (field?.kind === "time_parts" && time !== undefined) setTime(values, field, time);
  }

  for (const [key, value] of Object.entries(submission.fields ?? {})) {
    const field = findField(schema, key);
    if (!field) values[key] = value;
    else values[field.name] = field.kind === "select" ? resolveOption(field, value) : value;
  }
  return values;
}

function applies(field: FormField, values: FormValues): boolean {
  if (!field.onlyWhen) return true;
  return field.onlyWhen.in.includes(values[field.onlyWhen.field] ?? "");
}

export function validateFormValues(schema: FormSchema, values: FormValues): FormIssue[] {
  const issues: FormIssue[] = [];
  const known = new Set<string>();

  for (const field of schema.fields) {
    if (field.kind === "date_parts" || field.kind === "time_parts") Object.values(field.parts).forEach((n) => known.add(n));
    else known.add(field.name);
    if (!applies(field, values)) continue;

    const issue = (kind: FormIssueKind, message: string): FormIssue => ({
      kind,
      field: field.name,
      label: field.label,
      message,
      ...(field.kind === "select" ? { options: field.options } : {}),
    });

    const value =
      field.kind === "date" || field.kind === "date_parts"
        ? getDate(values, field)
        : field.kind === "time_parts"
          ? getTime(values, field)
          : values[field.name];
    if (value === undefined || value.trim() === "") {
      if (field.required) issues.push(issue("missing_required", `"${field.label}" is required`));
      continue;
    }

    if (field.kind === "select" && !field.options.some((o) => o.value === value)) {
      issues.push(issue("invalid_option", `"${value}" is not an option for "${field.label}"`));
    } else if ((field.kind === "date" || field.kind === "date_parts") && !isPlainDate(value)) {
      issues.push(issue("invalid_date", `"${value}" is not a valid date for "${field.label}"`));
    } else if (field.kind === "time_parts") {
      const minutes = timeToMinutes(value);
      if (minutes === undefined) issues.push(issue("invalid_time", `"${value}" is not a valid time for "${field.label}"`));
      else if (field.minuteStep && minutes % field.minuteStep !== 0) {
        issues.push(issue("invalid_time", `"${field.label}" must be a multiple of ${field.minuteStep} minutes, got ${value}`));
      }
    } else if ((field.kind === "text" || field.kind === "textarea") && field.maxLength !== undefined) {
      const length = [...value].length;
      if (length > field.maxLength) {
        issues.push(issue("too_long", `"${field.label}" allows ${field.maxLength} characters, got ${length}`));
      }
    }
  }

  for (const key of Object.keys(values)) {
    if (!known.has(key)) {
      issues.push({ kind: "unknown_field", field: key, label: key, message: `The form has no field "${key}"` });
    }
  }
  return issues;
}
