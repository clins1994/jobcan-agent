import { describe, expect, it } from "vitest";
import {
  customSelectForm,
  FORM_FIXTURES,
  hourlyForm,
  minimalForm,
  noHalfDaysForm,
  reasonRequiredForm,
  ymdSelectsForm,
} from "../src/client/fixtures.js";
import {
  buildFormValues,
  defineForm,
  diffForms,
  fingerprintFields,
  validateFormValues,
  type FormField,
} from "../src/domain/forms.js";

const kinds = (issues: ReturnType<typeof validateFormValues>) => issues.map((i) => [i.kind, i.field]);

describe("fixtures", () => {
  it("cover the known variations", () => {
    expect(FORM_FIXTURES.map((f) => f.name)).toEqual([
      "minimal",
      "reason-required",
      "custom-select",
      "no-half-days",
      "ymd-selects",
      "hourly",
    ]);
  });

  it("have different fingerprints", () => {
    const prints = FORM_FIXTURES.map((f) => f.form.fingerprint);
    expect(new Set(prints).size).toBe(prints.length);
  });

  it("offer exactly the fixture's leave types in the leave type select", () => {
    for (const fixture of FORM_FIXTURES) {
      const select = fixture.form.fields.find((f) => f.role === "leave_type");
      expect(select?.kind).toBe("select");
      const values = select?.kind === "select" ? select.options.map((o) => o.value) : [];
      expect(values).toEqual(fixture.leaveTypes.map((t) => t.id));
    }
  });

  it("no-half-days has only full days", () => {
    expect(noHalfDaysForm.leaveTypes.every((t) => t.unit === "full_day")).toBe(true);
  });
});

describe("fingerprint", () => {
  const fields: FormField[] = [
    { kind: "select", name: "type", label: "種別", required: true, options: [{ value: "1", label: "有給" }] },
    { kind: "textarea", name: "reason", label: "理由", required: false },
  ];

  it("is stable", () => {
    expect(fingerprintFields(fields)).toBe(fingerprintFields(structuredClone(fields)));
  });

  it("ignores field order", () => {
    expect(fingerprintFields([...fields].reverse())).toBe(fingerprintFields(fields));
  });

  it("ignores wording, which changes with the UI language", () => {
    const english: FormField[] = [
      { kind: "select", name: "type", label: "Type", required: true, options: [{ value: "1", label: "Paid" }] },
      { kind: "textarea", name: "reason", label: "Reason", required: false },
    ];
    expect(fingerprintFields(english)).toBe(fingerprintFields(fields));
  });

  it.each([
    ["a field becomes required", (f: FormField[]) => void (f[1]!.required = true)],
    ["an option is added", (f: FormField[]) => void (f[0]!.kind === "select" && f[0]!.options.push({ value: "2", label: "代休" }))],
    ["a field is added", (f: FormField[]) => void f.push({ kind: "text", name: "extra", label: "追加", required: false })],
    ["a field is removed", (f: FormField[]) => void f.pop()],
    ["a field is renamed", (f: FormField[]) => void (f[1]!.name = "description")],
  ])("changes when %s", (_, change) => {
    const changed = structuredClone(fields);
    change(changed);
    expect(fingerprintFields(changed)).not.toBe(fingerprintFields(fields));
  });

  it("refuses two fields with one name", () => {
    expect(() => defineForm("leave", [fields[0]!, fields[0]!])).toThrow(/two fields named "type"/);
  });
});

describe("diffForms", () => {
  it("finds nothing between a form and itself", () => {
    expect(diffForms(minimalForm.form, minimalForm.form)).toEqual({ changed: false, added: [], removed: [], modified: [] });
  });

  it("finds an added field", () => {
    expect(diffForms(minimalForm.form, reasonRequiredForm.form)).toMatchObject({ changed: true, added: ["reason"], removed: [] });
  });

  it("finds a removed field", () => {
    expect(diffForms(reasonRequiredForm.form, minimalForm.form)).toMatchObject({ changed: true, removed: ["reason"] });
  });

  it("finds a modified field", () => {
    const diff = diffForms(reasonRequiredForm.form, customSelectForm.form);
    expect(diff.modified).toEqual(["reason"]); // required became optional
    expect(diff.added).toEqual(["custom_1"]);
  });

  it("finds changed options", () => {
    expect(diffForms(minimalForm.form, noHalfDaysForm.form).modified).toEqual(["leave_type"]);
  });
});

describe("buildFormValues", () => {
  it("fills a single date input", () => {
    expect(buildFormValues(minimalForm.form, { leaveTypeId: "1", date: "2026-10-05" })).toEqual({
      leave_type: "1",
      date: "2026-10-05",
    });
  });

  it("splits the date across year, month and day, without zero padding", () => {
    expect(buildFormValues(ymdSelectsForm.form, { leaveTypeId: "1", date: "2026-01-05" })).toEqual({
      holiday_id: "1",
      holiday_year: "2026",
      holiday_month: "1",
      holiday_day: "5",
      to_holiday_year: "2026",
      to_holiday_month: "1",
      to_holiday_day: "5",
    });
  });

  it("puts the reason in the form's reason field, whatever it is called", () => {
    const values = buildFormValues(ymdSelectsForm.form, { leaveTypeId: "6", date: "2026-10-05", reason: "慶弔" });
    expect(values.description).toBe("慶弔");
  });

  it("drops a reason when the form has no reason field", () => {
    const values = buildFormValues(minimalForm.form, { leaveTypeId: "1", date: "2026-10-05", reason: "私用" });
    expect(values).toEqual({ leave_type: "1", date: "2026-10-05" });
  });

  it("resolves company-defined fields by label and option label", () => {
    const values = buildFormValues(customSelectForm.form, {
      leaveTypeId: "1",
      date: "2026-10-05",
      fields: { 休暇中の連絡方法: "電話" },
    });
    expect(values.custom_1).toBe("1");
  });

  it("keeps unknown fields so that validation can report them", () => {
    const values = buildFormValues(minimalForm.form, { leaveTypeId: "1", date: "2026-10-05", fields: { nope: "x" } });
    expect(values.nope).toBe("x");
  });
});

describe("time fields", () => {
  it("splits a time into hour and minute selects, without zero padding", () => {
    const values = buildFormValues(hourlyForm.form, { leaveTypeId: "4", date: "2026-10-05", time: { start: "9:30", end: "14:00" } });
    expect(values).toMatchObject({ "start[h][0]": "9", "start[m][0]": "30", "end[h][0]": "14", "end[m][0]": "0" });
    expect(validateFormValues(hourlyForm.form, values)).toEqual([]);
  });

  it("requires the times only for hourly leave", () => {
    const fullDay = buildFormValues(hourlyForm.form, { leaveTypeId: "1", date: "2026-10-05" });
    expect(validateFormValues(hourlyForm.form, fullDay)).toEqual([]);
    const hourly = buildFormValues(hourlyForm.form, { leaveTypeId: "4", date: "2026-10-05" });
    expect(kinds(validateFormValues(hourlyForm.form, hourly))).toEqual([
      ["missing_required", "start_time"],
      ["missing_required", "end_time"],
    ]);
  });

  it("reports a time that is not on the minute grid, or not a time", () => {
    const base = buildFormValues(hourlyForm.form, { leaveTypeId: "4", date: "2026-10-05", time: { start: "10:05", end: "14:00" } });
    expect(kinds(validateFormValues(hourlyForm.form, base))).toEqual([["invalid_time", "start_time"]]);
    expect(kinds(validateFormValues(hourlyForm.form, { ...base, "start[h][0]": "x", "start[m][0]": "0" }))).toEqual([["invalid_time", "start_time"]]);
  });

  it("sends the hour select's value, not the hour, when the two differ", () => {
    const shifted = structuredClone(hourlyForm.form.fields);
    for (const f of shifted) {
      if (f.kind === "time_parts") f.hours = Array.from({ length: 48 }, (_, i) => ({ value: String(i), label: String(i + 3).padStart(2, "0") }));
    }
    const form = defineForm("leave", shifted);
    const values = buildFormValues(form, { leaveTypeId: "4", date: "2026-10-05", time: { start: "10:00", end: "14:00" } });
    expect(values).toMatchObject({ "start[h][0]": "7", "start[m][0]": "0", "end[h][0]": "11", "end[m][0]": "0" });
    expect(validateFormValues(form, values)).toEqual([]);
    expect(form.fingerprint).not.toBe(hourlyForm.form.fingerprint);

    const tooEarly = buildFormValues(form, { leaveTypeId: "4", date: "2026-10-05", time: { start: "02:00", end: "04:00" } });
    expect(kinds(validateFormValues(form, tooEarly))).toEqual([["invalid_time", "start_time"]]);
  });

  it("changes fingerprint when the minute grid changes", () => {
    const coarser = structuredClone(hourlyForm.form.fields);
    const start = coarser.find((f) => f.name === "start_time");
    if (start?.kind === "time_parts") start.minuteStep = 15;
    expect(fingerprintFields(coarser)).not.toBe(hourlyForm.form.fingerprint);
  });
});

describe("validateFormValues", () => {
  it("passes a complete form", () => {
    expect(validateFormValues(minimalForm.form, { leave_type: "1", date: "2026-10-05" })).toEqual([]);
  });

  it("reports every missing required field", () => {
    expect(kinds(validateFormValues(reasonRequiredForm.form, {}))).toEqual([
      ["missing_required", "leave_type"],
      ["missing_required", "date"],
      ["missing_required", "reason"],
    ]);
  });

  it("does not mind a missing optional field", () => {
    expect(validateFormValues(noHalfDaysForm.form, { leave_type: "1", date: "2026-10-05" })).toEqual([]);
  });

  it("reports a leave type the form does not offer", () => {
    const issues = validateFormValues(noHalfDaysForm.form, { leave_type: "2", date: "2026-10-05" });
    expect(kinds(issues)).toEqual([["invalid_option", "leave_type"]]);
    expect(issues[0]?.options?.map((o) => o.value)).toEqual(["1", "4", "5", "6"]);
  });

  it("reports an impossible date", () => {
    expect(kinds(validateFormValues(minimalForm.form, { leave_type: "1", date: "2026-02-30" }))).toEqual([
      ["invalid_date", "date"],
    ]);
  });

  it("reports an impossible date given as parts", () => {
    const values = { ...buildFormValues(ymdSelectsForm.form, { leaveTypeId: "1", date: "2026-10-05" }), holiday_day: "32" };
    expect(kinds(validateFormValues(ymdSelectsForm.form, values))).toEqual([["invalid_date", "holiday_date"]]);
  });

  it("reports date parts that are missing", () => {
    expect(kinds(validateFormValues(ymdSelectsForm.form, { holiday_id: "1" }))).toEqual([
      ["missing_required", "holiday_date"],
      ["missing_required", "to_holiday_date"],
    ]);
  });

  it("counts characters, not bytes", () => {
    const base = { leave_type: "1", date: "2026-10-05" };
    expect(validateFormValues(reasonRequiredForm.form, { ...base, reason: "休".repeat(200) })).toEqual([]);
    expect(kinds(validateFormValues(reasonRequiredForm.form, { ...base, reason: "休".repeat(201) }))).toEqual([
      ["too_long", "reason"],
    ]);
  });

  it("applies a conditional field only when its condition holds", () => {
    const paid = buildFormValues(ymdSelectsForm.form, { leaveTypeId: "1", date: "2026-10-05" });
    const special = buildFormValues(ymdSelectsForm.form, { leaveTypeId: "6", date: "2026-10-05" });
    expect(validateFormValues(ymdSelectsForm.form, paid)).toEqual([]);
    expect(kinds(validateFormValues(ymdSelectsForm.form, special))).toEqual([["missing_required", "description"]]);
  });

  it("reports a value for a field the form does not have", () => {
    const issues = validateFormValues(minimalForm.form, { leave_type: "1", date: "2026-10-05", nope: "x" });
    expect(kinds(issues)).toEqual([["unknown_field", "nope"]]);
  });
});
