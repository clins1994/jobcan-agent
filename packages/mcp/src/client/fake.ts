import { pendingDays } from "../domain/balance.js";
import { monthRange, rangeContains, type DateRange, type PlainDate, type PlainMonth } from "../domain/dates.js";
import { buildFormValues, timeToMinutes, validateFormValues, type FormRequestType, type FormSchema } from "../domain/forms.js";
import type { CalendarDay } from "../domain/holidays.js";
import { findConflict } from "../domain/leave-plan.js";
import type {
  AttendanceRecord,
  AttendanceSpot,
  LeaveBalance,
  LeaveCategory,
  LeaveRequest,
  LeaveSubmission,
  LeaveType,
  TimesheetDay,
} from "../domain/types.js";
import { JobcanRejection, type JobcanClient, type WriteMethod } from "./client.js";
import { minimalForm, type FormFixture } from "./fixtures.js";

export interface FakeClientOptions {
  today: PlainDate;
  /** `HH:MM`, used by `punch`. */
  now?: string;
  fixture?: FormFixture;
  /** Remaining days per balance key, not counting requests that are still pending. */
  balances?: Record<string, number>;
  /** Report balances with pending requests already taken out, as some setups may. */
  balancesDeductPending?: boolean;
  requests?: LeaveRequest[];
  /** Days Jobcan has calendar data for. Anything else is omitted from `getCalendar`. */
  calendar?: CalendarDay[];
  timesheet?: TimesheetDay[];
  spots?: AttendanceSpot[];
}

export interface WriteRecord {
  method: WriteMethod;
  args: unknown;
}

/** In-memory Jobcan. Holds state, validates like the real forms do, and records every write. */
export class FakeClient implements JobcanClient {
  /** Every write attempted, in order, including rejected ones. */
  readonly writes: WriteRecord[] = [];

  private readonly today: PlainDate;
  private readonly now: string;
  private readonly fixture: FormFixture;
  private readonly balances: Map<string, number>;
  private readonly balancesDeductPending: boolean;
  private readonly requests: LeaveRequest[];
  private readonly calendar: CalendarDay[];
  private readonly timesheet: TimesheetDay[];
  private readonly spots: AttendanceSpot[];

  constructor(options: FakeClientOptions) {
    this.today = options.today;
    this.now = options.now ?? "09:00";
    this.fixture = options.fixture ?? minimalForm;
    this.balances = new Map(Object.entries(options.balances ?? {}));
    this.balancesDeductPending = options.balancesDeductPending ?? false;
    this.requests = structuredClone(options.requests ?? []);
    this.calendar = structuredClone(options.calendar ?? []);
    this.timesheet = structuredClone(options.timesheet ?? []);
    this.spots = structuredClone(options.spots ?? [{ id: "1", name: "本社" }]);
  }

  // --- reads ---

  async getToday(): Promise<PlainDate> {
    return this.today;
  }

  async getCalendar(range: DateRange): Promise<CalendarDay[]> {
    return structuredClone(this.calendar.filter((d) => rangeContains(range, d.date)));
  }

  async listLeaveTypes(): Promise<LeaveType[]> {
    return structuredClone(this.fixture.leaveTypes);
  }

  async getLeaveBalances(): Promise<LeaveBalance[]> {
    return [...this.balances].map(([key, remaining]) => ({
      key,
      label: key,
      category: this.categoryOf(key),
      remainingDays: this.balancesDeductPending ? remaining - pendingDays(this.requests, key) : remaining,
      pendingAlreadyDeducted: this.balancesDeductPending,
    }));
  }

  async listLeaveRequests(range?: DateRange): Promise<LeaveRequest[]> {
    const inRange = (r: LeaveRequest) => !range || (r.from <= range.to && r.to >= range.from);
    return structuredClone(this.requests.filter(inRange));
  }

  async getLeaveRequest(id: string): Promise<LeaveRequest | undefined> {
    return structuredClone(this.requests.find((r) => r.id === id));
  }

  async discoverForm(requestType: FormRequestType): Promise<FormSchema> {
    if (requestType !== "leave") throw new Error(`The fake has no "${requestType}" form`);
    return structuredClone(this.fixture.form);
  }

  async getTimesheet(month: PlainMonth): Promise<TimesheetDay[]> {
    const range = monthRange(month);
    return structuredClone(this.timesheet.filter((d) => rangeContains(range, d.date)));
  }

  async listAttendanceSpots(): Promise<AttendanceSpot[]> {
    return structuredClone(this.spots);
  }

  // --- writes ---

  async submitLeaveRequest(submission: LeaveSubmission): Promise<LeaveRequest> {
    this.writes.push({ method: "submitLeaveRequest", args: structuredClone(submission) });

    const issues = validateFormValues(this.fixture.form, buildFormValues(this.fixture.form, submission));
    if (issues.length > 0) throw new JobcanRejection(issues.map((i) => i.message));

    const type = this.fixture.leaveTypes.find((t) => t.id === submission.leaveTypeId)!;
    const conflict = findConflict(this.requests, submission.date, type.unit, submission.time);
    if (conflict) throw new JobcanRejection([`${submission.date} はすでに申請されています (No. ${conflict.id})`]);

    let days = type.days;
    if (type.unit === "hourly") {
      const [start, end] = [submission.time?.start, submission.time?.end].map((t) => (t ? timeToMinutes(t) : undefined));
      if (start === undefined || end === undefined || end <= start) throw new JobcanRejection(["休暇時間を正しく入力してください"]);
      days = (end - start) / (type.minutesPerDay ?? 480);
    }
    const remaining = this.balances.get(type.balanceKey);
    if (remaining !== undefined && remaining - pendingDays(this.requests, type.balanceKey) < days) {
      throw new JobcanRejection(["休暇の残日数が不足しています"]);
    }

    const request: LeaveRequest = {
      id: this.nextId(),
      from: submission.date,
      to: submission.date,
      leaveTypeId: type.id,
      leaveTypeName: type.name,
      category: type.category,
      balanceKey: type.balanceKey,
      unit: type.unit,
      days,
      status: "pending",
      requestedOn: this.today,
      ...(submission.time ? { time: submission.time } : {}),
      ...(submission.reason ? { reason: submission.reason } : {}),
    };
    this.requests.push(request);
    return structuredClone(request);
  }

  async cancelLeaveRequest(id: string): Promise<LeaveRequest> {
    this.writes.push({ method: "cancelLeaveRequest", args: { id } });
    const request = this.requests.find((r) => r.id === id);
    if (!request) throw new JobcanRejection([`申請 No. ${id} が見つかりません`]);
    if (request.status !== "pending") throw new JobcanRejection([`申請 No. ${id} は取り消せません (${request.status})`]);
    request.status = "cancelled";
    return structuredClone(request);
  }

  /** Like Jobcan: a note is required, each time is one record, and manual records wait for approval. */
  async recordAttendance(record: AttendanceRecord): Promise<TimesheetDay> {
    this.writes.push({ method: "recordAttendance", args: structuredClone(record) });
    if (!record.note.trim()) throw new JobcanRejection(["notice: empty"]);
    if (!record.clockIn && !record.clockOut) throw new JobcanRejection(["time: empty"]);
    const spot = record.spot === undefined ? this.spots[0] : this.spots.find((s) => s.id === record.spot || s.name === record.spot);
    if (!spot) throw new JobcanRejection(["group_id: invalid"]);
    for (const t of [record.clockIn, record.clockOut]) {
      if (t !== undefined && timeToMinutes(t) === undefined) throw new JobcanRejection([`time: invalid (${t})`]);
    }
    const day = this.timesheetDay(record.date);
    if (record.clockIn) day.clockIn = record.clockIn;
    if (record.clockOut) day.clockOut = record.clockOut;
    day.pendingApproval = true;
    return structuredClone(day);
  }

  // --- test controls: what an approver would do in the real system ---

  approve(id: string): void {
    const request = this.mustFind(id);
    const remaining = this.balances.get(request.balanceKey);
    if (remaining !== undefined) this.balances.set(request.balanceKey, remaining - request.days);
    request.status = "approved";
  }

  reject(id: string): void {
    this.mustFind(id).status = "rejected";
  }

  private mustFind(id: string): LeaveRequest {
    const request = this.requests.find((r) => r.id === id);
    if (!request) throw new Error(`No request ${id} in the fake`);
    return request;
  }

  private categoryOf(balanceKey: string): LeaveCategory {
    return this.fixture.leaveTypes.find((t) => t.balanceKey === balanceKey)?.category ?? "other";
  }

  private nextId(): string {
    const max = Math.max(0, ...this.requests.map((r) => Number(r.id)).filter(Number.isFinite));
    return String(max + 1);
  }

  private timesheetDay(date: PlainDate): TimesheetDay {
    let day = this.timesheet.find((d) => d.date === date);
    if (!day) {
      day = { date, isWorkday: true };
      this.timesheet.push(day);
    }
    return day;
  }
}
