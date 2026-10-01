import { describe, expect, it } from "vitest";
import {
  datesIn,
  extractScriptJson,
  hasLeaveListTable,
  parseAttendancePage,
  parseLeaveFormPage,
  parseLeaveListPage,
  ParseError,
  statusOf,
} from "../../src/client/http/parsers.js";
import { attendancePage, HOLIDAYS, leaveFormPage, leaveListPage, type ListRow } from "./pages.js";

describe("parseAttendancePage", () => {
  const page = attendancePage(
    [
      { date: "2026-10-01", clockIn: "10:00", clockOut: "19:00", worked: "08:00", rest: "01:00" },
      { date: "2026-10-02", status: "PV" },
      { date: "2026-10-03", label: "National" },
      { date: "2026-10-04", label: "Legal" },
      { date: "2026-10-05", clockIn: "09:30" },
    ],
    [
      ["Paid Vacations", "3.50"],
      ["Compensatory Day Off", "4.00"],
      ["Refresh leave", "0.00"],
    ],
  );

  it("reads each day, with the date taken from the link", () => {
    expect(parseAttendancePage(page).days).toEqual([
      { date: "2026-10-01", isWorkday: true, clockIn: "10:00", clockOut: "19:00", workedMinutes: 480, breakMinutes: 60 },
      { date: "2026-10-02", isWorkday: true },
      { date: "2026-10-03", isWorkday: false, label: "National" },
      { date: "2026-10-04", isWorkday: false, label: "Legal" },
      { date: "2026-10-05", isWorkday: true, clockIn: "09:30" },
    ]);
  });

  it("reads the remaining balances and not the other cards", () => {
    expect(parseAttendancePage(page).balances).toEqual([
      { label: "Paid Vacations", remainingDays: 3.5 },
      { label: "Compensatory Day Off", remainingDays: 4 },
      { label: "Refresh leave", remainingDays: 0 },
    ]);
  });

  it("returns no balances when the card is missing", () => {
    const without = page.replace("Displaying month Remaining Vacations", "Something else");
    expect(parseAttendancePage(without).balances).toEqual([]);
  });

  it("reads links written with escaped ampersands", () => {
    const escaped = page.replace(/modify\?year=(\d+)&month=(\d+)&day=(\d+)/g, "modify?year=$1&amp;month=$2&amp;day=$3");
    expect(parseAttendancePage(escaped).days).toHaveLength(5);
  });

  it("fails loudly when a column is added", () => {
    const changed = page.replace(/<td>10:00～19:00<\/td>/g, "<td>10:00～19:00</td><td>new</td>");
    expect(() => parseAttendancePage(changed)).toThrow(ParseError);
    expect(() => parseAttendancePage(changed)).toThrow(/12 columns, expected 11/);
  });

  it("fails loudly when there are no days", () => {
    expect(() => parseAttendancePage(attendancePage([]))).toThrow(/no days found/);
    expect(() => parseAttendancePage("<html><body>maintenance</body></html>")).toThrow(ParseError);
  });
});

describe("extractScriptJson", () => {
  it("reads an object assigned to a variable", () => {
    expect(extractScriptJson('<script>var a = {"x": {"y": [1, 2]}}; var b = 1;</script>', "a")).toEqual({ x: { y: [1, 2] } });
  });

  it("is not confused by braces and quotes inside strings", () => {
    const html = String.raw`<script>var a = {"x": "close } and \" quote {"};</script>`;
    expect(extractScriptJson(html, "a")).toEqual({ x: 'close } and " quote {' });
  });

  it("does not match a longer variable name", () => {
    expect(extractScriptJson('var holidays_extra = {"a": 1};', "holidays")).toBeUndefined();
  });

  it("gives up on anything that is not JSON", () => {
    expect(extractScriptJson("var a = {x: 1};", "a")).toBeUndefined();
    expect(extractScriptJson("var a = 5;", "a")).toBeUndefined();
    expect(extractScriptJson("nothing here", "a")).toBeUndefined();
  });
});

describe("parseLeaveFormPage", () => {
  const parsed = parseLeaveFormPage(leaveFormPage());

  it("reads leave types from the embedded data, in display order", () => {
    expect(parsed.holidays.map((h) => h.id)).toEqual(HOLIDAYS.map((h) => h.id));
    expect(parsed.holidays[0]).toEqual({
      id: "1",
      name: "Annual leave (full day)",
      category: "paid",
      balanceKey: "paid",
      balanceLabel: "Paid Vacations",
      unit: "full_day",
      days: 1,
    });
  });

  it("tells half days and hourly leave apart", () => {
    const units = Object.fromEntries(parsed.holidays.map((h) => [h.id, [h.unit, h.days, h.minutesPerDay]]));
    expect(units["2"]).toEqual(["half_day_am", 0.5, undefined]);
    expect(units["3"]).toEqual(["half_day_pm", 0.5, undefined]);
    expect(units["4"]).toEqual(["hourly", 0, 480]);
  });

  it("reads tenths of a day, as the page's script does", () => {
    const page = leaveFormPage([
      { id: "9", name: "Mystery", holidayType: "paid", paidType: "3", balanceLabel: "Paid Vacations" },
      { id: "10", name: "Half, unnamed", holidayType: "paid", paidType: "5", balanceLabel: "Paid Vacations" },
      { id: "11", name: "Zero", holidayType: "special", paidType: "0", balanceLabel: "Special" },
    ]);
    const units = Object.fromEntries(parseLeaveFormPage(page).holidays.map((h) => [h.id, [h.unit, h.days]]));
    expect(units["9"]).toEqual(["partial_day", 0.3]);
    expect(units["10"]).toEqual(["half_day_pm", 0.5]);
    expect(units["11"]).toEqual(["full_day", 1]);
  });

  it("reads the time selects for hourly leave, only for hourly types", () => {
    const [start, end] = parsed.form.fields.filter((f) => f.kind === "time_parts");
    expect(start).toMatchObject({ role: "start_time", parts: { hour: "start[h][0]", minute: "start[m][0]" }, minuteStep: 10, required: true });
    expect(end).toMatchObject({ role: "end_time", onlyWhen: { field: "holiday_id[0]", in: ["4"] } });
  });

  it("keeps the hour select's own values, whose day starts at 03:00", () => {
    const start = parsed.form.fields.find((f) => f.role === "start_time");
    expect(start?.kind === "time_parts" && start.hours?.slice(0, 2)).toEqual([{ value: "0", label: "03" }, { value: "1", label: "04" }]);
    expect(start?.kind === "time_parts" && start.hours?.find((o) => o.label === "10")?.value).toBe("7");
  });

  it("does not need time selects when there is no hourly leave", () => {
    const noHourly = HOLIDAYS.filter((h) => h.paidType !== "-1");
    const form = parseLeaveFormPage(leaveFormPage(noHourly, { withTimeSelects: false })).form;
    expect(form.fields.some((f) => f.kind === "time_parts")).toBe(false);
    expect(() => parseLeaveFormPage(leaveFormPage(HOLIDAYS, { withTimeSelects: false }))).toThrow(/start time fields/);
  });

  const reasonRules: [("required" | "optional")[], Record<string, unknown>, string][] = [
    [["required"], { required: true }, "required for every type"],
    [["required", "optional"], { required: true, onlyWhen: { field: "holiday_id[0]", in: ["7", "11", "13"] } }, "required except for annual paid leave"],
    [["optional"], { required: false }, "optional"],
    [[], { required: false }, "optional when unmarked"],
  ];
  it.each(reasonRules)("reads the reason rule from the spans %j (%s)", (spans, expected) => {
    const form = parseLeaveFormPage(leaveFormPage(HOLIDAYS, { reasonSpans: spans })).form;
    const reason = form.fields.find((f) => f.role === "reason")!;
    expect(reason).toMatchObject(expected);
    if (!("onlyWhen" in expected)) expect(reason).not.toHaveProperty("onlyWhen");
  });

  it("gives each special leave its own balance", () => {
    const special = parsed.holidays.filter((h) => h.category === "special");
    expect(special.map((h) => [h.balanceKey, h.balanceLabel])).toEqual([
      ["special2", "Family leave"],
      ["special", "Refresh leave"],
    ]);
  });

  it("describes the form with options from the same data", () => {
    const [type, from, to] = parsed.form.fields;
    const reason = parsed.form.fields.find((f) => f.role === "reason");
    expect(type).toMatchObject({ kind: "select", name: "holiday_id[0]", role: "leave_type", required: true });
    expect(type?.kind === "select" && type.options[0]).toEqual({ value: "1", label: "Annual leave (full day)" });
    expect(from).toMatchObject({
      kind: "date_parts",
      role: "from_date",
      parts: { year: "holiday_year", month: "holiday_month", day: "holiday_day" },
    });
    expect(to).toMatchObject({ role: "to_date", parts: { year: "to_holiday_year", month: "to_holiday_month", day: "to_holiday_day" } });
    expect(reason).toMatchObject({ kind: "textarea", name: "description", role: "reason", required: false, maxLength: 255 });
  });

  it("reads how many minutes of hourly leave make a day", () => {
    expect(parsed.hourlyLeaveDayMinutes).toBe(480);
    expect(parseLeaveFormPage(leaveFormPage().replace(/var hourlyLeaveDayMin[^;]*;/, ""))).not.toHaveProperty("hourlyLeaveDayMinutes");
  });

  it("notices a reason marked as required", () => {
    const form = parseLeaveFormPage(leaveFormPage(HOLIDAYS, { reasonRequired: true })).form;
    expect(form.fields.find((f) => f.role === "reason")?.required).toBe(true);
  });

  it("changes fingerprint when a leave type is added", () => {
    const fewer = parseLeaveFormPage(leaveFormPage(HOLIDAYS.slice(0, 3))).form;
    expect(fewer.fingerprint).not.toBe(parsed.form.fingerprint);
  });

  it("fails loudly when the data or the form is missing", () => {
    expect(() => parseLeaveFormPage("<html><body></body></html>")).toThrow(/leave type data not found/);
    expect(() => parseLeaveFormPage(leaveFormPage().replace("/employee/holiday/confirm", "/elsewhere"))).toThrow(/request form not found/);
    expect(() => parseLeaveFormPage(leaveFormPage().replace(/name="holiday_year"/, 'name="renamed"'))).toThrow(/date fields/);
  });
});

describe("datesIn", () => {
  it.each([
    ["11/18/2025", ["2025-11-18"]],
    ["2025/11/18", ["2025-11-18"]],
    ["2025-11-18", ["2025-11-18"]],
    ["2025年11月18日", ["2025-11-18"]],
    ["2025年1月8日(木)", ["2025-01-08"]],
    ["12/29/2025 ～ 01/03/2026", ["2025-12-29", "2026-01-03"]],
    ["2025/12/29～2026/01/03", ["2025-12-29", "2026-01-03"]],
    ["no date", []],
    ["13/45/2025", []],
  ])("reads %s", (text, expected) => {
    expect(datesIn(text)).toEqual(expected);
  });
});

describe("statusOf", () => {
  it.each([
    ["Approved", "approved"],
    ["Request Approved", "approved"],
    ["承認済み", "approved"],
    ["Rejection", "rejected"],
    ["Rejected", "rejected"],
    ["却下", "rejected"],
    ["Requesting", "pending"],
    ["Unapproved", "pending"],
    ["Waiting for Approval", "pending"],
    ["(Approval in progress)", "pending"],
    ["未承認", "pending"],
    ["Cancel", "cancelled"],
    ["取消", "cancelled"],
  ] as const)("%s is %s", (text, expected) => {
    expect(statusOf(text)).toBe(expected);
  });

  it("treats wording it does not know as still open", () => {
    expect(statusOf("Something new")).toBe("pending");
    expect(statusOf("")).toBe("pending");
  });
});

describe("parseLeaveListPage", () => {
  const row = (overrides: Partial<ListRow> = {}): ListRow => ({
    id: "21",
    date: "11/18/2025",
    status: "Approved",
    type: "Annual leave (full day)",
    requested: "11/15/2025",
    amount: "1day(s)",
    reason: "Personal",
    ...overrides,
  });

  it("reads a request", () => {
    expect(parseLeaveListPage(leaveListPage([row()]))).toEqual([
      {
        id: "21",
        from: "2025-11-18",
        to: "2025-11-18",
        status: "approved",
        statusText: "Approved",
        leaveTypeName: "Annual leave (full day)",
        requestedOn: "2025-11-15",
        days: 1,
        reason: "Personal",
      },
    ]);
  });

  it("reads half days, hourly leave, ranges and an empty reason", () => {
    const rows = parseLeaveListPage(
      leaveListPage([
        row({ id: "1", amount: "0.5day(s)", reason: "" }),
        row({ id: "2", amount: "10:00～14:00" }),
        row({ id: "3", date: "12/29/2025 ～ 12/31/2025", amount: "3day(s)" }),
        row({ id: "4", amount: "9:30～10:45" }),
        row({ id: "5", amount: "" }),
      ]),
    );
    expect(rows[0]).toMatchObject({ days: 0.5 });
    expect(rows[0]).not.toHaveProperty("reason");
    expect(rows[1]).toMatchObject({ minutes: 240, time: { start: "10:00", end: "14:00" } });
    expect(rows[1]).not.toHaveProperty("days");
    expect(rows[2]).toMatchObject({ from: "2025-12-29", to: "2025-12-31", days: 3 });
    expect(rows[3]).toMatchObject({ minutes: 75 });
    expect(rows[4]).not.toHaveProperty("days");
    expect(rows[4]).not.toHaveProperty("minutes");
  });

  it("keeps Jobcan's wording for the status", () => {
    const [request] = parseLeaveListPage(leaveListPage([row({ status: "Something new" })]));
    expect(request).toMatchObject({ status: "pending", statusText: "Something new" });
  });

  it("returns nothing for an empty list, and can tell it from a wrong page", () => {
    const empty = leaveListPage([]);
    expect(parseLeaveListPage(empty)).toEqual([]);
    expect(hasLeaveListTable(empty)).toBe(true);
    expect(hasLeaveListTable("<html><body>maintenance</body></html>")).toBe(false);
  });

  it("fails loudly when a column is removed or a date cannot be read", () => {
    const fewer = leaveListPage([row()]).replace(/<td class="align-middle text-break">[^<]*<\/td>/, "");
    expect(() => parseLeaveListPage(fewer)).toThrow(/6 columns, expected 7/);
    expect(() => parseLeaveListPage(leaveListPage([row({ date: "soon" })]))).toThrow(/no readable date/);
  });
});
