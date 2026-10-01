import { CookieJar } from "tough-cookie";

export const ID_ORIGIN = "https://id.jobcan.jp";
export const ATTENDANCE_ORIGIN = "https://ssl.jobcan.jp";
export const SIGN_IN_URL = `${ID_ORIGIN}/users/sign_in`;

const ALLOWED_ORIGINS = new Set([ID_ORIGIN, ATTENDANCE_ORIGIN]);

/**
 * Every address this client may fetch. Jobcan changes data on some GETs (withdrawing a
 * leave request is a plain link), so "GET" is not the same as "read-only": pages are
 * listed one by one, and anything else is refused here, below the client.
 */
const READABLE: Record<string, RegExp[]> = {
  [ID_ORIGIN]: [/^\/users\/sign_in\/?$/, /^\/oauth\/authorize\/?$/],
  [ATTENDANCE_ORIGIN]: [
    /^\/jbcoauth\/(login|callback)\/?$/,
    /^\/employee\/?$/,
    /^\/employee\/attendance\/?$/,
    /^\/employee\/holiday\/?$/,
    /^\/employee\/holiday\/(new|info|delete-confirm|finish|delete-finish)\/?$/,
    /^\/employee\/adit\/modify\/?$/,
    // scripts and translations the pages load
    /^\/st\/(js|locales)\/[\w./-]+\.(js|json)$/,
  ],
};

/** Signing in is the one POST a read-only session can send. */
const ALLOWED_POSTS = new Set([SIGN_IN_URL]);

/**
 * What a session with writes enabled may do on top: file leave (review, then save) and
 * withdraw a pending request (a GET, as Jobcan made it). Nothing else, ever.
 */
const WRITE_GETS = [/^\/employee\/holiday\/delete\/?$/];
const WRITE_POSTS = new Set([
  `${ATTENDANCE_ORIGIN}/employee/holiday/confirm`,
  `${ATTENDANCE_ORIGIN}/employee/holiday/save`,
  `${ATTENDANCE_ORIGIN}/employee/adit/insert/`,
]);

const MAX_REDIRECTS = 10;

export class RequestBlockedError extends Error {
  /** Origin and path of the refused request. */
  readonly target: string;

  constructor(method: string, url: string, why: string) {
    super(`Blocked ${method} ${describeUrl(url)}: ${why}`);
    this.name = "RequestBlockedError";
    this.target = describeUrl(url);
  }
}

/** Jobcan sent us somewhere this client does not go, such as an external sign-in provider. */
export class UnexpectedRedirectError extends Error {
  constructor(readonly host: string) {
    super(`Jobcan redirected to ${host}, which this client does not follow`);
    this.name = "UnexpectedRedirectError";
  }
}

/** Form values; an array sends the name several times, as Jobcan's own forms do. */
export type FormBody = Record<string, string | string[]>;

export interface HttpResponse {
  status: number;
  /** The URL that answered, after redirects. */
  url: string;
  body: string;
  /** Each hop as origin and path. Query strings are left out: they carry one-time codes. */
  hops: string[];
  /**
   * Set when a write was answered with a redirect to a page this client does not read.
   * The write has happened by then, so the redirect is left alone and the caller checks
   * the outcome another way.
   */
  unfollowedRedirect?: string;
}

export interface SessionOptions {
  /** Let the session send the few writes it knows. Off unless asked for. */
  allowWrites?: boolean;
  fetch?: typeof fetch;
  jar?: CookieJar;
  /** Pause before each request, to stay gentle on Jobcan. */
  delayMs?: number;
  userAgent?: string;
  /** UI language Jobcan renders pages in. Parsers expect `en`. */
  language?: string;
}

export const DEFAULT_USER_AGENT = "jobcan-agent/0.1 (unofficial personal tool)";

/** Origin and path only, safe to log. */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

function isWrite(method: string, url: string): boolean {
  const parsed = new URL(url);
  const endpoint = `${parsed.origin}${parsed.pathname}`;
  if (method === "POST") return WRITE_POSTS.has(endpoint);
  return parsed.origin === ATTENDANCE_ORIGIN && WRITE_GETS.some((page) => page.test(parsed.pathname));
}

function checkAllowed(method: string, url: string, allowWrites: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RequestBlockedError(method, url, "not a valid URL");
  }
  if (!ALLOWED_ORIGINS.has(parsed.origin)) throw new RequestBlockedError(method, url, "host is not Jobcan");
  if (parsed.pathname.includes("..")) throw new RequestBlockedError(method, url, "path is not plain");
  const endpoint = `${parsed.origin}${parsed.pathname}`;
  if (method === "GET") {
    if (READABLE[parsed.origin]!.some((page) => page.test(parsed.pathname))) return;
    if (allowWrites && parsed.origin === ATTENDANCE_ORIGIN && WRITE_GETS.some((page) => page.test(parsed.pathname))) return;
    throw new RequestBlockedError(method, url, "not on the list of pages that are safe to read");
  }
  if (method === "POST" && ALLOWED_POSTS.has(endpoint)) return;
  if (method === "POST" && allowWrites && WRITE_POSTS.has(endpoint)) return;
  throw new RequestBlockedError(method, url, allowWrites ? "not a write this client knows" : "writes are not enabled");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A cookie-keeping HTTP session that can only read from Jobcan, and only the pages listed above. */
export class Session {
  readonly jar: CookieJar;
  readonly allowWrites: boolean;
  private readonly fetch: typeof fetch;
  private readonly delayMs: number;
  private readonly userAgent: string;
  private readonly language: string;

  constructor(options: SessionOptions = {}) {
    this.fetch = options.fetch ?? fetch;
    this.jar = options.jar ?? new CookieJar();
    this.allowWrites = options.allowWrites ?? false;
    this.delayMs = options.delayMs ?? 300;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.language = options.language ?? "en";
  }

  get(url: string, referer?: string): Promise<HttpResponse> {
    return this.send("GET", url, undefined, referer);
  }

  postForm(url: string, form: FormBody, referer?: string, options: { xhr?: boolean } = {}): Promise<HttpResponse> {
    return this.send("POST", url, form, referer, options.xhr);
  }

  private async send(method: "GET" | "POST", url: string, form?: FormBody, referer?: string, xhr = false): Promise<HttpResponse> {
    const hops: string[] = [];
    let current = { method, url, form, referer };
    let written = false;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      if (hops.length > 0 && !ALLOWED_ORIGINS.has(new URL(current.url).origin)) {
        throw new UnexpectedRedirectError(new URL(current.url).host);
      }
      // only the request itself may be a write; a redirect is never followed into one
      checkAllowed(current.method, current.url, hops.length === 0 && this.allowWrites);
      hops.push(describeUrl(current.url));
      written ||= isWrite(current.method, current.url);

      const response = await this.fetchOnce(current.method, current.url, current.form, current.referer, xhr && hops.length === 1);
      const location = response.headers.get("location");
      const isRedirect = response.status >= 300 && response.status < 400 && location;
      if (!isRedirect) {
        return { status: response.status, url: current.url, body: await response.text(), hops };
      }

      await response.body?.cancel();
      if (response.status === 307 || response.status === 308) {
        if (current.method !== "GET") throw new RequestBlockedError(current.method, location, "will not repeat a POST on redirect");
      }
      const next = new URL(location, current.url).toString();
      if (written) {
        // the write is done; a redirect we would refuse must not turn it into an error
        try {
          checkAllowed("GET", next, false);
        } catch {
          return { status: response.status, url: current.url, body: "", hops, unfollowedRedirect: describeUrl(next) };
        }
      }
      current = { method: "GET", url: next, form: undefined, referer: current.url };
    }
    throw new Error(`Too many redirects, last at ${describeUrl(current.url)}`);
  }

  private async fetchOnce(method: string, url: string, form?: FormBody, referer?: string, xhr = false): Promise<Response> {
    if (this.delayMs > 0) await sleep(this.delayMs);
    await this.jar.setCookie(`employee_language=${this.language}; Path=/`, ATTENDANCE_ORIGIN);

    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": this.language,
    };
    const cookies = await this.jar.getCookieString(url);
    if (cookies) headers.Cookie = cookies;
    if (referer) headers.Referer = describeUrl(referer);
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers.Origin = new URL(url).origin;
    }
    if (xhr) {
      headers["X-Requested-With"] = "XMLHttpRequest";
      headers.Accept = "application/json, text/javascript, */*";
    }

    const response = await this.fetch(url, {
      method,
      headers,
      body: form ? new URLSearchParams(Object.entries(form).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]))).toString() : undefined,
      redirect: "manual",
    });
    for (const cookie of response.headers.getSetCookie()) {
      await this.jar.setCookie(cookie, url, { ignoreError: true });
    }
    return response;
  }
}
