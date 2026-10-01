// Timeweb Cloud DNS backend of the DNS-01 solver: one TXT record per value, idempotent present, cleanup by value.
import { describe, expect, it } from "vitest";
import { createBackend, createWebhook, TimewebDns } from "../src/index.js";

interface Rec {
  id: number;
  type: string;
  fqdn: string;
  data: { subdomain: string; value: string };
}

function fakeTimeweb(zone: string) {
  const records: Rec[] = [];
  const calls: string[] = [];
  let seq = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (new Headers(init?.headers).get("authorization") !== "Bearer tw-token")
      return json({ message: "no" }, 401);
    const m = /^\/api\/v1\/domains\/([^/]+)\/dns-records(?:\/(\d+))?$/.exec(url.pathname);
    if (!m || m[1] !== zone) return json({ message: "domain not found" }, 404);
    if (method === "GET") return json({ meta: { total: records.length }, dns_records: records });
    if (method === "POST") {
      const b = JSON.parse(String(init?.body)) as { subdomain: string; type: string; value: string };
      const rec = {
        id: ++seq,
        type: b.type,
        fqdn: b.subdomain ? `${b.subdomain}.${zone}` : zone,
        data: { subdomain: b.subdomain, value: b.value },
      };
      records.push(rec);
      return json({ dns_record: rec }, 201);
    }
    if (method === "DELETE") {
      const i = records.findIndex((r) => r.id === Number(m[2]));
      if (i < 0) return json({ message: "not found" }, 404);
      records.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    return json({ message: "route" }, 404);
  }) as typeof fetch;
  return { f, records, calls };
}

describe("Timeweb DNS backend", () => {
  it("wildcard + apex: two TXT values coexist; present is idempotent; cleanup removes only its value", async () => {
    const tw = fakeTimeweb("sys-example.ru");
    const dns = new TimewebDns({ token: "tw-token", fetch: tw.f });
    const fqdn = "_acme-challenge.sys-example.ru.";
    await dns.presentTxt("sys-example.ru.", fqdn, "v-wild");
    await dns.presentTxt("sys-example.ru.", fqdn, "v-apex");
    await dns.presentTxt("sys-example.ru.", fqdn, "v-apex");
    expect(tw.records.map((r) => [r.data.subdomain, r.type, r.data.value])).toEqual([
      ["_acme-challenge", "TXT", "v-wild"],
      ["_acme-challenge", "TXT", "v-apex"],
    ]);
    await dns.cleanupTxt("sys-example.ru.", fqdn, "v-wild");
    expect(tw.records.map((r) => r.data.value)).toEqual(["v-apex"]);
    await dns.cleanupTxt("sys-example.ru.", fqdn, "v-wild");
    await dns.cleanupTxt("sys-example.ru.", fqdn, "v-apex");
    expect(tw.records).toEqual([]);
    expect(tw.calls.filter((c) => c.startsWith("POST"))).toHaveLength(2);
  });

  it("sub-zone names, records listed with full subdomain, API errors surface", async () => {
    const tw = fakeTimeweb("platform.ru");
    const dns = new TimewebDns({ token: "tw-token", fetch: tw.f });
    await dns.presentTxt("platform.ru", "_acme-challenge.app.platform.ru", "x");
    expect(tw.records[0]?.data.subdomain).toBe("_acme-challenge.app");
    // Some API versions return the full name in data.subdomain: still matched for cleanup.
    (tw.records[0] as Rec).data.subdomain = "_acme-challenge.app.platform.ru";
    await dns.cleanupTxt("platform.ru", "_acme-challenge.app.platform.ru", "x");
    expect(tw.records).toEqual([]);
    await expect(dns.presentTxt("other.ru", "_acme-challenge.other.ru", "x")).rejects.toThrow(
      /domain not found/,
    );
    const bad = new TimewebDns({ token: "wrong", fetch: tw.f });
    await expect(bad.presentTxt("platform.ru", "_acme-challenge.platform.ru", "x")).rejects.toThrow(/401|no/);
    expect(() => new TimewebDns({ token: "" })).toThrow();
  });

  it("selected by DNS_PROVIDER and driven by the webhook protocol", async () => {
    const tw = fakeTimeweb("sys-example.ru");
    const backend = createBackend({ DNS_PROVIDER: "timeweb", TWC_TOKEN: "tw-token" }, tw.f);
    expect(() => createBackend({ DNS_PROVIDER: "nope" })).toThrow(/DNS_PROVIDER/);
    const handle = createWebhook({
      groupName: "acme.wizard.ru",
      solverName: "dns01",
      dns: backend,
      zones: ["sys-example.ru"],
      allowedUsers: ["system:serviceaccount:cert-manager:cert-manager"],
    });
    const res = await handle(
      new Request("https://webhook/apis/acme.wizard.ru/v1alpha1/dns01", {
        method: "POST",
        headers: { "x-remote-user": "system:serviceaccount:cert-manager:cert-manager" },
        body: JSON.stringify({
          apiVersion: "acme.wizard.ru/v1alpha1",
          kind: "ChallengePayload",
          request: {
            uid: "u",
            action: "Present",
            type: "dns-01",
            key: "k1",
            resolvedFQDN: "_acme-challenge.sys-example.ru.",
            resolvedZone: "sys-example.ru.",
          },
        }),
      }),
      { authorized: true, commonName: "front-proxy-client", allowedNames: [] },
    );
    expect(await res.json()).toMatchObject({ response: { uid: "u", success: true } });
    expect(tw.records.map((r) => r.data.value)).toEqual(["k1"]);
  });
});
