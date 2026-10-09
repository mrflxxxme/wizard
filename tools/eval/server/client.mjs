// HTTP client of the platform cabinet API (specs/platform/api.yaml) as platform-web talks to it: the session cookie,
// the CSRF cookie echoed in X-Wizard-CSRF and the platform Origin on every mutating request
// (apps/platform-api/src/http/auth.ts). The raw token lives only in memory of this process.

/** Cookie names: __Host- over https, plain over local http (apps/platform-api/src/auth/sessions.ts cookieNames). */
export function cookieNames(base) {
  return new URL(base).protocol === "https:"
    ? { session: "__Host-wizard_session", csrf: "__Host-wizard_csrf" }
    : { session: "wizard_session", csrf: "wizard_csrf" };
}

export class ApiError extends Error {
  constructor(method, path, status, body) {
    const code = body && typeof body === "object" ? body.code : undefined;
    const msg = body && typeof body === "object" ? (body.message_ru ?? body.message) : undefined;
    super(`${method} ${path}: ${status}${code ? ` ${code}` : ""}${msg ? ` — ${msg}` : ""}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code ?? null;
    this.body = body;
  }
}

const RETRY_STATUS = new Set([502, 503, 504]);

/**
 * Client of `base` (https://borntobuild.ru) with a session {token, csrf}. GET is retried on network errors and
 * 502/503/504 (ingress restarts); a mutating request is sent once — a retried POST could create a second system.
 */
export function platformClient({ base, session, fetch: f = fetch, sleep = defaultSleep, retries = 3 }) {
  const origin = new URL(base).origin;
  const names = cookieNames(base);
  const cookie = `${names.session}=${session.token}; ${names.csrf}=${session.csrf}`;
  const headers = (method, json) => ({
    accept: "application/json",
    cookie,
    origin,
    ...(method === "GET" ? {} : { "x-wizard-csrf": session.csrf }),
    ...(json ? { "content-type": "application/json" } : {}),
  });

  async function request(method, path, body) {
    const url = `${origin}/api/v1${path}`;
    const tries = method === "GET" ? retries + 1 : 1;
    for (let i = 1; ; i++) {
      let res;
      try {
        res = await f(url, {
          method,
          headers: headers(method, body !== undefined),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "manual",
        });
      } catch (e) {
        if (i >= tries) throw new Error(`${method} ${path}: сеть недоступна (${e?.message ?? e})`);
        await sleep(1000 * i);
        continue;
      }
      if (RETRY_STATUS.has(res.status) && i < tries) {
        await res.text().catch(() => "");
        await sleep(1000 * i);
        continue;
      }
      const text = await res.text();
      let parsed = text;
      if (text && (res.headers.get("content-type") ?? "").includes("json")) {
        try {
          parsed = JSON.parse(text);
        } catch {}
      }
      if (res.status >= 400) throw new ApiError(method, path, res.status, parsed);
      return { status: res.status, body: parsed };
    }
  }

  /**
   * Reads the SSE stream of a run (GET /runs/:id/events?after=N) until `stop(event)` says so, the run ends
   * (run_finished / run_failed) or `timeoutMs` passes. Returns the events seen: {seq, type, payload}.
   */
  async function readEvents(runId, { after = 0, stop = () => false, timeoutMs = 30_000 } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const out = [];
    try {
      const res = await f(`${origin}/api/v1/runs/${runId}/events?after=${after}`, {
        method: "GET",
        headers: { ...headers("GET", false), accept: "text/event-stream" },
        signal: ctl.signal,
      });
      if (res.status >= 400) throw new ApiError("GET", `/runs/${runId}/events`, res.status, await res.text());
      if (!res.body) return out;
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
        let i = buf.indexOf("\n\n");
        while (i >= 0) {
          const ev = parseFrame(buf.slice(0, i));
          buf = buf.slice(i + 2);
          i = buf.indexOf("\n\n");
          if (!ev) continue;
          out.push(ev);
          if (stop(ev) || ev.type === "run_finished" || ev.type === "run_failed") {
            ctl.abort();
            return out;
          }
        }
      }
      return out;
    } catch (e) {
      if (ctl.signal.aborted) return out;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * V3-18: a file as multipart/form-data (POST, sent once like every mutating request): `file` {name, type, data} goes
   * in the form field `field` (default «file», as uploadSystemBrief takes the ТЗ).
   */
  async function upload(path, file, field = "file") {
    const form = new FormData();
    form.set(field, new Blob([file.data], { type: file.type ?? "application/octet-stream" }), file.name);
    const res = await f(`${origin}/api/v1${path}`, {
      method: "POST",
      headers: { accept: "application/json", cookie, origin, "x-wizard-csrf": session.csrf },
      body: form,
      redirect: "manual",
    }).catch((e) => {
      throw new Error(`POST ${path}: сеть недоступна (${e?.message ?? e})`);
    });
    const text = await res.text();
    let parsed = text;
    if (text && (res.headers.get("content-type") ?? "").includes("json")) {
      try {
        parsed = JSON.parse(text);
      } catch {}
    }
    if (res.status >= 400) throw new ApiError("POST", path, res.status, parsed);
    return { status: res.status, body: parsed };
  }

  return {
    base: origin,
    get: (p) => request("GET", p),
    post: (p, b = {}) => request("POST", p, b),
    put: (p, b) => request("PUT", p, b),
    patch: (p, b) => request("PATCH", p, b),
    upload,
    readEvents,
  };
}

/** One SSE frame → {seq, type, payload, ts?}; comments (": ping") and frames without data are skipped. */
export function parseFrame(block) {
  let event;
  let id;
  let data;
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const k = i < 0 ? line : line.slice(0, i);
    const v = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (k === "event") event = v;
    else if (k === "id") id = v;
    else if (k === "data") data = data === undefined ? v : `${data}\n${v}`;
  }
  if (data === undefined) return null;
  let env;
  try {
    env = JSON.parse(data);
  } catch {
    return null;
  }
  return {
    seq: Number(env.seq ?? id ?? 0),
    type: String(env.type ?? event ?? ""),
    payload: env.payload ?? {},
    // V3-18: the server time of the event (stage times and the preview of the v3 measurement).
    ...(typeof env.ts === "string" ? { ts: env.ts } : {}),
  };
}

export const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
