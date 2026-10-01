#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WriteBlockedError, type JobcanClient } from "./client/client.js";
import { HttpJobcanClient } from "./client/http/http-client.js";
import { Session } from "./client/http/session.js";
import { loadJar, saveJar } from "./client/http/session-store.js";
import { getCredentials } from "./credentials.js";
import { monthRange } from "./domain/dates.js";
import { cancelLeave, checkDate, getLeaveBalance, recordAttendance, replaceLeave, requestLeave } from "./usecases/leave.js";

/** Writes stay off unless the environment turns them on; every write still needs `confirm: true`. */
const ALLOW_WRITES = process.env.JOBCAN_ALLOW_WRITES === "1";

const server = new McpServer({ name: "jobcan-mcp-server", version: "0.1.0" });

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const fail = (err: unknown) => {
  const message =
    err instanceof WriteBlockedError
      ? "Writing to Jobcan is not enabled (set JOBCAN_ALLOW_WRITES=1 for this server). The dry run is as far as it goes."
      : (err as Error).message;
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
};

/** One signed-in HTTP session for the whole process, created on first use. */
let jobcan: Promise<JobcanClient> | undefined;
function client(): Promise<JobcanClient> {
  jobcan ??= (async () => {
    const jar = await loadJar();
    return new HttpJobcanClient({ session: new Session({ jar, allowWrites: ALLOW_WRITES }), getCredentials, onSignedIn: () => saveJar(jar) });
  })();
  return jobcan;
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").describe("YYYY-MM-DD");
const MONTH = z.string().regex(/^\d{4}-\d{2}$/, "YYYY-MM").describe("YYYY-MM");
const TIME = z.string().regex(/^\d{1,2}:\d{2}$/, "HH:MM").describe("HH:MM, on the form's minute grid (usually every 10 minutes)");

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

server.registerTool(
  "jobcan_get_today",
  {
    title: "Today in Jobcan",
    description: "Today's date as Jobcan sees it (Japan time). Use it before working out relative dates like 'next Monday'.",
    inputSchema: {},
    annotations: readOnly,
  },
  async () => {
    try {
      return ok({ today: await (await client()).getToday() });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jobcan_check_date",
  {
    title: "Check a date",
    description:
      "Whether a date is a workday, weekend, national holiday or company holiday according to Jobcan's own calendar, " +
      "whether it is in the past, and any leave already requested for it.",
    inputSchema: { date: DATE },
    annotations: readOnly,
  },
  async ({ date }) => {
    try {
      return ok(await checkDate(await client(), date));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jobcan_get_leave_balance",
  {
    title: "Leave balance",
    description:
      "Remaining days for every leave balance Jobcan tracks. `available` is what can be filed now: `remaining` minus " +
      "days held by requests still waiting for approval. Half days count 0.5; hourly leave counts as a fraction of a day.",
    inputSchema: {},
    annotations: readOnly,
  },
  async () => {
    try {
      return ok(await getLeaveBalance(await client()));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jobcan_list_leave_types",
  {
    title: "Leave types",
    description:
      "The leave types this user can request, with their unit (full day, half day, hourly) and the balance each draws from. " +
      "Names are company-defined; pass the id or the exact name to jobcan_request_leave.",
    inputSchema: {},
    annotations: readOnly,
  },
  async () => {
    try {
      return ok(await (await client()).listLeaveTypes());
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jobcan_list_leave_requests",
  {
    title: "Leave requests",
    description:
      "The user's leave requests with id, dates, type, status (pending, approved, rejected, cancelled) and days used. " +
      "Without `month`, covers about six months back and a year ahead.",
    inputSchema: { month: MONTH.optional() },
    annotations: readOnly,
  },
  async ({ month }) => {
    try {
      return ok(await (await client()).listLeaveRequests(month ? monthRange(month) : undefined));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jobcan_request_leave",
  {
    title: "Request leave",
    description:
      "Plans leave for the given dates and/or range, and files it only when `confirm` is true. Always call without " +
      "`confirm` first and show the user the plan: which dates will be filed, which are skipped and why (weekend, holiday, " +
      "already requested, past), the balance before and after, and the reason that will be sent. " +
      "If `status` is `insufficient_balance`, present `options` and let the user choose; never pick one. " +
      "If `reasonSource` is not `given`, the reason was taken from the user's past requests or is a stock phrase: " +
      "say so in the preview. Hourly leave needs `time`; a half day at a company with hourly leave is half the day's hours. " +
      "Only pass `confirm: true` after the user has approved that exact plan.",
    inputSchema: {
      dates: z.array(DATE).optional().describe("Individual dates"),
      range: z.object({ from: DATE, to: DATE }).optional().describe("Inclusive range; non-workdays are skipped"),
      leave_type: z.string().describe("Leave type id or exact name, from jobcan_list_leave_types"),
      time: z.object({ start: TIME, end: TIME }).optional().describe("Hourly leave only: hours off on each date"),
      reason: z.string().max(500).optional().describe("Reason as the user gave it. Leave out to reuse their usual one."),
      fields: z.record(z.string()).optional().describe("Values for company-defined fields, by field name or label"),
      allow_past: z.boolean().optional().describe("File for dates before today (e.g. sick leave after the fact)"),
      confirm: z.boolean().optional().describe("true = file the plan. Anything else is a dry run."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ dates, range, leave_type, time, reason, fields, allow_past, confirm }) => {
    try {
      return ok(
        await requestLeave(await client(), {
          dates,
          range,
          leaveType: leave_type,
          time,
          reason,
          fields,
          allowPast: allow_past,
          confirm: confirm === true,
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jobcan_cancel_leave_request",
  {
    title: "Cancel a leave request",
    description:
      "Withdraws a leave request that is still waiting for approval. Without `confirm`, shows the request that would be " +
      "withdrawn. An approved request cannot be withdrawn here: the result says to contact the administrator. " +
      "If the user's description matches several requests, ask which one before calling this.",
    inputSchema: { id: z.string().describe("Request id from jobcan_list_leave_requests"), confirm: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, confirm }) => {
    try {
      return ok(await cancelLeave(await client(), { id, confirm: confirm === true }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jobcan_replace_leave",
  {
    title: "Replace a leave request",
    description:
      "Changes a request that is still waiting for approval, e.g. 'make the half day on the 25th a full day': withdraws it " +
      "and files the replacement on the same date (or the dates given). Without `confirm`, shows the request that would be " +
      "withdrawn and the plan for the new one, with the balance as it will be after both. The old request is only withdrawn " +
      "once the new one is ready to file; if Jobcan then refuses the new one, the result says the day is now uncovered. " +
      "An approved request cannot be changed here: the result says to contact the administrator. " +
      "Find the request with jobcan_list_leave_requests first; if several match the user's description, ask which.",
    inputSchema: {
      id: z.string().describe("Id of the pending request to replace"),
      leave_type: z.string().describe("Leave type id or exact name for the new request"),
      dates: z.array(DATE).optional().describe("Dates for the new request; defaults to the old request's date"),
      range: z.object({ from: DATE, to: DATE }).optional(),
      time: z.object({ start: TIME, end: TIME }).optional().describe("Hourly leave only"),
      reason: z.string().max(500).optional().describe("Leave out to reuse the old request's reason or the user's usual one"),
      fields: z.record(z.string()).optional(),
      confirm: z.boolean().optional().describe("true = withdraw the old request and file the new one"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ id, leave_type, dates, range, time, reason, fields, confirm }) => {
    try {
      return ok(await replaceLeave(await client(), { id, replacement: { leaveType: leave_type, dates, range, time, reason, fields }, confirm: confirm === true }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jobcan_get_timesheet",
  {
    title: "Timesheet",
    description: "One month of attendance: for each day whether it is a workday, and the clock-in, clock-out, worked and break times recorded.",
    inputSchema: { month: MONTH },
    annotations: readOnly,
  },
  async ({ month }) => {
    try {
      return ok(await (await client()).getTimesheet(month));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jobcan_list_attendance_spots",
  {
    title: "Attendance spots",
    description: "The places a clock-in can be recorded from, as the company configured them. Pass an id or name as `spot` to jobcan_record_attendance.",
    inputSchema: {},
    annotations: readOnly,
  },
  async () => {
    try {
      return ok(await (await client()).listAttendanceSpots());
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jobcan_record_attendance",
  {
    title: "Record attendance",
    description:
      "Fills in clock-in and clock-out times for days that were worked but never clocked, e.g. every workday of a month " +
      "with the same hours. Skips weekends, holidays, days already recorded, days on full-day leave, and today or later. " +
      "On a day with hourly leave, records the hours around the leave (leave at the start pushes the clock-in later, leave " +
      "at the end pulls the clock-out earlier); leave in the middle of the day is a question for the user, not a guess. " +
      "Always call without `confirm` first and show the user every day: before, after, and why a day is skipped. " +
      "If `status` is `needs_input`, settle each `question` with the user before anything else. " +
      "Only pass `confirm: true` after the user has approved that exact plan. Manual records wait for approval in Jobcan.",
    inputSchema: {
      month: MONTH.optional(),
      dates: z.array(DATE).optional(),
      range: z.object({ from: DATE, to: DATE }).optional(),
      clock_in: TIME,
      clock_out: TIME,
      note: z.string().max(200).describe("Note Jobcan requires on manual records, e.g. the user's usual phrase"),
      spot: z.string().optional().describe("Spot id or name from jobcan_list_attendance_spots; the first one when left out"),
      include_today: z.boolean().optional().describe("Record today as well, e.g. after the working day is over"),
      confirm: z.boolean().optional().describe("true = record the plan. Anything else is a dry run."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ month, dates, range, clock_in, clock_out, note, spot, include_today, confirm }) => {
    try {
      return ok(
        await recordAttendance(await client(), {
          month,
          dates,
          range,
          clockIn: clock_in,
          clockOut: clock_out,
          note,
          spot,
          includeToday: include_today,
          confirm: confirm === true,
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jobcan_discover_forms",
  {
    title: "Discover a request form",
    description:
      "Read-only. Describes the leave request form as this company configured it: every field, whether it is required, " +
      "the choices of each select, and a fingerprint that changes when the form's structure changes.",
    inputSchema: { request_type: z.enum(["leave"]).default("leave") },
    annotations: readOnly,
  },
  async ({ request_type }) => {
    try {
      return ok(await (await client()).discoverForm(request_type));
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Dev helper, browser based: loaded only when called so the server starts without Playwright --------
server.registerTool(
  "jobcan_inspect_page",
  {
    title: "Inspect Jobcan page (browser)",
    description:
      "Dev helper using a headless browser. Opens a 勤怠管理 page (path relative to https://ssl.jobcan.jp) and returns its " +
      "forms, fields, select options and links. Needs Playwright's browser installed.",
    inputSchema: { path: z.string().startsWith("/").describe("Path like '/employee' or '/employee/holiday/new'") },
    annotations: readOnly,
  },
  async ({ path }) => {
    try {
      const [{ URLS }, { gotoAuthed, withPage }] = await Promise.all([import("./config.js"), import("./browser.js")]);
      return ok(
        await withPage(async (page) => {
          await gotoAuthed(page, URLS.attendanceBase + path);
          return page.evaluate(() => {
            const label = (el: Element) =>
              (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim()) ||
              el.closest("tr")?.querySelector("th")?.textContent?.trim() ||
              undefined;
            return {
              url: location.href,
              title: document.title,
              forms: [...document.forms].map((f) => ({
                action: f.getAttribute("action"),
                fields: [...f.querySelectorAll("input, select, textarea, button")]
                  .filter((el) => (el as HTMLInputElement).type !== "hidden")
                  .map((el) => ({
                    tag: el.tagName.toLowerCase(),
                    type: (el as HTMLInputElement).type,
                    name: el.getAttribute("name"),
                    id: el.id || undefined,
                    label: label(el),
                    options:
                      el instanceof HTMLSelectElement ? [...el.options].slice(0, 60).map((o) => `${o.value}=${o.text.trim()}`) : undefined,
                  })),
              })),
              links: [...document.querySelectorAll("a[href]")]
                .map((a) => `${a.textContent?.trim()} -> ${a.getAttribute("href")}`)
                .filter((s) => !s.startsWith(" ->"))
                .slice(0, 80),
            };
          });
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`jobcan-mcp-server running on stdio (${ALLOW_WRITES ? "writes enabled, each needs confirm" : "read-only"})`);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    import("./browser.js")
      .then(({ closeBrowser }) => closeBrowser())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
}
