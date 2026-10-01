import type { DateRange, PlainDate, PlainMonth } from "../domain/dates.js";
import type { FormRequestType, FormSchema } from "../domain/forms.js";
import type { CalendarDay } from "../domain/holidays.js";
import type {
  AttendanceRecord,
  AttendanceSpot,
  LeaveBalance,
  LeaveRequest,
  LeaveSubmission,
  LeaveType,
  TimesheetDay,
} from "../domain/types.js";

/**
 * Everything the tools need from Jobcan, and nothing else. Implementations differ in
 * transport only (plain HTTP, browser, in-memory fake); they hold no business rules.
 *
 * Dry runs are not a client concern. A caller that has not been confirmed by the user
 * never reaches a write method.
 */
export interface JobcanClient {
  // --- reads ---

  /** Jobcan's own calendar. May omit days it has no data for. */
  getCalendar(range: DateRange): Promise<CalendarDay[]>;
  listLeaveTypes(): Promise<LeaveType[]>;
  /** Only categories Jobcan tracks a balance for. */
  getLeaveBalances(): Promise<LeaveBalance[]>;
  listLeaveRequests(range?: DateRange): Promise<LeaveRequest[]>;
  getLeaveRequest(id: string): Promise<LeaveRequest | undefined>;
  discoverForm(requestType: FormRequestType): Promise<FormSchema>;
  getTimesheet(month: PlainMonth): Promise<TimesheetDay[]>;
  listAttendanceSpots(): Promise<AttendanceSpot[]>;
  /** Today's date as Jobcan sees it. */
  getToday(): Promise<PlainDate>;

  // --- writes ---

  submitLeaveRequest(submission: LeaveSubmission): Promise<LeaveRequest>;
  cancelLeaveRequest(id: string): Promise<LeaveRequest>;
  /** Adds clock times to a day and returns the day as Jobcan now shows it. */
  recordAttendance(record: AttendanceRecord): Promise<TimesheetDay>;
}

export const WRITE_METHODS = ["submitLeaveRequest", "cancelLeaveRequest", "recordAttendance"] as const satisfies readonly (keyof JobcanClient)[];

export type WriteMethod = (typeof WRITE_METHODS)[number];

/** Jobcan refused a request, e.g. a validation error on a form. */
export class JobcanRejection extends Error {
  constructor(readonly messages: string[]) {
    super(`Jobcan rejected the request: ${messages.join(" / ")}`);
    this.name = "JobcanRejection";
  }
}

export class WriteBlockedError extends Error {
  constructor(
    readonly method: WriteMethod,
    detail?: string,
  ) {
    super(`${method} is blocked: ${detail ?? "this client is read-only"}`);
    this.name = "WriteBlockedError";
  }
}

/** Wraps a client so that every write throws before anything is sent. */
export function readOnly(client: JobcanClient): JobcanClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if ((WRITE_METHODS as readonly string[]).includes(prop as string)) {
        return async () => {
          throw new WriteBlockedError(prop as WriteMethod);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
