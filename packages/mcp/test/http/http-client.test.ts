import { describe, expect, it } from "vitest";
import { readOnly, WRITE_METHODS, WriteBlockedError } from "../../src/client/client.js";
import { HttpJobcanClient } from "../../src/client/http/http-client.js";
import { Session } from "../../src/client/http/session.js";
import { planLeave, recordAttendance, replaceLeave } from "../../src/usecases/leave.js";
import { credentials, fakeServer, type FakeServerOptions } from "./fake-server.js";
import { attendancePage, HOLIDAYS, leaveFormPage, leaveListPage, type DayRow } from "./pages.js";

const NOW = new Date("2026-09-29T03:00:00Z"); // midday in Japan

function monthDays(query: URLSearchParams): DayRow[] {
  const [year, month] = [Number(query.get("year")), Number(query.get("month"))];
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`;
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (dow === 6) return { date, label: "National" };
    if (dow === 0) return { date, label: "Legal" };
    if (date === "2026-10-12") return { date, label: "Public National" };
    if (date === "2026-10-13") return { date, label: "National" }; // a company holiday
    return { date };
  });
}

const pages: FakeServerOptions["pages"] = {
  "/employee/attendance": (query) =>
    attendancePage(monthDays(query), [
      ["Paid Vacations", "10.00"],
      ["Compensatory Day Off", "1.00"],
      ["Refresh leave", "0.00"],
      ["Unknown balance", "2.00"],
    ]),
  "/employee/holiday/new": leaveFormPage(),
  "/employee/holiday/": leaveListPage([
    { id: "31", date: "10/06/2026", status: "Requesting", type: "Annual leave (full day)", requested: "09/20/2026", amount: "1day(s)", reason: "Personal" },
    { id: "30", date: "09/01/2026", status: "Approved", type: "Annual leave (午前半休)", requested: "08/20/2026", amount: "0.5day(s)", reason: "" },
    { id: "29", date: "08/03/2026", status: "Rejection", type: "A type that no longer exists", requested: "07/20/2026", amount: "1day(s)", reason: "" },
    { id: "28", date: "10/20/2026", status: "Waiting for Approval", type: "Annual leave (hourly)", requested: "09/21/2026", amount: "10:00～13:00", reason: "" },
  ]),
};

/** Requests for a page that were answered with it, leaving out the signed-out attempt that was sent to sign in. */
const served = (server: ReturnType<typeof fakeServer>, path: string) =>
  server.requests.filter((r) => r.path === path && r.cookies.includes("sid="));

function setup(options: FakeServerOptions & { allowWrites?: boolean } = {}) {
  const { allowWrites, ...serverOptions } = options;
  const server = fakeServer({ pages, ...serverOptions });
  const creds = credentials();
  let saved = 0;
  const client = new HttpJobcanClient({
    session: new Session({ fetch: server.fetch, delayMs: 0, allowWrites }),
    getCredentials: creds,
    onSignedIn: async () => void saved++,
    now: () => NOW,
  });
  return { server, client, creds, saved: () => saved };
}

describe("reads", () => {
  it("signs in on first use, once, and saves the session", async () => {
    const { server, client, saved } = setup();
    await client.getTimesheet("2026-10");
    await client.listLeaveTypes();
    await client.listLeaveRequests();
    expect(server.signIns).toBe(1);
    expect(saved()).toBe(1);
  });

  it("tells today by Japan's clock", async () => {
    const { client } = setup();
    expect(await client.getToday()).toBe("2026-09-29");
  });

  it("reads a month of attendance and asks for that month", async () => {
    const { server, client } = setup();
    const days = await client.getTimesheet("2026-10");
    expect(days).toHaveLength(31);
    const asked = new URL(served(server, "/employee/attendance")[0]!.url).searchParams;
    expect(Object.fromEntries(asked)).toMatchObject({ year: "2026", month: "10", search_type: "month", "from[d]": "1", "to[d]": "31" });
  });

  it("builds the calendar across months, fetching each month once", async () => {
    const { server, client } = setup();
    const days = await client.getCalendar({ from: "2026-10-30", to: "2026-11-02" });
    expect(days).toEqual([
      { date: "2026-10-30", isWorkday: true },
      { date: "2026-10-31", isWorkday: false, label: "National" },
      { date: "2026-11-01", isWorkday: false, label: "Legal" },
      { date: "2026-11-02", isWorkday: true },
    ]);
    await client.getCalendar({ from: "2026-10-01", to: "2026-10-31" });
    expect(served(server, "/employee/attendance")).toHaveLength(2);
  });

  it("lists leave types without internal fields", async () => {
    const { client } = setup();
    const types = await client.listLeaveTypes();
    expect(types[0]).toEqual({ id: "1", name: "Annual leave (full day)", category: "paid", balanceKey: "paid", unit: "full_day", days: 1 });
  });

  it("matches balances to leave types by their label", async () => {
    const { client } = setup();
    expect(await client.getLeaveBalances()).toEqual([
      { key: "paid", label: "Paid Vacations", category: "paid", remainingDays: 10, pendingAlreadyDeducted: false },
      { key: "compensatory", label: "Compensatory Day Off", category: "compensatory", remainingDays: 1, pendingAlreadyDeducted: false },
      { key: "special", label: "Refresh leave", category: "special", remainingDays: 0, pendingAlreadyDeducted: false },
      { key: "label:Unknown balance", label: "Unknown balance", category: "other", remainingDays: 2, pendingAlreadyDeducted: false },
    ]);
  });

  it("lists requests, placing each by its leave type", async () => {
    const { client } = setup();
    const requests = await client.listLeaveRequests();
    expect(requests[0]).toEqual({
      id: "31",
      from: "2026-10-06",
      to: "2026-10-06",
      leaveTypeId: "1",
      leaveTypeName: "Annual leave (full day)",
      category: "paid",
      balanceKey: "paid",
      unit: "full_day",
      days: 1,
      status: "pending",
      reason: "Personal",
      requestedOn: "2026-09-20",
    });
    expect(requests[1]).toMatchObject({ unit: "half_day_am", days: 0.5, status: "approved" });
    expect(requests[2]).toMatchObject({ category: "other", unit: "full_day", status: "rejected" });
    expect(requests[2]).not.toHaveProperty("leaveTypeId");
  });

  it("counts hourly leave as a fraction of a day", async () => {
    const { client } = setup();
    expect(await client.getLeaveRequest("28")).toMatchObject({
      unit: "hourly",
      days: 0.375,
      status: "pending",
      balanceKey: "paid",
      time: { start: "10:00", end: "13:00" },
    });
    expect((await client.listLeaveTypes()).find((t) => t.id === "4")).toMatchObject({ minutesPerDay: 480 });
  });

  it("asks for a wide window when no range is given, and the given one otherwise", async () => {
    const { server, client } = setup();
    await client.listLeaveRequests();
    await client.listLeaveRequests({ from: "2026-10-01", to: "2026-10-31" });
    const [wide, narrow] = served(server, "/employee/holiday/").map((r) => Object.fromEntries(new URL(r.url).searchParams));
    expect(wide).toMatchObject({ search_type: "term", "from[y]": "2026", "from[m]": "4", "to[y]": "2027", "to[m]": "9" });
    expect(narrow).toMatchObject({ "from[m]": "10", "from[d]": "1", "to[m]": "10", "to[d]": "31" });
  });

  it("finds one request by id", async () => {
    const { client } = setup();
    expect((await client.getLeaveRequest("30"))?.from).toBe("2026-09-01");
    expect(await client.getLeaveRequest("404")).toBeUndefined();
  });

  it("signs in again when the session has lapsed", async () => {
    const { server, client } = setup();
    await client.listLeaveRequests();
    await client["session"].jar.removeAllCookies();
    await client.listLeaveRequests();
    expect(server.signIns).toBe(2);
  });

  it("reports a page Jobcan does not serve", async () => {
    const { client } = setup({ pages: {} });
    await expect(client.listLeaveTypes()).rejects.toThrow(/404/);
  });
});

describe("planning against the HTTP client", () => {
  it("plans October 5 to 15 from Jobcan's own calendar, balance and requests", async () => {
    const { client } = setup();
    const plan = await planLeave(client, { leaveType: "Annual leave (full day)", range: { from: "2026-10-05", to: "2026-10-15" } });

    expect(plan.status).toBe("ready");
    expect(plan.toFile).toEqual(["2026-10-05", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-14", "2026-10-15"]);
    expect(plan.days.filter((d) => d.decision === "skip").map((d) => [d.date, d.skipReason])).toEqual([
      ["2026-10-06", "already_requested"],
      ["2026-10-10", "weekend"],
      ["2026-10-11", "weekend"],
      ["2026-10-12", "national_holiday"],
      ["2026-10-13", "company_holiday"],
    ]);
    expect(plan.balance).toMatchObject({ remaining: 10, pending: 1.375, available: 8.625, cost: 6, after: 2.625 });
  });
});

describe("writes", () => {
  it("sends only GETs, apart from signing in", async () => {
    const { server, client } = setup();
    await client.getCalendar({ from: "2026-10-01", to: "2026-11-30" });
    await client.getLeaveBalances();
    await client.listLeaveRequests();
    await client.discoverForm("leave");
    await planLeave(client, { leaveType: "1", dates: ["2026-10-05"] });

    const posts = server.requests.filter((r) => r.method !== "GET");
    expect(posts.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /users/sign_in"]);
  });

  it("refuses every write without contacting Jobcan", async () => {
    const { server, client } = setup();
    await client.listLeaveTypes();
    const before = server.requests.length;

    const calls: Record<(typeof WRITE_METHODS)[number], () => Promise<unknown>> = {
      submitLeaveRequest: () => client.submitLeaveRequest({ leaveTypeId: "1", date: "2026-10-05" }),
      cancelLeaveRequest: () => client.cancelLeaveRequest("31"),
      recordAttendance: () => client.recordAttendance({ date: "2026-09-28", clockIn: "10:00", note: "x" }),
    };
    for (const method of WRITE_METHODS) await expect(calls[method]()).rejects.toThrow(WriteBlockedError);
    expect(server.requests).toHaveLength(before);
  });

  const existing = [
    { id: "47", date: "09/25/2026", status: "Waiting for Approval", type: "Annual leave (hourly)", requested: "09/24/2026", amount: "10:00～14:00", reason: "Exam" },
    { id: "41", date: "08/14/2026", status: "Approved", type: "Annual leave (full day)", requested: "07/23/2026", amount: "1day(s)", reason: "Trip" },
  ];
  const stateful = (extra: FakeServerOptions & { allowWrites?: boolean } = {}) => {
    const { holidays, ...rest } = extra;
    const { pages: _pages, ...withoutList } = { pages };
    void withoutList;
    const server = fakeServer({
      pages: { "/employee/attendance": pages["/employee/attendance"]!, "/employee/holiday/new": leaveFormPage(HOLIDAYS, { reasonSpans: ["required"] }) },
      holidays: holidays ?? structuredClone(existing),
      ...rest,
    });
    const client = new HttpJobcanClient({
      session: new Session({ fetch: server.fetch, delayMs: 0, allowWrites: extra.allowWrites ?? true }),
      getCredentials: credentials(),
      now: () => NOW,
    });
    return { server, client };
  };

  it("files a day of leave through the review step and finds it in the list", async () => {
    const { server, client } = stateful();
    const filed = await client.submitLeaveRequest({ leaveTypeId: "1", date: "2026-10-05", reason: "Personal" });
    expect(filed).toMatchObject({ id: "48", from: "2026-10-05", leaveTypeId: "1", status: "pending", reason: "Personal", days: 1 });
    const posts = server.requests.filter((r) => r.method === "POST").map((r) => r.path);
    expect(posts).toEqual(["/users/sign_in", "/employee/holiday/confirm", "/employee/holiday/save"]);
    const review = new URLSearchParams(server.requests.find((r) => r.path === "/employee/holiday/confirm")!.body);
    expect(Object.fromEntries(review)).toEqual({
      employee_id: "7",
      holiday_type: "",
      total_used_days_count: "0",
      work_unixtime: "",
      "holiday_id[0]": "1",
      holiday_year: "2026",
      holiday_month: "10",
      holiday_day: "5",
      to_holiday_year: "2026",
      to_holiday_month: "10",
      to_holiday_day: "5",
      description: "Personal",
    });
    const save = new URLSearchParams(server.requests.find((r) => r.path === "/employee/holiday/save")!.body);
    expect(save.get("token")).toBe("review-1");
    expect(save.getAll("holiday_id[]")).toEqual(["1"]);
    expect(server.holidays[0]).toMatchObject({ id: "48", date: "10/05/2026", status: "Waiting for Approval" });
  });

  it("files hourly leave with its hours", async () => {
    const { server, client } = stateful();
    const filed = await client.submitLeaveRequest({ leaveTypeId: "4", date: "2026-10-05", time: { start: "13:00", end: "17:00" }, reason: "Personal" });
    expect(filed).toMatchObject({ unit: "hourly", days: 0.5, time: { start: "13:00", end: "17:00" } });
    const review = new URLSearchParams(server.requests.find((r) => r.path === "/employee/holiday/confirm")!.body);
    // the hour select's values start at 03:00, so 13:00 is sent as 10 and 17:00 as 14
    expect(Object.fromEntries(review)).toMatchObject({ "start[h][0]": "10", "start[m][0]": "0", "end[h][0]": "14", "end[m][0]": "0" });
  });

  it("reports Jobcan's refusal from the review step and saves nothing", async () => {
    const { server, client } = stateful();
    await expect(client.submitLeaveRequest({ leaveTypeId: "1", date: "2026-10-05" })).rejects.toThrow(/Please enter the reason/);
    await expect(client.submitLeaveRequest({ leaveTypeId: "1", date: "2026-09-25", reason: "x" })).rejects.toThrow(/already requested/);
    expect(server.requests.some((r) => r.path === "/employee/holiday/save")).toBe(false);
    expect(server.holidays).toHaveLength(2);
  });

  it("withdraws a pending request through the confirmation page", async () => {
    const { server, client } = stateful();
    const withdrawn = await client.cancelLeaveRequest("47");
    expect(withdrawn).toMatchObject({ id: "47", status: "cancelled", from: "2026-09-25" });
    expect(server.requests.map((r) => r.path).filter((p) => p.includes("delete"))).toEqual(["/employee/holiday/delete-confirm/", "/employee/holiday/delete/"]);
    expect(server.holidays.map((h) => h.id)).toEqual(["41"]);
    await expect(client.cancelLeaveRequest("47")).rejects.toThrow(/not found/);
  });

  it("treats a redirect it would not follow, after a write, as done rather than failed", async () => {
    const { server, client } = stateful({ afterDelete: "/employee/holiday/deleted-somewhere", afterSave: "/employee/holiday/saved-somewhere" });
    expect((await client.cancelLeaveRequest("47")).status).toBe("cancelled");
    expect(server.holidays.map((h) => h.id)).toEqual(["41"]);
    const filed = await client.submitLeaveRequest({ leaveTypeId: "1", date: "2026-09-25", reason: "Personal" });
    expect(filed).toMatchObject({ id: "48", status: "pending" });
    expect(server.requests.some((r) => r.path.includes("somewhere"))).toBe(false);
  });

  it("refuses to withdraw an approved request and does not touch Jobcan's pages", async () => {
    const { server, client } = stateful();
    await expect(client.cancelLeaveRequest("41")).rejects.toThrow(/approved/);
    expect(server.requests.some((r) => r.path.includes("delete"))).toBe(false);
  });

  it("refuses writes when the session does not allow them, before anything is sent", async () => {
    const { server, client } = stateful({ allowWrites: false });
    await expect(client.submitLeaveRequest({ leaveTypeId: "1", date: "2026-10-05", reason: "x" })).rejects.toThrow(WriteBlockedError);
    await expect(client.cancelLeaveRequest("47")).rejects.toThrow(WriteBlockedError);
    expect(server.requests).toEqual([]);
  });

  it("replaces four hours with a full day: withdraw, then file", async () => {
    const { server, client } = stateful();
    const preview = await replaceLeave(client, { id: "47", replacement: { leaveType: "1" } });
    expect(preview.mode).toBe("dry_run");
    if (preview.mode !== "dry_run") return;
    expect(preview.plan).toMatchObject({ status: "ready", toFile: ["2026-09-25"], reason: "Exam", reasonSource: "history" });
    expect(preview.plan.balance).toMatchObject({ remaining: 10, pending: 0, available: 10, cost: 1, after: 9 });
    expect(server.holidays).toHaveLength(2);

    const done = await replaceLeave(client, { id: "47", replacement: { leaveType: "1" }, confirm: true });
    expect(done.mode).toBe("replaced");
    if (done.mode !== "replaced") return;
    expect(done.withdrawn.status).toBe("cancelled");
    expect(done.filed[0]).toMatchObject({ from: "2026-09-25", leaveTypeId: "1", days: 1, status: "pending" });
    expect(done.failed).toBeUndefined();
    expect(server.holidays.map((h) => [h.id, h.date, h.amount])).toEqual([["48", "09/25/2026", "1day(s)"], ["41", "08/14/2026", "1day(s)"]]);
  });

  it("says so when the new request fails after the old one was withdrawn", async () => {
    const { server, client } = stateful({ refuseWith: ["Not enough remaining vacations"] });
    const done = await replaceLeave(client, { id: "47", replacement: { leaveType: "1" }, confirm: true });
    expect(done).toMatchObject({ mode: "replaced", filed: [], failed: { date: "2026-09-25", messages: ["Not enough remaining vacations"] } });
    expect(server.holidays.map((h) => h.id)).toEqual(["41"]);
  });

  it("still reads through the read-only wrapper", async () => {
    const { client } = setup();
    expect(await readOnly(client).listLeaveTypes()).toHaveLength(7);
  });
});

describe("attendance records", () => {
  const punched = new Map<string, string[]>();
  const withPunches = () => {
    punched.clear();
    const server = fakeServer({
      pages: {
        "/employee/attendance": (query) =>
          attendancePage(
            monthDays(query).map((d) => {
              const [clockIn, clockOut] = punched.get(d.date) ?? [];
              return { ...d, ...(clockIn ? { clockIn } : {}), ...(clockOut ? { clockOut } : {}) };
            }),
            [["Paid Vacations", "10.00"]],
          ),
        "/employee/holiday/new": leaveFormPage(),
        "/employee/holiday/": leaveListPage([]),
      },
      onPunch: (date, time) => punched.set(date, [...(punched.get(date) ?? []), time]),
    });
    const client = new HttpJobcanClient({
      session: new Session({ fetch: server.fetch, delayMs: 0, allowWrites: true }),
      getCredentials: credentials(),
      now: () => NOW,
    });
    return { server, client };
  };

  it("lists the spots from the clock-edit page", async () => {
    const { client } = withPunches();
    expect(await client.listAttendanceSpots()).toEqual([{ id: "1", name: "Head office" }, { id: "3", name: "Remote" }]);
  });

  it("records a clock-in and a clock-out as two XHR posts with the page's token", async () => {
    const { server, client } = withPunches();
    const day = await client.recordAttendance({ date: "2026-09-28", clockIn: "10:00", clockOut: "19:00", note: "手続き", spot: "Remote" });
    expect(day).toMatchObject({ date: "2026-09-28", clockIn: "10:00", clockOut: "19:00" });
    const posts = server.requests.filter((r) => r.path === "/employee/adit/insert/");
    expect(posts).toHaveLength(2);
    expect(Object.fromEntries(new URLSearchParams(posts[0]!.body))).toEqual({
      token: "punch-token",
      year: "2026",
      month: "9",
      day: "28",
      client_id: "1000",
      employee_id: "7",
      delete_minutes: "",
      time: "1000",
      group_id: "3",
      notice: "手続き",
      _: "",
    });
    expect(new URLSearchParams(posts[1]!.body).get("time")).toBe("1900");
    expect(punched.get("2026-09-28")).toEqual(["10:00", "19:00"]);
  });

  it("reports Jobcan's field errors and records nothing", async () => {
    const { client } = withPunches();
    await expect(client.recordAttendance({ date: "2026-09-28", clockIn: "10:00", note: "" })).rejects.toThrow(/note/);
    await expect(client.recordAttendance({ date: "2026-09-28", clockIn: "10:00", note: "x", spot: "Moon" })).rejects.toThrow(/Unknown spot/);
    expect(punched.size).toBe(0);
  });

  it("fills a month through the use case, skipping what must be skipped", async () => {
    const { client } = withPunches();
    punched.set("2026-09-01", ["10:00", "19:00"]);
    const outcome = await recordAttendance(client, { month: "2026-09", clockIn: "10:00", clockOut: "19:00", note: "手続き", confirm: true });
    expect(outcome.mode).toBe("recorded");
    if (outcome.mode !== "recorded") return;
    expect(outcome.plan.days.find((d) => d.date === "2026-09-01")?.skipReason).toBe("already_recorded");
    expect(outcome.recorded.map((d) => d.date)).not.toContain("2026-09-01");
    expect(outcome.recorded.map((d) => d.date)).toContain("2026-09-02");
    expect(outcome.recorded.map((d) => d.date)).not.toContain("2026-09-05");
    expect(outcome.recorded.map((d) => d.date)).not.toContain("2026-09-29");
    expect(outcome.failed).toBeUndefined();
    expect([...punched.keys()]).toHaveLength(outcome.recorded.length + 1);
  });
});
