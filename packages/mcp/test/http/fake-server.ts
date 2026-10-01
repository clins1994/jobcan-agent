import { employeeHome, leaveListPage, signInPage } from "./pages.js";

/** `YYYY-MM-DD` to the `MM/DD/YYYY` the English list uses. */
const toUs = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;

export interface Recorded {
  method: string;
  url: string;
  path: string;
  cookies: string;
  body?: string;
  userAgent?: string;
}

export interface HolidayState {
  id: string;
  date: string;
  status: string;
  type: string;
  requested: string;
  amount: string;
  reason: string;
}

export interface FakeServerOptions {
  email?: string;
  password?: string;
  /** Leave requests the stateful holiday pages start with. Turns on /employee/holiday/ and the write endpoints. */
  holidays?: HolidayState[];
  /** Names of leave types, by id, for the stateful pages. */
  leaveTypeNames?: Record<string, string>;
  /** Make the review step refuse every request with these errors. */
  refuseWith?: string[];
  /** Where Jobcan sends the browser after a write; defaults to pages the client reads. */
  afterSave?: string;
  afterDelete?: string;
  /** Turns on the clock-edit page and the punch endpoint. Called for every accepted record. */
  onPunch?: (date: string, time: string, note: string, spot: string) => void;
  spots?: [string, string][];
  /** Pages under https://ssl.jobcan.jp, keyed by path. A function receives the query. */
  pages?: Record<string, string | ((query: URLSearchParams) => string)>;
  captcha?: boolean;
  /** Where a successful sign-in lands, in place of the usual chain into 勤怠管理. */
  afterSignIn?: string;
  /** Host that /employee redirects to when signed out, in place of Jobcan's own sign-in. */
  signedOutRedirect?: string;
}

const html = (body: string, status = 200, cookies: string[] = []) => {
  const headers = new Headers({ "content-type": "text/html; charset=UTF-8" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(body, { status, headers });
};

const redirect = (location: string, cookies: string[] = [], status = 302) => {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status, headers });
};

/** A stand-in for Jobcan's two hosts, enough to sign in, serve pages, and file or withdraw leave. */
export function fakeServer(options: FakeServerOptions = {}) {
  const { email = "user@example.com", password = "correct horse" } = options;
  const requests: Recorded[] = [];
  let sessions = 0;
  const holidays: HolidayState[] = structuredClone(options.holidays ?? []);
  const stateful = options.holidays !== undefined;
  const names = options.leaveTypeNames ?? { "1": "Annual leave (full day)", "4": "Annual leave (hourly)" };
  const reviewTokens = new Map<string, URLSearchParams>();
  const withdrawToken = (id: string) => `wd-${id}-token`;
  let nextId = Math.max(0, ...holidays.map((h) => Number(h.id))) + 1;

  const listPage = () => leaveListPage(holidays.map((h) => ({ ...h })));
  const reviewPage = (token: string, form: URLSearchParams) => {
    const hidden = [...form.entries()].map(([k, v]) => `<input type="hidden" name="${k.replace(/(\[\d+\])?$/, "[]")}" value="${v}">`).join("");
    return `<html><body><div class="jbc-container"><form id="form1" name="useSave" method="post" action="/employee/holiday/save">
      <input type="hidden" name="token" value="${token}">${hidden}<input type="button" value="Request"></form></div></body></html>`;
  };
  const refusedPage = (errors: string[]) =>
    `<html><body><div class="jbc-container"><span id="holiday-reason-required">(required as the manager has selected the required mode)</span>
     ${errors.map((e) => `<div class="invalid-feedback d-block">${e}</div>`).join("")}<form action="/employee/holiday/confirm"></form></div></body></html>`;

  const clockEdit = (url: URL, method: string, body: string): Response | undefined => {
    if (!options.onPunch) return undefined;
    const spots = options.spots ?? [["1", "Head office"], ["3", "Remote"]];
    if (url.pathname === "/employee/adit/modify" && method === "GET") {
      const [y, m, d] = ["year", "month", "day"].map((k) => url.searchParams.get(k));
      return html(`<html><body><div class="jbc-container"><form id="modifyForm" method="post" action="/employee/adit/insert/">
        <input type="hidden" name="token" value="punch-token"><input type="hidden" name="year" value="${y}"><input type="hidden" name="month" value="${m}">
        <input type="hidden" name="day" value="${d}"><input type="hidden" name="client_id" value="1000"><input type="hidden" name="employee_id" value="7">
        <input type="hidden" name="delete_minutes" value="">
        <table><tr><th>Time</th><td><input type="text" name="time" size="6"></td></tr>
        <tr><th>Spot</th><td><select name="group_id">${spots.map(([id, name]) => `<option value="${id}">${name}</option>`).join("")}</select></td></tr>
        <tr><th>Notes(Required)</th><td><textarea name="notice" rows="4"></textarea></td></tr></table>
        <input type="button" value="PUSH" onclick="adit(this.form); return false;"></form><div id="logs-table"></div></div></body></html>`);
    }
    if (url.pathname === "/employee/adit/insert/" && method === "POST") {
      const form = new URLSearchParams(body);
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
      if (form.get("token") !== "punch-token") return json({ result: 0, errors: { token: "invalid" } });
      const errors: Record<string, string> = {};
      if (!form.get("notice")) errors.notice = "empty";
      if (!/^\d{4}$/.test(form.get("time") ?? "")) errors.time = "empty";
      if (!spots.some(([id]) => id === form.get("group_id"))) errors.group_id = "invalid";
      if (Object.keys(errors).length > 0) return json({ result: 0, errors });
      const date = `${form.get("year")}-${form.get("month")!.padStart(2, "0")}-${form.get("day")!.padStart(2, "0")}`;
      const time = `${form.get("time")!.slice(0, 2)}:${form.get("time")!.slice(2)}`;
      options.onPunch!(date, time, form.get("notice")!, form.get("group_id")!);
      return json({ result: 1, log_table: "<table></table>", refresh: 0 });
    }
    return undefined;
  };

  const holidayWrite = (url: URL, method: string, body: string, cookies: string): Response | undefined => {
    if (!stateful) return undefined;
    if (url.pathname === "/employee/holiday/" && method === "GET") return html(listPage());
    if (url.pathname === "/employee/holiday/confirm" && method === "POST") {
      const form = new URLSearchParams(body);
      const errors = [...(options.refuseWith ?? [])];
      const date = `${form.get("holiday_year")}-${form.get("holiday_month")!.padStart(2, "0")}-${form.get("holiday_day")!.padStart(2, "0")}`;
      if (!form.get("description")) errors.push("Please enter the reason.");
      if (holidays.some((h) => h.date === toUs(date) && h.status !== "Cancel")) errors.push("The date is already requested.");
      if (errors.length > 0) return html(refusedPage(errors));
      const token = `review-${reviewTokens.size + 1}`;
      reviewTokens.set(token, form);
      return html(reviewPage(token, form));
    }
    if (url.pathname === "/employee/holiday/save" && method === "POST") {
      const form = new URLSearchParams(body);
      const original = reviewTokens.get(form.get("token") ?? "");
      if (!original) return html(refusedPage(["Invalid token."]));
      reviewTokens.delete(form.get("token")!);
      const date = `${original.get("holiday_year")}-${original.get("holiday_month")!.padStart(2, "0")}-${original.get("holiday_day")!.padStart(2, "0")}`;
      const typeId = original.get("holiday_id[0]") ?? "";
      const hourly = original.has("start[h][0]");
      // like Jobcan, the hour select's value is the hour shown minus 3
      const shown = (h: string, m: string) => `${String(Number(h) + 3).padStart(2, "0")}:${m.padStart(2, "0")}`;
      const amount = hourly
        ? `${shown(original.get("start[h][0]")!, original.get("start[m][0]")!)}～${shown(original.get("end[h][0]")!, original.get("end[m][0]")!)}`
        : "1day(s)";
      holidays.unshift({ id: String(nextId++), date: toUs(date), status: "Waiting for Approval", type: names[typeId] ?? `type ${typeId}`, requested: "09/30/2026", amount, reason: original.get("description") ?? "" });
      return redirect(options.afterSave ?? "/employee/holiday/finish");
    }
    if (url.pathname === "/employee/holiday/finish") return html(`<html><body><div class="jbc-container"><h1>Request completed</h1></div></body></html>`);
    if (url.pathname === "/employee/holiday/delete-confirm/") {
      const id = url.searchParams.get("applied_id") ?? "";
      const h = holidays.find((x) => x.id === id);
      if (!h || h.status !== "Waiting for Approval") return html(`<html><body><div class="jbc-container"><h3>Vacation Request Details</h3></div></body></html>`);
      return html(`<html><body><div class="jbc-container"><h3>Delete vacation request</h3><p>Do you really want to delete?</p>
        <a class="btn" href="javascript:history.back();">Back</a>
        <a class="btn jbc-btn-danger" href="/employee/holiday/delete/?applied_id=${id}&amp;token=${withdrawToken(id)}">Delete</a></div></body></html>`);
    }
    if (url.pathname === "/employee/holiday/delete/") {
      const id = url.searchParams.get("applied_id") ?? "";
      if (url.searchParams.get("token") !== withdrawToken(id)) return html("bad token", 400);
      const index = holidays.findIndex((x) => x.id === id && x.status === "Waiting for Approval");
      if (index >= 0) holidays.splice(index, 1);
      return redirect(options.afterDelete ?? "/employee/holiday/");
    }
    if (url.pathname === "/employee/holiday/info") return html(`<html><body><div class="jbc-container"><h3>Vacation Request Details</h3></div></body></html>`);
    void cookies;
    return undefined;
  };

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const cookies = headers.get("cookie") ?? "";
    requests.push({
      method,
      url: url.toString(),
      path: url.pathname,
      cookies,
      body: typeof init?.body === "string" ? init.body : undefined,
      userAgent: headers.get("user-agent") ?? undefined,
    });
    const has = (name: string) => new RegExp(`(^|; )${name}=`).test(cookies);

    if (url.host === "id.jobcan.jp") {
      if (url.pathname === "/users/sign_in" && method === "GET") {
        if (has("_jbcid_session_user")) return redirect("https://ssl.jobcan.jp/jbcoauth/login");
        return html(signInPage({ captcha: options.captcha }), 200, ["_jbcid_session=anon; Path=/; Secure; HttpOnly"]);
      }
      if (url.pathname === "/users/sign_in" && method === "POST") {
        const form = new URLSearchParams(String(init?.body));
        const ok = form.get("user[email]") === email && form.get("user[password]") === password && form.get("authenticity_token") === "form-token";
        if (!ok) return html(signInPage({ error: "Invalid email or password." }));
        const cookie = ["_jbcid_session_user=abc=def==; Path=/; Secure; HttpOnly"];
        return redirect(options.afterSignIn ?? "https://id.jobcan.jp/oauth/authorize?client_id=x&response_type=code", cookie);
      }
      if (url.pathname === "/oauth/authorize") {
        return has("_jbcid_session_user") ? redirect("https://ssl.jobcan.jp/jbcoauth/callback?code=one-time-code") : redirect("https://id.jobcan.jp/users/sign_in");
      }
      if (url.pathname === "/account/two_factor") return html("<html><body>Enter your verification code</body></html>");
      return html("not found", 404);
    }

    if (url.host === "ssl.jobcan.jp") {
      if (url.pathname === "/jbcoauth/login") return redirect("https://id.jobcan.jp/oauth/authorize?client_id=x&response_type=code");
      if (url.pathname === "/jbcoauth/callback") {
        if (url.searchParams.get("code") !== "one-time-code") return html("bad code", 400);
        sessions++;
        return redirect("/employee", [`sid=session-${sessions}; Path=/; Secure; HttpOnly`]);
      }
      if (!has("sid")) return redirect(options.signedOutRedirect ?? "https://id.jobcan.jp/users/sign_in?app_key=atd");
      if (url.pathname === "/employee") return html(employeeHome);
      const written = holidayWrite(url, method, typeof init?.body === "string" ? init.body : "", cookies) ?? clockEdit(url, method, typeof init?.body === "string" ? init.body : "");
      if (written) return written;
      const page = options.pages?.[url.pathname];
      if (page !== undefined) return html(typeof page === "function" ? page(url.searchParams) : page);
      return html("not found", 404);
    }

    return html("unexpected host", 500);
  }) as typeof globalThis.fetch;

  return {
    fetch,
    requests,
    holidays,
    get signIns() {
      return requests.filter((r) => r.method === "POST" && r.path === "/users/sign_in").length;
    },
  };
}

export const credentials = (email = "user@example.com", password = "correct horse") => {
  const fn = async () => {
    fn.calls++;
    return { email, password };
  };
  fn.calls = 0;
  return fn;
};
