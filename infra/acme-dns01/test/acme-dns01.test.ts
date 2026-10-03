// Wildcard TLS via cert-manager DNS-01 on Cloud.ru DNS (deploy.yaml#cloud.domains.tls): API client and webhook protocol.
import { describe, expect, it } from "vitest";
import {
  type CallerInfo,
  CloudruDns,
  createWebhook,
  frontProxyTrust,
  inScope,
  relativeName,
  trusted,
} from "../src/index.js";
import { fakeCloudru } from "./fake-cloudru.js";

const ZONES = [
  { id: "z-sys", domain: "sys-example.ru." },
  { id: "z-plat", domain: "platform.ru" },
];

function client(fake = fakeCloudru({ zones: ZONES, pageSize: 1 })) {
  const dns = new CloudruDns({
    keyId: "kid",
    secret: "sec",
    projectId: "proj",
    fetch: fake.fetch,
    sleep: async () => {},
    pollMs: 1,
  });
  return { dns, fake };
}

const txt = (fake: ReturnType<typeof fakeCloudru>, name: string) =>
  [...fake.records.values()].filter((r) => r.name === name && r.type === "txt");

describe("Cloud.ru DNS client", () => {
  it("relative names under a zone; foreign names throw", () => {
    expect(relativeName("_acme-challenge.sys-example.ru.", "sys-example.ru")).toBe("_acme-challenge");
    expect(relativeName("_acme-challenge.a.sys-example.ru", "sys-example.ru.")).toBe("_acme-challenge.a");
    expect(relativeName("sys-example.ru", "sys-example.ru")).toBe("");
    expect(() => relativeName("_acme-challenge.evil.ru", "sys-example.ru")).toThrow();
  });

  it("wildcard + apex: both values live in one TXT set; cleanup removes one, then the set", async () => {
    const { dns, fake } = client();
    const fqdn = "_acme-challenge.sys-example.ru.";
    await dns.presentTxt("sys-example.ru.", fqdn, "v-wildcard");
    await dns.presentTxt("sys-example.ru.", fqdn, "v-apex");
    await dns.presentTxt("sys-example.ru.", fqdn, "v-apex"); // idempotent
    expect(txt(fake, "_acme-challenge").map((r) => r.values)).toEqual([["v-wildcard", "v-apex"]]);
    expect(txt(fake, "_acme-challenge")[0]?.publicZoneId).toBe("z-sys");
    await dns.cleanupTxt("sys-example.ru.", fqdn, "v-wildcard");
    expect(txt(fake, "_acme-challenge").map((r) => r.values)).toEqual([["v-apex"]]);
    await dns.cleanupTxt("sys-example.ru.", fqdn, "v-apex");
    expect(txt(fake, "_acme-challenge")).toEqual([]);
    await dns.cleanupTxt("sys-example.ru.", fqdn, "v-apex"); // missing → no-op
    // Zones and records were paginated (page size 1); one IAM token served every call.
    expect(fake.tokensIssued).toBe(1);
  });

  it("waits for asynchronous operations", async () => {
    const { dns, fake } = client();
    fake.pendingPolls = 3;
    await dns.presentTxt("platform.ru", "_acme-challenge.platform.ru", "v1");
    expect(fake.calls.filter((c) => c.startsWith("GET /v1/operations/")).length).toBe(3);
  });

  it("a parallel create (409 ALREADY_EXISTS) is merged into the existing set", async () => {
    const { dns, fake } = client();
    fake.raceOn = { name: "_acme-challenge", value: "other" };
    await dns.presentTxt("platform.ru", "_acme-challenge.platform.ru", "mine");
    expect(txt(fake, "_acme-challenge").map((r) => r.values)).toEqual([["other", "mine"]]);
  });

  it("an expired token is refreshed once on 401; bad keys and unknown zones fail", async () => {
    const { dns, fake } = client();
    await dns.presentTxt("platform.ru", "_acme-challenge.platform.ru", "a");
    // Revoke the cached token server-side: the client refreshes and retries.
    const original = fake.fetch;
    let first = true;
    fake.fetch = (async (u: string | URL | Request, i?: RequestInit) => {
      if (first && String(u).includes("dns.api.cloud.ru")) {
        first = false;
        return new Response("{}", { status: 401 });
      }
      return original(u, i);
    }) as typeof fetch;
    const dns2 = new CloudruDns({
      keyId: "kid",
      secret: "sec",
      projectId: "proj",
      fetch: (u, i) => fake.fetch(u, i),
      sleep: async () => {},
    });
    await dns2.cleanupTxt("platform.ru", "_acme-challenge.platform.ru", "a");
    expect(txt(fake, "_acme-challenge")).toEqual([]);
    await expect(dns.presentTxt("unknown.ru", "_acme-challenge.unknown.ru", "x")).rejects.toThrow(
      /not in the Cloud.ru project/,
    );
    const bad = new CloudruDns({
      keyId: "kid",
      secret: "nope",
      projectId: "proj",
      fetch: fake.fetch,
      sleep: async () => {},
    });
    await expect(bad.presentTxt("platform.ru", "_acme-challenge.platform.ru", "x")).rejects.toThrow(
      /IAM token/,
    );
    expect(() => new CloudruDns({ keyId: "", secret: "s", projectId: "p" })).toThrow();
  });
});

describe("cert-manager webhook protocol", () => {
  const GROUP = "acme.wizard.ru";
  const SA = "system:serviceaccount:cert-manager:cert-manager";
  const apiserver: CallerInfo = {
    authorized: true,
    commonName: "front-proxy-client",
    allowedNames: ["front-proxy-client"],
  };
  const setup = () => {
    const { dns, fake } = client();
    const handle = createWebhook({
      groupName: GROUP,
      solverName: "cloudru",
      dns,
      zones: ["sys-example.ru", "platform.ru"],
      allowedUsers: [SA],
    });
    return { handle, fake };
  };
  const challenge = (action: "Present" | "CleanUp", over: Record<string, unknown> = {}) => ({
    apiVersion: `${GROUP}/v1alpha1`,
    kind: "ChallengePayload",
    request: {
      uid: "u-1",
      action,
      type: "dns-01",
      dnsName: "*.sys-example.ru",
      key: "txt-value",
      resolvedFQDN: "_acme-challenge.sys-example.ru.",
      resolvedZone: "sys-example.ru.",
      config: { ttl: 60 },
      ...over,
    },
  });
  const post = (body: unknown, user = SA) =>
    new Request(`https://webhook/apis/${GROUP}/v1alpha1/cloudru`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-remote-user": user },
      body: JSON.stringify(body),
    });

  it("discovery for kube-apiserver; health for kubelet without a certificate", async () => {
    const { handle } = setup();
    const res = await handle(new Request(`https://webhook/apis/${GROUP}/v1alpha1`), apiserver);
    expect(await res.json()).toMatchObject({
      kind: "APIResourceList",
      groupVersion: `${GROUP}/v1alpha1`,
      resources: [{ name: "cloudru", kind: "ChallengePayload", verbs: ["create"] }],
    });
    expect((await handle(new Request("https://webhook/apis"), apiserver)).status).toBe(200);
    const anon: CallerInfo = { authorized: false, commonName: null, allowedNames: [] };
    expect((await handle(new Request("https://webhook/healthz"), anon)).status).toBe(200);
    expect((await handle(new Request(`https://webhook/apis/${GROUP}/v1alpha1`), anon)).status).toBe(401);
  });

  it("a request exactly as cert-manager sends it (no uid, type dns-01) is served", async () => {
    const { handle, fake } = setup();
    const { uid: _uid, ...request } = challenge("Present", { type: "dns-01" }).request;
    const res = await handle(post({ ...challenge("Present"), request }), apiserver);
    expect(await res.json()).toMatchObject({ response: { uid: "", success: true } });
    expect(fake.records.size).toBeGreaterThan(0);
  });

  it("Present / CleanUp through the DNS API; response carries the uid", async () => {
    const { handle, fake } = setup();
    const p = await handle(post(challenge("Present")), apiserver);
    expect(await p.json()).toEqual({
      apiVersion: `${GROUP}/v1alpha1`,
      kind: "ChallengePayload",
      response: { uid: "u-1", success: true },
    });
    expect(txt(fake, "_acme-challenge")).toMatchObject([{ values: ["txt-value"], ttl: 60 }]);
    const c = await handle(post(challenge("CleanUp")), apiserver);
    expect(((await c.json()) as { response: { success: boolean } }).response.success).toBe(true);
    expect(txt(fake, "_acme-challenge")).toEqual([]);
  });

  it("refuses callers that did not come through kube-apiserver or act for another user", async () => {
    const { handle, fake } = setup();
    const noCert: CallerInfo = { authorized: false, commonName: "front-proxy-client", allowedNames: [] };
    expect((await handle(post(challenge("Present")), noCert)).status).toBe(403);
    const wrongCn: CallerInfo = {
      authorized: true,
      commonName: "someone",
      allowedNames: ["front-proxy-client"],
    };
    expect((await handle(post(challenge("Present")), wrongCn)).status).toBe(403);
    expect((await handle(post(challenge("Present"), "system:anonymous"), apiserver)).status).toBe(403);
    expect(fake.records.size).toBe(0);
  });

  it("only _acme-challenge names in the configured zones", async () => {
    const { handle, fake } = setup();
    for (const over of [
      { resolvedFQDN: "_acme-challenge.evil.ru.", resolvedZone: "evil.ru." },
      { resolvedFQDN: "www.sys-example.ru.", resolvedZone: "sys-example.ru." },
      { resolvedFQDN: "_acme-challenge.sys-example.ru.evil.ru.", resolvedZone: "sys-example.ru." },
    ]) {
      const res = await handle(post(challenge("Present", over)), apiserver);
      const body = (await res.json()) as { response: { success: boolean; status?: { message: string } } };
      expect(body.response.success).toBe(false);
    }
    const malformed = await handle(post({ request: { uid: "u-2", action: "Delete" } }), apiserver);
    expect(((await malformed.json()) as { response: { success: boolean } }).response.success).toBe(false);
    expect(fake.records.size).toBe(0);
    expect(
      inScope({ resolvedFQDN: "_acme-challenge.a.platform.ru", resolvedZone: "platform.ru" }, [
        "platform.ru.",
      ]),
    ).toBe(true);
  });

  it("DNS API failures are reported as success=false, not as HTTP errors", async () => {
    const { handle } = setup();
    const res = await handle(
      post(challenge("Present", { resolvedFQDN: "_acme-challenge.nozone.ru.", resolvedZone: "nozone.ru." })),
      apiserver,
    );
    expect(res.status).toBe(200);
    const { handle: h2 } = (() => {
      const handle2 = createWebhook({
        groupName: GROUP,
        solverName: "cloudru",
        dns: {
          presentTxt: async () => {
            throw new Error("quota exceeded");
          },
          cleanupTxt: async () => {},
        },
        zones: ["sys-example.ru"],
        allowedUsers: [SA],
      });
      return { handle: handle2 };
    })();
    const r2 = await h2(post(challenge("Present")), apiserver);
    expect(await r2.json()).toMatchObject({
      response: { uid: "u-1", success: false, status: { message: "quota exceeded" } },
    });
  });
});

describe("front-proxy trust", () => {
  it("parses extension-apiserver-authentication; requires the CA", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
    expect(
      frontProxyTrust({
        "requestheader-client-ca-file": pem,
        "requestheader-allowed-names": '["front-proxy-client"]',
      }),
    ).toEqual({ ca: pem, allowedNames: ["front-proxy-client"] });
    expect(frontProxyTrust({ "requestheader-client-ca-file": pem }).allowedNames).toEqual([]);
    expect(() => frontProxyTrust({})).toThrow();
    expect(() =>
      frontProxyTrust({ "requestheader-client-ca-file": pem, "requestheader-allowed-names": "x" }),
    ).toThrow();
    expect(trusted({ authorized: true, commonName: "x", allowedNames: [] })).toBe(true);
    expect(trusted({ authorized: true, commonName: null, allowedNames: [] })).toBe(false);
  });
});
