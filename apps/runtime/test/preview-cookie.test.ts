// Preview cookie for the platform iframe (runtime.yaml#auth.session_cookie, L3-15; impl-notes M0-24):
// wz_prev / __Host-wz_prev with Secure; SameSite=None; Partitioned — only on *--draft, prod never SameSite=None.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewCookieName, readSessionToken } from "../src/index.js";
import { devEnv, forumSpec, type Harness, harness, request } from "./helpers.js";

const spec = forumSpec();
const D = "prevck--draft.localhost:4100";
const P = "prevck.localhost:4100";
const TOKEN = "a".repeat(43);

let h: Harness;

beforeAll(async () => {
  h = await harness();
  await h.system("prevck", spec, "draft");
  await h.system("prevck", spec, "prod");
});
afterAll(async () => {
  await h?.close();
});

const setCookies = (res: Response) => res.headers.getSetCookie();

describe("dev-login on a draft host", () => {
  it("sets the Lax session cookie and the partitioned preview cookie with the same token", async () => {
    const res = await h.rt.fetch(request("GET", D, "/_wizard/dev-login?role=participant&next=/"));
    expect(res.status).toBe(302);
    const [sess, prev] = setCookies(res);
    expect(sess).toMatch(/^wz_sess=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; /);
    expect(prev).toMatch(/^wz_prev=[A-Za-z0-9_-]{43}; /);
    for (const attr of ["Path=/", "HttpOnly", "Secure", "SameSite=None", "Partitioned"])
      expect(prev?.split("; ")).toContain(attr);
    expect(prev).not.toContain("Domain");
    expect(prev?.split(";")[0]?.split("=")[1]).toBe(sess?.split(";")[0]?.split("=")[1]);
  });

  it("the iframe request carries only wz_prev (Lax is not sent cross-site) and is logged in", async () => {
    const res = await h.rt.fetch(request("GET", D, "/_wizard/dev-login?role=organizer"));
    const prev = (setCookies(res)[1] ?? "").split(";")[0] as string;
    const me = await h.rt.fetch(request("GET", D, "/api/auth/me", { cookie: prev }));
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { role: string } }).user.role).toBe("organizer");
    // Duplicated preview cookie → 401, like the session cookie.
    expect((await h.rt.fetch(request("GET", D, "/api/auth/me", { cookie: `${prev}; ${prev}` }))).status).toBe(
      401,
    );
  });

  it("dev-logout and logout on draft clear both cookies", async () => {
    const out = await h.rt.fetch(request("GET", D, "/_wizard/dev-logout"));
    expect(setCookies(out).map((c) => c.split("=")[0])).toEqual(["wz_sess", "wz_prev"]);
    expect(setCookies(out).every((c) => c.includes("Max-Age=0"))).toBe(true);
    const logout = await h.rt.fetch(request("POST", D, "/api/auth/logout"));
    expect(logout.status).toBe(204);
    expect(setCookies(logout).map((c) => c.split("=")[0])).toEqual(["wz_sess", "wz_prev"]);
  });
});

describe("prod host", () => {
  it("responses never contain SameSite=None; the preview cookie is not accepted", async () => {
    const login = await h.rt.fetch(request("GET", P, "/_wizard/dev-login?role=organizer"));
    expect(login.status).toBe(404);
    const logout = await h.rt.fetch(request("POST", P, "/api/auth/logout"));
    expect(logout.status).toBe(204);
    const all = [...setCookies(login), ...setCookies(logout)].join("\n");
    expect(all).not.toContain("SameSite=None");
    expect(all).not.toContain("wz_prev");
    const page = await h.rt.fetch(request("GET", P, "/_wizard/spec", { cookie: `wz_prev=${TOKEN}` }));
    expect(page.headers.get("set-cookie") ?? "").not.toContain("SameSite=None");
  });

  it("readSessionToken takes the preview cookie only on draft and only by the configured name", () => {
    expect(readSessionToken(`wz_prev=${TOKEN}`, devEnv)).toEqual({ kind: "none" });
    expect(readSessionToken(`wz_prev=${TOKEN}`, devEnv, { draft: true })).toEqual({
      kind: "token",
      token: TOKEN,
    });
    const https = { ...devEnv, publicScheme: "https" as const };
    expect(previewCookieName(https)).toBe("__Host-wz_prev");
    expect(readSessionToken(`wz_prev=${TOKEN}`, https, { draft: true })).toEqual({ kind: "none" });
    expect(readSessionToken(`__Host-wz_prev=${TOKEN}`, https, { draft: true })).toEqual({
      kind: "token",
      token: TOKEN,
    });
    // The session cookie wins over the preview cookie.
    const other = "b".repeat(43);
    expect(readSessionToken(`wz_prev=${TOKEN}; wz_sess=${other}`, devEnv, { draft: true })).toEqual({
      kind: "token",
      token: other,
    });
  });
});
