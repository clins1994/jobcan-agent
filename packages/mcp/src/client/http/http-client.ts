import {
  addDays,
  DEFAULT_TIME_ZONE,
  monthOf,
  monthRange,
  rangeContains,
  todayIn,
  toParts,
  type DateRange,
  type PlainDate,
  type PlainMonth,
} from "../../domain/dates.js";
import type { FormRequestType, FormSchema } from "../../domain/forms.js";
import type { CalendarDay } from "../../domain/holidays.js";
import type {
  AttendanceRecord,
  AttendanceSpot,
  LeaveBalance,
  LeaveRequest,
  LeaveSubmission,
  LeaveType,
  TimesheetDay,
} from "../../domain/types.js";
import { buildFormValues, timeToMinutes } from "../../domain/forms.js";
import { JobcanRejection, WriteBlockedError, type JobcanClient, type WriteMethod } from "../client.js";
import { isEmployeePage, login, type Credentials, type LoginResult } from "./login.js";
import {
  parseAttendancePage,
  parseClockEditPage,
  parseLeaveFormPage,
  parseLeaveListPage,
  parseRecordResult,
  parseReviewPage,
  parseWithdrawPage,
  type AttendancePage,
  type JobcanHoliday,
  type LeaveFormPage,
  type LeaveListRow,
} from "./parsers.js";
import { ATTENDANCE_ORIGIN, RequestBlockedError, type HttpResponse, type Session } from "./session.js";

export interface HttpClientOptions {
  session: Session;
  getCredentials: () => Promise<Credentials>;
  /** Called after a sign-in, so the session can be saved. */
  onSignedIn?: () => Promise<void>;
  now?: () => Date;
}

/** How far back and ahead "all requests" reaches when no range is given. */
const LIST_DAYS_BACK = 180;
const LIST_DAYS_AHEAD = 365;

function monthsIn(range: DateRange): PlainMonth[] {
  const months: PlainMonth[] = [];
  for (let m = monthOf(range.from); m <= monthOf(range.to); m = monthOf(addDays(monthRange(m).to, 1))) months.push(m);
  return months;
}

function termQuery(range: DateRange): URLSearchParams {
  const from = toParts(range.from);
  const to = toParts(range.to);
  return new URLSearchParams({
    search_type: "term",
    "from[y]": String(from.year),
    "from[m]": String(from.month),
    "from[d]": String(from.day),
    "to[y]": String(to.year),
    "to[m]": String(to.month),
    "to[d]": String(to.day),
  });
}

/**
 * Jobcan over plain HTTP. Reads always work. Writes work only when the session was
 * created with `allowWrites`; otherwise they are refused here and below.
 */
export class HttpJobcanClient implements JobcanClient {
  private readonly session: Session;
  private readonly getCredentials: () => Promise<Credentials>;
  private readonly onSignedIn?: () => Promise<void>;
  private readonly now: () => Date;
  private readonly attendance = new Map<PlainMonth, AttendancePage>();
  private leaveForm?: LeaveFormPage;

  constructor(options: HttpClientOptions) {
    this.session = options.session;
    this.getCredentials = options.getCredentials;
    this.onSignedIn = options.onSignedIn;
    this.now = options.now ?? (() => new Date());
  }

  async signIn(): Promise<LoginResult> {
    const result = await login(this.session, this.getCredentials);
    if (result.signedIn) await this.onSignedIn?.();
    return result;
  }

  /** Fetches a 勤怠管理 page, signing in first when the session has lapsed. */
  async page(pathAndQuery: string): Promise<HttpResponse> {
    const url = `${ATTENDANCE_ORIGIN}${pathAndQuery}`;
    let response = await this.session.get(url, `${ATTENDANCE_ORIGIN}/employee`);
    if (!isEmployeePage(response)) {
      await this.signIn();
      response = await this.session.get(url, `${ATTENDANCE_ORIGIN}/employee`);
    }
    if (!isEmployeePage(response)) throw new Error(`Jobcan did not return ${pathAndQuery.split("?")[0]} after signing in`);
    if (response.status !== 200) throw new Error(`Jobcan answered ${response.status} for ${pathAndQuery.split("?")[0]}`);
    return response;
  }

  // --- reads ---

  async getToday(): Promise<PlainDate> {
    return todayIn(DEFAULT_TIME_ZONE, this.now());
  }

  private async attendancePage(month: PlainMonth): Promise<AttendancePage> {
    const cached = this.attendance.get(month);
    if (cached) return cached;
    const range = monthRange(month);
    const { year, month: mon } = toParts(range.from);
    const query = termQuery(range);
    query.set("list_type", "normal");
    query.set("search_type", "month");
    query.set("year", String(year));
    query.set("month", String(mon));
    const parsed = parseAttendancePage((await this.page(`/employee/attendance?${query}`)).body);
    this.attendance.set(month, parsed);
    return parsed;
  }

  async getTimesheet(month: PlainMonth): Promise<TimesheetDay[]> {
    const range = monthRange(month);
    return (await this.attendancePage(month)).days.filter((d) => rangeContains(range, d.date));
  }

  private async clockEditPage(date: PlainDate) {
    const { year, month, day } = toParts(date);
    return parseClockEditPage((await this.page(`/employee/adit/modify?year=${year}&month=${month}&day=${day}`)).body);
  }

  async listAttendanceSpots(): Promise<AttendanceSpot[]> {
    return (await this.clockEditPage(await this.getToday())).spots;
  }

  async getCalendar(range: DateRange): Promise<CalendarDay[]> {
    const days: CalendarDay[] = [];
    for (const month of monthsIn(range)) {
      for (const day of await this.getTimesheet(month)) {
        if (!rangeContains(range, day.date)) continue;
        days.push({ date: day.date, isWorkday: day.isWorkday, ...(day.label ? { label: day.label } : {}) });
      }
    }
    return days;
  }

  private async leaveFormPage(): Promise<LeaveFormPage> {
    this.leaveForm ??= parseLeaveFormPage((await this.page("/employee/holiday/new")).body);
    return this.leaveForm;
  }

  private async holidays(): Promise<JobcanHoliday[]> {
    return (await this.leaveFormPage()).holidays;
  }

  async listLeaveTypes(): Promise<LeaveType[]> {
    return (await this.holidays()).map(({ balanceLabel: _, ...type }) => type);
  }

  /** Minutes of hourly leave that make one day, as the form states it. */
  async hourlyLeaveDayMinutes(): Promise<number | undefined> {
    return (await this.leaveFormPage()).hourlyLeaveDayMinutes;
  }

  async discoverForm(requestType: FormRequestType): Promise<FormSchema> {
    if (requestType !== "leave") throw new Error(`Discovery of the "${requestType}" form is not implemented yet`);
    return (await this.leaveFormPage()).form;
  }

  async getLeaveBalances(): Promise<LeaveBalance[]> {
    const [page, holidays] = [await this.attendancePage(monthOf(await this.getToday())), await this.holidays()];
    return page.balances.map((row) => {
      const holiday = holidays.find((h) => h.balanceLabel === row.label);
      return {
        key: holiday?.balanceKey ?? `label:${row.label}`,
        label: row.label,
        category: holiday?.category ?? "other",
        remainingDays: row.remainingDays,
        // not yet known for real Jobcan; false can only understate what is available
        pendingAlreadyDeducted: false,
      };
    });
  }

  async listLeaveRequests(range?: DateRange): Promise<LeaveRequest[]> {
    const today = await this.getToday();
    const window = range ?? { from: addDays(today, -LIST_DAYS_BACK), to: addDays(today, LIST_DAYS_AHEAD) };
    const rows = parseLeaveListPage((await this.page(`/employee/holiday/?${termQuery(window)}`)).body);
    const { holidays, hourlyLeaveDayMinutes } = await this.leaveFormPage();
    return rows.map((row) => toLeaveRequest(row, holidays, hourlyLeaveDayMinutes));
  }

  async getLeaveRequest(id: string): Promise<LeaveRequest | undefined> {
    return (await this.listLeaveRequests()).find((r) => r.id === id);
  }

  // --- writes ---

  private assertWrites(method: WriteMethod): void {
    if (!this.session.allowWrites) throw new WriteBlockedError(method);
  }

  /** Runs a write; a refusal from the session is reported as a blocked write, not a transport error. */
  private async write<T>(method: WriteMethod, run: () => Promise<T>): Promise<T> {
    this.assertWrites(method);
    try {
      return await run();
    } catch (err) {
      if (err instanceof RequestBlockedError) throw new WriteBlockedError(method, err.message);
      throw err;
    }
  }

  /**
   * Files one day of leave the way the browser does: post the form to the review step,
   * then post the review page's own hidden form to save. Jobcan validates at the review
   * step and answers with the form again when it refuses.
   */
  async submitLeaveRequest(submission: LeaveSubmission): Promise<LeaveRequest> {
    return this.write("submitLeaveRequest", async () => {
      const formPage = await this.leaveFormPage();
      const body = {
        ...formPage.hidden,
        work_unixtime: "",
        ...buildFormValues(formPage.form, submission),
      };
      const review = await this.session.postForm(`${ATTENDANCE_ORIGIN}/employee/holiday/confirm`, body, `${ATTENDANCE_ORIGIN}/employee/holiday/new`);
      const parsed = parseReviewPage(review.body);
      if ("errors" in parsed) throw new JobcanRejection(parsed.errors);

      const saved = await this.session.postForm(`${ATTENDANCE_ORIGIN}/employee/holiday/save`, parsed.saveForm, review.url);
      if (saved.unfollowedRedirect) console.error(`jobcan: saved, then not following the redirect to ${saved.unfollowedRedirect}`);
      const accepted = /\/employee\/holiday\/finish/.test(saved.url) || saved.unfollowedRedirect !== undefined;
      if (!accepted) {
        const again = parseReviewPage(saved.body);
        throw new JobcanRejection("errors" in again ? again.errors : [`Jobcan ended at ${new URL(saved.url).pathname} instead of confirming`]);
      }

      const filed = (await this.listLeaveRequests({ from: submission.date, to: submission.date }))
        .filter((r) => r.from === submission.date && r.leaveTypeId === submission.leaveTypeId && r.status === "pending")
        .sort((a, b) => Number(b.id) - Number(a.id))[0];
      if (!filed) throw new Error(`Jobcan confirmed the request for ${submission.date}, but it is not in the list yet`);
      return filed;
    });
  }

  /** Withdraws a pending request through Jobcan's confirmation page and its delete link. */
  async cancelLeaveRequest(id: string): Promise<LeaveRequest> {
    return this.write("cancelLeaveRequest", async () => {
      const before = await this.getLeaveRequest(id);
      if (!before) throw new JobcanRejection([`Request ${id} was not found`]);
      if (before.status !== "pending") throw new JobcanRejection([`Request ${id} is ${before.status}, and only pending requests can be withdrawn`]);

      const confirm = await this.page(`/employee/holiday/delete-confirm/?applied_id=${encodeURIComponent(id)}`);
      const link = parseWithdrawPage(confirm.body);
      if (!link) throw new JobcanRejection([`Jobcan offers no way to withdraw request ${id}`]);
      const deleted = await this.session.get(new URL(link, ATTENDANCE_ORIGIN).toString(), confirm.url);
      if (deleted.unfollowedRedirect) console.error(`jobcan: withdrew, then not following the redirect to ${deleted.unfollowedRedirect}`);

      const after = await this.getLeaveRequest(id);
      if (after && after.status === "pending") throw new Error(`Jobcan did not withdraw request ${id}`);
      return { ...before, status: "cancelled" };
    });
  }

  /**
   * Adds clock times to a day the way the page's script does: one XHR per time, with the
   * form's own token and ids. Jobcan answers `{result: 1}` or a map of field errors.
   */
  async recordAttendance(record: AttendanceRecord): Promise<TimesheetDay> {
    return this.write("recordAttendance", async () => {
      const times = [record.clockIn, record.clockOut].filter((t): t is string => t !== undefined);
      if (times.length === 0) throw new JobcanRejection(["Nothing to record: give a clock-in or a clock-out time"]);
      for (const t of times) if (timeToMinutes(t) === undefined) throw new JobcanRejection([`"${t}" is not a time (HH:MM)`]);
      if (!record.note.trim()) throw new JobcanRejection(["Jobcan requires a note on a manual record"]);

      const page = await this.clockEditPage(record.date);
      const spot = record.spot === undefined ? page.spots[0] : page.spots.find((s) => s.id === record.spot || s.name === record.spot);
      if (!spot) throw new JobcanRejection([`Unknown spot "${record.spot}"; choose one of ${page.spots.map((s) => s.name).join(", ")}`]);

      const { year, month, day } = toParts(record.date);
      const referer = `${ATTENDANCE_ORIGIN}/employee/adit/modify?year=${year}&month=${month}&day=${day}`;
      for (const t of times) {
        const minutes = timeToMinutes(t)!;
        const body = {
          ...page.hidden,
          time: `${String(Math.floor(minutes / 60)).padStart(2, "0")}${String(minutes % 60).padStart(2, "0")}`,
          group_id: spot.id,
          notice: record.note,
          _: "",
        };
        const answer = await this.session.postForm(`${ATTENDANCE_ORIGIN}/employee/adit/insert/`, body, referer, { xhr: true });
        const result = parseRecordResult(answer.body);
        if (!result.ok) throw new JobcanRejection(result.errors.map((e) => `${record.date} ${t}: ${e}`));
      }

      this.attendance.delete(monthOf(record.date));
      const after = (await this.getTimesheet(monthOf(record.date))).find((d) => d.date === record.date);
      if (!after) throw new Error(`Jobcan accepted the record for ${record.date}, but the day is missing from the timesheet`);
      return after;
    });
  }
}

export function toLeaveRequest(row: LeaveListRow, holidays: JobcanHoliday[], dayMinutes?: number): LeaveRequest {
  const holiday = holidays.find((h) => h.name === row.leaveTypeName);
  const days = row.days ?? (row.minutes !== undefined && dayMinutes ? row.minutes / dayMinutes : 0);
  return {
    id: row.id,
    from: row.from,
    to: row.to,
    ...(holiday ? { leaveTypeId: holiday.id } : {}),
    leaveTypeName: row.leaveTypeName,
    category: holiday?.category ?? "other",
    balanceKey: holiday?.balanceKey ?? `name:${row.leaveTypeName}`,
    // a type we cannot place is treated as a full day, so its date stays protected
    unit: holiday?.unit ?? "full_day",
    days,
    status: row.status,
    ...(row.time ? { time: row.time } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.requestedOn ? { requestedOn: row.requestedOn } : {}),
  };
}
