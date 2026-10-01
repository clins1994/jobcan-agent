import { expandRange, isWeekend, type DateRange, type PlainDate } from "../domain/dates.js";
import { defineForm, type FormField, type FormSchema, type SelectField } from "../domain/forms.js";
import { nationalHoliday, type CalendarDay } from "../domain/holidays.js";
import type { LeaveType } from "../domain/types.js";

/**
 * Synthetic forms for the fake client. Each one covers a way real forms vary between
 * companies. None of them is copied from a real company's form.
 */
export interface FormFixture {
  name: string;
  leaveTypes: LeaveType[];
  form: FormSchema;
}

export const STANDARD_LEAVE_TYPES: LeaveType[] = [
  { id: "1", name: "有給休暇(全日)", category: "paid", balanceKey: "paid", unit: "full_day", days: 1 },
  { id: "2", name: "有給休暇(午前半休)", category: "paid", balanceKey: "paid", unit: "half_day_am", days: 0.5 },
  { id: "3", name: "有給休暇(午後半休)", category: "paid", balanceKey: "paid", unit: "half_day_pm", days: 0.5 },
  { id: "4", name: "代休(全日)", category: "compensatory", balanceKey: "compensatory", unit: "full_day", days: 1 },
  { id: "5", name: "振替休日(全日)", category: "substitute", balanceKey: "substitute", unit: "full_day", days: 1 },
  { id: "6", name: "特別休暇(全日)", category: "special", balanceKey: "special", unit: "full_day", days: 1 },
];

export const FULL_DAY_LEAVE_TYPES: LeaveType[] = STANDARD_LEAVE_TYPES.filter((t) => t.unit === "full_day");

function leaveTypeSelect(name: string, leaveTypes: LeaveType[]): SelectField {
  return {
    kind: "select",
    name,
    label: "休暇種別",
    required: true,
    role: "leave_type",
    options: leaveTypes.map((t) => ({ value: t.id, label: t.name })),
  };
}

function fixture(name: string, leaveTypes: LeaveType[], fields: FormField[]): FormFixture {
  return { name, leaveTypes, form: defineForm("leave", fields) };
}

/** Leave type and one date. Nothing else. */
export const minimalForm = fixture("minimal", STANDARD_LEAVE_TYPES, [
  leaveTypeSelect("leave_type", STANDARD_LEAVE_TYPES),
  { kind: "date", name: "date", label: "取得日", required: true, role: "from_date" },
]);

/** A reason must always be given. */
export const reasonRequiredForm = fixture("reason-required", STANDARD_LEAVE_TYPES, [
  leaveTypeSelect("leave_type", STANDARD_LEAVE_TYPES),
  { kind: "date", name: "date", label: "取得日", required: true, role: "from_date" },
  { kind: "textarea", name: "reason", label: "申請理由", required: true, role: "reason", maxLength: 200 },
]);

/** Adds a required select that the company defined itself. */
export const customSelectForm = fixture("custom-select", STANDARD_LEAVE_TYPES, [
  leaveTypeSelect("leave_type", STANDARD_LEAVE_TYPES),
  { kind: "date", name: "date", label: "取得日", required: true, role: "from_date" },
  { kind: "textarea", name: "reason", label: "申請理由", required: false, role: "reason", maxLength: 200 },
  {
    kind: "select",
    name: "custom_1",
    label: "休暇中の連絡方法",
    required: true,
    options: [
      { value: "1", label: "電話" },
      { value: "2", label: "メール" },
      { value: "3", label: "連絡不可" },
    ],
  },
]);

/** The company only offers full days. */
export const noHalfDaysForm = fixture("no-half-days", FULL_DAY_LEAVE_TYPES, [
  leaveTypeSelect("leave_type", FULL_DAY_LEAVE_TYPES),
  { kind: "date", name: "date", label: "取得日", required: true, role: "from_date" },
  { kind: "textarea", name: "reason", label: "申請理由", required: false, role: "reason", maxLength: 200 },
]);

/** Dates as year/month/day selects, a from/to pair, and a reason only some types need. */
export const ymdSelectsForm = fixture("ymd-selects", STANDARD_LEAVE_TYPES, [
  leaveTypeSelect("holiday_id", STANDARD_LEAVE_TYPES),
  {
    kind: "date_parts",
    name: "holiday_date",
    label: "取得日(開始)",
    required: true,
    role: "from_date",
    parts: { year: "holiday_year", month: "holiday_month", day: "holiday_day" },
  },
  {
    kind: "date_parts",
    name: "to_holiday_date",
    label: "取得日(終了)",
    required: true,
    role: "to_date",
    parts: { year: "to_holiday_year", month: "to_holiday_month", day: "to_holiday_day" },
  },
  {
    kind: "textarea",
    name: "description",
    label: "申請理由",
    required: true,
    role: "reason",
    maxLength: 200,
    onlyWhen: { field: "holiday_id", in: ["6"] },
  },
]);

/** Hourly paid leave alongside full days, with start and end time selects and a reason only non-paid types need. */
export const HOURLY_LEAVE_TYPES: LeaveType[] = [
  { id: "1", name: "有給休暇(全日)", category: "paid", balanceKey: "paid", unit: "full_day", days: 1 },
  { id: "4", name: "有給休暇(時間休)", category: "paid", balanceKey: "paid", unit: "hourly", days: 0, minutesPerDay: 480 },
  { id: "6", name: "特別休暇(全日)", category: "special", balanceKey: "special", unit: "full_day", days: 1 },
];

export const hourlyForm = fixture("hourly", HOURLY_LEAVE_TYPES, [
  leaveTypeSelect("holiday_id[0]", HOURLY_LEAVE_TYPES),
  {
    kind: "date_parts",
    name: "holiday_date",
    label: "取得日(開始)",
    required: true,
    role: "from_date",
    parts: { year: "holiday_year", month: "holiday_month", day: "holiday_day" },
  },
  {
    kind: "date_parts",
    name: "to_holiday_date",
    label: "取得日(終了)",
    required: true,
    role: "to_date",
    parts: { year: "to_holiday_year", month: "to_holiday_month", day: "to_holiday_day" },
  },
  {
    kind: "time_parts",
    name: "start_time",
    label: "開始時刻",
    required: true,
    role: "start_time",
    parts: { hour: "start[h][0]", minute: "start[m][0]" },
    minuteStep: 10,
    onlyWhen: { field: "holiday_id[0]", in: ["4"] },
  },
  {
    kind: "time_parts",
    name: "end_time",
    label: "終了時刻",
    required: true,
    role: "end_time",
    parts: { hour: "end[h][0]", minute: "end[m][0]" },
    minuteStep: 10,
    onlyWhen: { field: "holiday_id[0]", in: ["4"] },
  },
  {
    kind: "textarea",
    name: "description",
    label: "申請理由",
    required: true,
    role: "reason",
    maxLength: 200,
    onlyWhen: { field: "holiday_id[0]", in: ["6"] },
  },
]);

export const FORM_FIXTURES: FormFixture[] = [
  minimalForm,
  reasonRequiredForm,
  customSelectForm,
  noHalfDaysForm,
  ymdSelectsForm,
  hourlyForm,
];

/**
 * A calendar like the one Jobcan returns for a company that is closed on weekends and
 * national holidays, plus any extra company holidays.
 */
export function standardCalendar(range: DateRange, companyHolidays: PlainDate[] = []): CalendarDay[] {
  return expandRange(range).map((date) => {
    if (nationalHoliday(date)) return { date, isWorkday: false, label: "祝日" };
    if (isWeekend(date)) return { date, isWorkday: false, label: "公休" };
    if (companyHolidays.includes(date)) return { date, isWorkday: false, label: "公休" };
    return { date, isWorkday: true };
  });
}
