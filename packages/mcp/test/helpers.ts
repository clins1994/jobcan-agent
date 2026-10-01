import type { PlainDate } from "../src/domain/dates.js";
import type { LeaveRequest } from "../src/domain/types.js";

/** The date the tests pretend it is. A Tuesday. */
export const TODAY: PlainDate = "2026-09-29";

let counter = 100;

/** A one-day, full-day paid leave request, pending unless overridden. */
export function request(date: PlainDate, overrides: Partial<LeaveRequest> = {}): LeaveRequest {
  return {
    id: String(counter++),
    from: date,
    to: date,
    leaveTypeId: "1",
    leaveTypeName: "有給休暇(全日)",
    category: "paid",
    balanceKey: "paid",
    unit: "full_day",
    days: 1,
    status: "pending",
    ...overrides,
  };
}
