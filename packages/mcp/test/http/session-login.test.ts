import { describe, expect, it } from "vitest";
import { CookieJar } from "tough-cookie";
import { isEmployeePage, isSignInPage, login, LoginChallengeError, LoginFailedError, parseSignInForm } from "../../src/client/http/login.js";
import { describeUrl, RequestBlockedError, Session, UnexpectedRedirectError } from "../../src/client/http/session.js";
import { credentials, fakeServer } from "./fake-server.js";
import { employeeHome, signInPage } from "./pages.js";

const session = (server: ReturnType<typeof fakeServer>, jar?: CookieJar) => new Session({ fetch: server.fetch, delayMs: 0, jar });

describe("what the session will send", () => {
  it.each([
    ["https://ssl.jobcan.jp/employee/holiday/save", "the leave submit endpoint"],
    ["https://ssl.jobcan.jp/employee/holiday/confirm", "the leave review endpoint"],
    ["https://ssl.jobcan.jp/employee/adit/insert/", "the punch endpoint"],
    ["https://ssl.jobcan.jp/employee/mobile/switch", "any other form"],
    ["https://id.jobcan.jp/users/password", "another endpoint on the sign-in host"],
  ])("refuses to POST to %s (%s)", async (url) => {
    const server = fakeServer();
    await expect(session(server).postForm(url, { a: "1" })).rejects.toThrow(RequestBlockedError);
    expect(server.requests).toEqual([]);
  });

  it.each([
    ["https://ssl.jobcan.jp/employee/holiday/delete/?applied_id=47&token=abc", "withdrawing a leave request, which is a GET"],
    ["https://ssl.jobcan.jp/employee/holiday/delete?applied_id=47", "the same without the slash"],
    ["https://ssl.jobcan.jp/employee/holiday/new/../delete/?applied_id=47", "the same behind a dot segment"],
    ["https://ssl.jobcan.jp/employee/holiday/new/%2e%2e/delete/?applied_id=47", "the same behind an encoded dot segment"],
    ["https://ssl.jobcan.jp/employee/logout/", "signing out"],
    ["https://ssl.jobcan.jp/employee/holiday/save", "the leave submit endpoint"],
    ["https://ssl.jobcan.jp/employee/adit/insert/", "the punch endpoint"],
    ["https://ssl.jobcan.jp/employee/adit/delete", "anything not listed"],
    ["https://ssl.jobcan.jp/st/js/../../employee/logout/x.js", "a script path that climbs out"],
    ["https://id.jobcan.jp/users/sign_out", "signing out of the ID service"],
  ])("refuses to GET %s (%s)", async (url) => {
    const server = fakeServer();
    await expect(session(server).get(url)).rejects.toThrow(RequestBlockedError);
    expect(server.requests).toEqual([]);
  });

  it.each([
    "https://ssl.jobcan.jp/employee",
    "https://ssl.jobcan.jp/employee/attendance?year=2026&month=10",
    "https://ssl.jobcan.jp/employee/holiday/?search_type=term",
    "https://ssl.jobcan.jp/employee/holiday/new",
    "https://ssl.jobcan.jp/employee/holiday/info?applied_id=47",
    "https://ssl.jobcan.jp/employee/holiday/delete-confirm/?applied_id=47",
    "https://ssl.jobcan.jp/employee/adit/modify?year=2026&month=9&day=29",
    "https://ssl.jobcan.jp/st/js/employee/holiday-new.js?lu=1",
    "https://ssl.jobcan.jp/st/locales/en/translation.json",
    "https://id.jobcan.jp/users/sign_in?app_key=atd",
  ])("may GET %s", async (url) => {
    const server = fakeServer();
    await session(server).get(url).catch(() => undefined);
    expect(server.requests.length).toBeGreaterThan(0);
    expect(server.requests[0]?.method).toBe("GET");
  });

  it("does not use the write leniency for reads", async () => {
    const server = fakeServer({ signedOutRedirect: "https://ssl.jobcan.jp/employee/holiday/delete/?applied_id=1" });
    await expect(new Session({ fetch: server.fetch, delayMs: 0, allowWrites: true }).get("https://ssl.jobcan.jp/employee")).rejects.toThrow(RequestBlockedError);
  });

  it("stops when Jobcan redirects to a page that is not listed", async () => {
    const server = fakeServer({ signedOutRedirect: "https://ssl.jobcan.jp/employee/holiday/delete/?applied_id=1" });
    await expect(session(server).get("https://ssl.jobcan.jp/employee")).rejects.toThrow(RequestBlockedError);
    expect(server.requests.map((r) => r.path)).toEqual(["/employee"]);
  });

  it.each([
    "https://example.com/employee",
    "https://ssl.jobcan.jp.example.com/employee",
    "http://ssl.jobcan.jp/employee",
    "https://accounts.google.com/o/oauth2/auth",
    "not a url",
  ])("refuses to contact %s", async (url) => {
    const server = fakeServer();
    await expect(session(server).get(url)).rejects.toThrow(RequestBlockedError);
    await expect(session(server).postForm(url, {})).rejects.toThrow(RequestBlockedError);
    expect(server.requests).toEqual([]);
  });

  it("allows the sign-in POST, with or without a query", async () => {
    const server = fakeServer();
    await session(server).postForm("https://id.jobcan.jp/users/sign_in", { x: "1" });
    expect(server.requests.map((r) => r.method)).toEqual(["POST"]);
  });

  it("stops when Jobcan redirects to another host", async () => {
    const server = fakeServer({ signedOutRedirect: "https://accounts.google.com/o/oauth2/auth?client_id=1" });
    await expect(session(server).get("https://ssl.jobcan.jp/employee")).rejects.toThrow(UnexpectedRedirectError);
    expect(server.requests.map((r) => new URL(r.url).host)).toEqual(["ssl.jobcan.jp"]);
  });

  it("identifies itself and asks for English pages", async () => {
    const server = fakeServer();
    await session(server).get("https://id.jobcan.jp/users/sign_in");
    expect(server.requests[0]?.userAgent).toMatch(/^jobcan-agent\//);
    await session(server).get("https://ssl.jobcan.jp/employee");
    expect(server.requests[1]?.cookies).toContain("employee_language=en");
  });

  it("does not send one host's cookies to the other", async () => {
    const server = fakeServer();
    const s = session(server);
    await login(s, credentials());
    const toId = server.requests.filter((r) => new URL(r.url).host === "id.jobcan.jp").at(-1);
    const toSsl = server.requests.filter((r) => new URL(r.url).host === "ssl.jobcan.jp").at(-1);
    expect(toSsl?.cookies).toContain("sid=");
    expect(toSsl?.cookies).not.toContain("_jbcid_session");
    expect(toId?.cookies).not.toContain("sid=");
  });

  it("keeps cookie values that contain an equals sign", async () => {
    const server = fakeServer();
    const s = session(server);
    await login(s, credentials());
    expect(await s.jar.getCookieString("https://id.jobcan.jp/")).toContain("_jbcid_session_user=abc=def==");
  });

  it("leaves query strings out of what it reports", async () => {
    const server = fakeServer();
    const result = await login(session(server), credentials());
    expect(result.hops.join(" ")).not.toContain("one-time-code");
    expect(result.hops).toContain("https://ssl.jobcan.jp/jbcoauth/callback");
    expect(describeUrl("https://ssl.jobcan.jp/jbcoauth/callback?code=secret")).toBe("https://ssl.jobcan.jp/jbcoauth/callback");
  });
});

describe("page detection", () => {
  it("recognises the sign-in page by address or by form", () => {
    expect(isSignInPage({ url: "https://id.jobcan.jp/users/sign_in?app_key=atd", body: "" })).toBe(true);
    expect(isSignInPage({ url: "https://ssl.jobcan.jp/employee", body: signInPage() })).toBe(true);
    expect(isSignInPage({ url: "https://ssl.jobcan.jp/employee", body: employeeHome })).toBe(false);
  });

  it("recognises an employee page", () => {
    expect(isEmployeePage({ url: "https://ssl.jobcan.jp/employee/attendance?year=2026", body: employeeHome })).toBe(true);
    expect(isEmployeePage({ url: "https://ssl.jobcan.jp/employee", body: signInPage() })).toBe(false);
    expect(isEmployeePage({ url: "https://id.jobcan.jp/account", body: employeeHome })).toBe(false);
  });
});

describe("parseSignInForm", () => {
  it("keeps the hidden fields and finds the two inputs to fill", () => {
    expect(parseSignInForm(signInPage())).toEqual({
      fields: {
        authenticity_token: "form-token",
        "user[client_code]": "",
        redirect_uri: "https://ssl.jobcan.jp/jbcoauth/callback",
        app_key: "atd",
        commit: "Login",
      },
      emailField: "user[email]",
      passwordField: "user[password]",
    });
  });

  it("falls back to the token in the page head", () => {
    const page = signInPage().replace(/<input type="hidden" name="authenticity_token"[^>]*>/, "");
    expect(parseSignInForm(page).fields.authenticity_token).toBe("meta-token");
  });

  it("stops at a captcha", () => {
    expect(() => parseSignInForm(signInPage({ captcha: true }))).toThrow(LoginChallengeError);
  });

  it("stops when there is no password field, as with single sign-on", () => {
    const page = signInPage().replace(/<input type="password"[^>]*>/, "");
    expect(() => parseSignInForm(page)).toThrow(/another sign-in method/);
  });

  it("stops when the form is gone", () => {
    expect(() => parseSignInForm(employeeHome)).toThrow(LoginChallengeError);
  });
});

describe("login", () => {
  it("signs in and lands in 勤怠管理", async () => {
    const server = fakeServer();
    const result = await login(session(server), credentials());

    expect(result.signedIn).toBe(true);
    expect(server.signIns).toBe(1);
    expect(server.requests.at(-1)).toMatchObject({ method: "GET", path: "/employee" });
    const posted = new URLSearchParams(server.requests.find((r) => r.method === "POST")?.body);
    expect(Object.fromEntries(posted)).toEqual({
      authenticity_token: "form-token",
      "user[email]": "user@example.com",
      "user[client_code]": "",
      "user[password]": "correct horse",
      redirect_uri: "https://ssl.jobcan.jp/jbcoauth/callback",
      app_key: "atd",
      commit: "Login",
    });
  });

  it("sends the credentials only to Jobcan's sign-in endpoint", async () => {
    const server = fakeServer();
    await login(session(server), credentials());
    const withPassword = server.requests.filter((r) => r.url.includes("correct") || r.body?.includes("correct"));
    expect(withPassword.map((r) => `${r.method} ${r.url}`)).toEqual(["POST https://id.jobcan.jp/users/sign_in"]);
  });

  it("does not read the credentials when the session is still good", async () => {
    const server = fakeServer();
    const s = session(server);
    await login(s, credentials());

    const again = credentials();
    const result = await login(s, again);
    expect(result.signedIn).toBe(false);
    expect(again.calls).toBe(0);
    expect(server.signIns).toBe(1);
  });

  it("picks up a session saved earlier", async () => {
    const server = fakeServer();
    const first = session(server);
    await login(first, credentials());
    const restored = CookieJar.deserializeSync(JSON.parse(JSON.stringify(first.jar.serializeSync())));

    const again = credentials();
    expect((await login(session(server, restored), again)).signedIn).toBe(false);
    expect(again.calls).toBe(0);
  });

  it("reports a wrong password with Jobcan's message", async () => {
    const server = fakeServer();
    const attempt = login(session(server), credentials("user@example.com", "wrong"));
    await expect(attempt).rejects.toThrow(LoginFailedError);
    await expect(login(session(server), credentials("user@example.com", "wrong"))).rejects.toThrow(/Invalid email or password/);
  });

  it("never puts the password in an error", async () => {
    const server = fakeServer();
    const error = await login(session(server), credentials("user@example.com", "hunter2-secret")).catch((e: Error) => e);
    expect(String(error)).not.toContain("hunter2-secret");
    expect(JSON.stringify(error)).not.toContain("hunter2-secret");
  });

  it("signs in when being signed out leads to a page it does not read", async () => {
    const server = fakeServer({ signedOutRedirect: "https://ssl.jobcan.jp/login/pc-employee-global" });
    expect((await login(session(server), credentials())).signedIn).toBe(true);
  });

  it("stops at a captcha without sending the credentials", async () => {
    const server = fakeServer({ captcha: true });
    const creds = credentials();
    await expect(login(session(server), creds)).rejects.toThrow(LoginChallengeError);
    expect(creds.calls).toBe(0);
    expect(server.signIns).toBe(0);
  });

  it("stops at a second sign-in step", async () => {
    const server = fakeServer({ afterSignIn: "https://id.jobcan.jp/account/two_factor" });
    await expect(login(session(server), credentials())).rejects.toThrow(/second step/);
  });

  it("stops when signing in leads to another host", async () => {
    const server = fakeServer({ afterSignIn: "https://sso.example.com/saml" });
    await expect(login(session(server), credentials())).rejects.toThrow(UnexpectedRedirectError);
  });
});
