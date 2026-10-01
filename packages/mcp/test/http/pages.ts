/**
 * Synthetic pages with the structure of Jobcan's English UI. The data in them is made
 * up; only the markup the parsers rely on is kept.
 */

export interface DayRow {
  date: string;
  label?: string;
  clockIn?: string;
  clockOut?: string;
  worked?: string;
  rest?: string;
  status?: string;
}

export function attendancePage(days: DayRow[], balances: [string, string][] = []): string {
  const row = (d: DayRow) => {
    const [y, m, day] = d.date.split("-").map(Number);
    const query = `year=${y}&month=${m}&day=${day}`;
    return `<tr ><td><a class="jbc-text-reset" href="#" role="button" data-toggle="dropdown">${String(m).padStart(2, "0")}/${String(day).padStart(2, "0")}(Day)</a>
      <div class="dropdown-menu"><a href="/employee/adit/modify?${query}" class="dropdown-item">Clock Time Edition</a>
      <a href="/employee/holiday/new?holiday_year=${y}&holiday_month=${m}&holiday_day=${day}" class="dropdown-item">Vacation Requests</a></div></td>
      <td>${d.label ?? ""}</td><td>10:00～19:00</td><td>${d.clockIn ?? ""}</td><td>${d.clockOut ?? ""}</td><td>${d.worked ?? ""}</td>
      <td></td><td></td><td></td><td>${d.rest ?? ""}</td>
      <td><div data-toggle="tooltip" title="">${d.status ? `<a href="/employee/holiday/info?applied_id=9"><font>${d.status}</font></a>` : ""}</div></td></tr>`;
  };
  const balanceRows = balances
    .map(([label, value]) => `<tr><th scope="row" class="jbc-text-sub">${label}</th><td><span class="info-content">${value}</span></td></tr>`)
    .join("");
  return `<!DOCTYPE html><html lang="en"><body><div class="jbc-container">
    <div class="row">
      <div class="col-lg-6 mb-3"><div class="card jbc-card-bordered"><div class="card-header jbc-card-header"><h5 class="card-text">Basic Info</h5></div>
        <div class="card-body"><table class="table jbc-table info-contents"><tr><th scope="row">Working Hours</th><td><span class="info-content">160:00</span></td></tr></table></div></div></div>
      <div class="col-lg-6 mb-3">
        <div class="card jbc-card-bordered mb-3"><div class="card-header jbc-card-header"><h5 class="card-text">Displaying month Remaining Vacations</h5></div>
          <div class="card-body"><table class="table jbc-table info-contents">${balanceRows}</table></div></div>
        <div class="card jbc-card-bordered"><div class="card-header jbc-card-header"><h5 class="card-text">Vacations Taken</h5></div>
          <div class="card-body"><table class="table jbc-table info-contents"><tr><th scope="row">Annual leave (full day)</th><td><span class="info-content">1.00</span></td></tr></table></div></div>
      </div>
    </div>
    <div class="table-responsive"><table class="table jbc-table"><thead><tr class="jbc-table-header">
      <th>Date</th><th>Holiday<br />Type</th><th>ShiftsTime</th><th>Actual Clock-ins</th><th>Actual Clock-outs</th><th>Working Hours</th>
      <th>Off-shift Working Hours</th><th>Overtime</th><th>Night Shift</th><th>Break</th><th>Attendance Status</th></tr></thead>
      <tbody>${days.map(row).join("")}</tbody></table></div>
  </div></body></html>`;
}

export interface HolidayEntry {
  id: string;
  name: string;
  holidayType: string;
  paidType: string;
  balanceLabel: string;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

export const HOLIDAYS: HolidayEntry[] = [
  { id: "1", name: "Annual leave (full day)", holidayType: "paid", paidType: "10", balanceLabel: "Paid Vacations" },
  { id: "2", name: "Annual leave (午前半休)", holidayType: "paid", paidType: "5", balanceLabel: "Paid Vacations" },
  { id: "3", name: "Annual leave (午後半休)", holidayType: "paid", paidType: "5", balanceLabel: "Paid Vacations" },
  { id: "4", name: "Annual leave (hourly)", holidayType: "paid", paidType: "-1", balanceLabel: "Paid Vacations" },
  { id: "7", name: "Compensatory (full day)", holidayType: "compensatory", paidType: "10", balanceLabel: "Compensatory Day Off" },
  { id: "11", name: "Family leave (full day)", holidayType: "special2", paidType: "10", balanceLabel: "Family leave" },
  { id: "13", name: "Refresh leave (full day)", holidayType: "special", paidType: "10", balanceLabel: "Refresh leave" },
];

export interface LeaveFormOptions {
  /** Which of the page's two reason spans are present. */
  reasonSpans?: ("required" | "optional")[];
  reasonRequired?: boolean;
  withTimeSelects?: boolean;
}

export function leaveFormPage(holidays: HolidayEntry[] = HOLIDAYS, options: LeaveFormOptions = {}): string {
  const spans = (options.reasonSpans ?? ["optional"])
    .map((s) => `<span id="holiday-reason-${s}">${s === "required" ? "(required)" : "(if any, not required)"}</span>`)
    .join("");
  const timeSelects =
    options.withTimeSelects === false
      ? ""
      : `<select name="start[h][0]" class="start_h">${range(0, 47).map((v) => `<option value="${v}">${String(v + 3).padStart(2, "0")}</option>`).join("")}</select>
         <select name="start[m][0]" class="start_m">${[0, 10, 20, 30, 40, 50].map((v) => `<option value="${v}">${v}</option>`).join("")}</select>
         <select name="end[h][0]" class="end_h">${range(0, 47).map((v) => `<option value="${v}">${String(v + 3).padStart(2, "0")}</option>`).join("")}</select>
         <select name="end[m][0]" class="end_m">${[0, 10, 20, 30, 40, 50].map((v) => `<option value="${v}">${v}</option>`).join("")}</select>`;
  const data = Object.fromEntries(
    holidays.map((h) => [
      h.id,
      { "1": { client_id: "1000", holiday_id: h.id, name: h.name, holiday_type: h.holidayType, paid_type: h.paidType, use_time: "0", type: h.balanceLabel } },
    ]),
  );
  const order = Object.fromEntries(holidays.map((h, i) => [String(i + 1), h.id]));
  const select = (name: string, values: number[]) =>
    `<select name="${name}" id="${name}">${values.map((v) => `<option value="${v}">${v}</option>`).join("")}</select>`;
  const dateSelects = (prefix: string) =>
    select(`${prefix}month`, range(1, 12)) + select(`${prefix}day`, range(1, 31)) + select(`${prefix}year`, range(2024, 2028));

  return `<!DOCTYPE html><html lang="en"><head>
    <script type="text/javascript">var hourlyLeaveDayMin = "480";</script>
    <script type="text/javascript">
      var holidays = ${JSON.stringify(data, null, 2)};
      var holiday_order = ${JSON.stringify(order)};
    </script>
    <script>var texts = {"1417": "New Request", "brace": "a } in a string"};</script></head>
  <body><div class="jbc-container">
    <form method="post" action="/employee/mobile/switch"><input type="hidden" name="token" value="0123456789abcdef0123456789abcdef"><input type="submit" value="Mobile"></form>
    <form id="holiday_new_id" method="post" action="/employee/holiday/confirm">
      <input type="hidden" name="employee_id" value="7">
      <input type="hidden" name="holiday_type" id="holiday-type" value="">
      <input type="hidden" name="total_used_days_count" value="0">
      <select name="holiday_id[0]" onchange="HolidaySelect.changeHolidayId(null, 0);">
        <option value="">Please Select</option>${holidays.map(() => `<option value="" selected></option>`).join("")}
      </select>
      ${dateSelects("holiday_")}${dateSelects("to_holiday_")}
      ${timeSelects}
      <select name="work_unixtime" id="holiday_work_day"><option value=""></option></select>
      <tr><th>Reason for Vacation</th><th>${spans}</th></tr>
      <textarea name="description" id="description"${options.reasonRequired ? " required" : ""} maxlength="255"></textarea>
      <input type="submit" id="submit-button" value="Go to Review Page">
    </form></div></body></html>`;
}

export interface ListRow {
  id: string;
  date: string;
  status: string;
  type: string;
  requested: string;
  amount: string;
  reason: string;
}

export function leaveListPage(rows: ListRow[]): string {
  const row = (r: ListRow) => `<tr>
    <td class="align-middle"><a class="jbc-text-reset" href="/employee/holiday/info?applied_id=${r.id}">${r.id}</a></td>
    <td class="align-middle">${r.date}</td><td class="align-middle">${r.status}</td><td class="align-middle">${r.type}</td>
    <td class="align-middle">${r.requested}</td><td class="align-middle">${r.amount}</td>
    <td class="align-middle text-break">${r.reason}</td></tr>`;
  return `<!DOCTYPE html><html lang="en"><body><div class="jbc-container">
    <form method="GET" action="/employee/holiday/"><select name="from[y]"><option value="2026">2026</option></select></form>
    <table class="table jbc-table"><thead><tr class="jbc-table-header"><th>Request No</th><th>Desired Vacation Date</th><th>Approve/Reject</th>
      <th>Request Details</th><th>Requesting Day</th><th>Time</th><th>Reason for Vacation</th></tr></thead>
      <tbody>${rows.map(row).join("")}</tbody></table></div></body></html>`;
}

export function signInPage(options: { captcha?: boolean; error?: string; token?: string } = {}): string {
  return `<!DOCTYPE html><html lang="en"><head><meta name="csrf-token" content="meta-token"></head><body><div id="login-contents">
    ${options.error ? `<p class="flash flash__alert">${options.error}</p>` : ""}
    <form class="form" id="new_user" action="/users/sign_in" accept-charset="UTF-8" method="post">
      <input type="hidden" name="authenticity_token" value="${options.token ?? "form-token"}" autocomplete="off">
      <input type="email" name="user[email]" id="user_email" value="">
      <input type="text" name="user[client_code]" id="user_client_code" value="">
      <input type="password" name="user[password]" id="user_password">
      <input type="hidden" name="redirect_uri" value="https://ssl.jobcan.jp/jbcoauth/callback">
      <input type="hidden" name="app_key" value="atd">
      <input type="checkbox" name="save_sign_in_information" value="true">
      ${options.captcha ? `<div class="g-recaptcha" data-sitekey="x"></div>` : ""}
      <input type="submit" name="commit" value="Login" id="login_button">
    </form></div></body></html>`;
}

export const employeeHome = `<!DOCTYPE html><html lang="en"><body><div class="jbc-container"><h1>MyPage</h1></div></body></html>`;
