// A VM handed over by the founder (tools/deploy/adopt-server.mjs, pilot.mjs resolvePilotServer, tfvars): found by id or
// IP, checked against the shape and the RF, reinstalled once with the k3s bootstrap — never the wrong server. Fake API.
import { describe, expect, it } from "vitest";
import { adoptServer } from "../adopt-server.mjs";
import {
  rebootServer,
  releaseStuckChallenges,
  reportDns,
  reportServerHealth,
  resolvePilotServer,
  SHAPES,
  tfvars,
} from "../pilot.mjs";

const vm = (o = {}) => ({
  id: 9256729,
  name: "BORN TO HOST",
  status: "on",
  location: "ru-2",
  cpu: 4,
  ram: 8192,
  disks: [{ size: 81920 }],
  networks: [{ type: "public", ips: [{ type: "ipv4", ip: "129.101.115.207" }] }],
  ...o,
});

function fakeApi(servers, statuses = []) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push([method, path, body]);
    if (path === "/api/v1/servers") return { servers };
    const m = path.match(/^\/api\/v1\/servers\/(\d+)$/);
    if (m && method === "GET") {
      const s = servers.find((x) => String(x.id) === m[1]);
      // The last status sticks.
      const status = statuses.length > 1 ? statuses.shift() : (statuses[0] ?? s?.status);
      return { server: s && { ...s, status } };
    }
    return {};
  };
  return { api, calls };
}

describe("resolvePilotServer", () => {
  const shape = SHAPES.prod.server;
  it("finds the VM by IP or id; nothing asked → null (OpenTofu creates the VM)", async () => {
    const { api } = fakeApi([vm({ id: 1, networks: [] }), vm()]);
    expect(await resolvePilotServer(api, "129.101.115.207", shape)).toMatchObject({
      id: 9256729,
      ip: "129.101.115.207",
    });
    expect((await resolvePilotServer(api, 9256729, shape)).ip).toBe("129.101.115.207");
    expect(await resolvePilotServer(api, "", shape)).toBeNull();
  });
  it("refuses a missing, smaller or non-RF VM", async () => {
    await expect(resolvePilotServer(fakeApi([vm()]).api, "10.0.0.1", shape)).rejects.toThrow(/не найден/);
    await expect(resolvePilotServer(fakeApi([vm({ ram: 4096 })]).api, 9256729, shape)).rejects.toThrow(
      /меньше нужного/,
    );
    await expect(resolvePilotServer(fakeApi([vm({ location: "nl-1" })]).api, 9256729, shape)).rejects.toThrow(
      /не в РФ/,
    );
  });
  it("tfvars carries the adopted VM", () => {
    const vars = { GITHUB_REPOSITORY_OWNER: "mrflxxxme" };
    const t = tfvars("prod", vars, "ssh-ed25519 AAAA", { id: 9256729, ip: "129.101.115.207", name: "x" });
    expect(t.settings.existing_server).toEqual({ id: 9256729, ip: "129.101.115.207" });
    expect(tfvars("prod", vars, "k").settings.existing_server).toBeUndefined();
  });
});

describe("adoptServer", () => {
  const input = {
    id: "9256729",
    ip: "129.101.115.207",
    osId: "99",
    sshKeyId: "7",
    cloudInit: "#cloud-config\n",
  };
  const opts = { sleep: async () => {}, pollMs: 1, startWaitMs: 5, doneWaitMs: 5 };

  it("attaches the key, reinstalls with the cloud-init and waits until the VM is on again", async () => {
    const { api, calls } = fakeApi([vm()], ["on", "installing", "installing", "on"]);
    const log = [];
    await adoptServer(api, input, { ...opts, log: (s) => log.push(s) });
    expect(calls).toContainEqual(["POST", "/api/v1/servers/9256729/ssh-keys", { ssh_key_ids: [7] }]);
    expect(calls).toContainEqual([
      "PATCH",
      "/api/v1/servers/9256729",
      { os_id: 99, cloud_init: "#cloud-config\n" },
    ]);
    expect(log.at(-1)).toMatch(/переустановлен/);
  });
  it("never touches a server whose IP differs", async () => {
    const { api, calls } = fakeApi([
      vm({ networks: [{ type: "public", ips: [{ type: "ipv4", ip: "1.2.3.4" }] }] }),
    ]);
    await expect(adoptServer(api, input, opts)).rejects.toThrow(/переустановка отменена/);
    expect(calls.filter(([m]) => m !== "GET")).toEqual([]);
  });
  it("fails when the VM does not come back", async () => {
    const { api } = fakeApi([vm()], ["installing"]);
    await expect(adoptServer(api, input, opts)).rejects.toThrow(/не включился/);
  });
});

describe("reportDns", () => {
  it("lists the address records of each zone, nothing else", async () => {
    const api = async (_m, path) => ({
      dns_records: path.includes("p.ru")
        ? [
            { type: "A", data: { subdomain: "", value: "1.2.3.4" } },
            { type: "TXT", data: { subdomain: "", value: "v=spf1 -all" } },
          ]
        : [{ type: "A", data: { subdomain: "*", value: "1.2.3.4" } }],
    });
    const log = [];
    await reportDns(api, ["p.ru", "s.ru"], { log: (s) => log.push(s) });
    expect(log).toEqual(["DNS p.ru: A @ → 1.2.3.4", "DNS s.ru: A * → 1.2.3.4"]);
  });
});

describe("server health and reboot", () => {
  it("reportServerHealth prints the last points of each metric and the latest events", async () => {
    const api = async (_m, path) =>
      path.includes("/statistics")
        ? {
            cpu: [
              { logged_at: "2026-10-03T17:10:00+03:00", load: 12.34 },
              { logged_at: "2026-10-03T17:20:00+03:00", load: 99.9 },
            ],
            response_id: "x",
          }
        : { server_logs: [{ logged_at: "2026-10-03T17:21:00Z", event: "reboot" }] };
    const log = [];
    await reportServerHealth(
      api,
      { id: 7 },
      { log: (s) => log.push(s), now: () => new Date("2026-10-03T18:00:00Z") },
    );
    expect(log).toEqual([
      "  7 cpu: 17:10 load=12.3 | 17:20 load=99.9",
      "  7 событие 2026-10-03T17:21:00Z reboot",
    ]);
  });
  it("rebootServer: a hard reboot, then waits until the VM is on again", async () => {
    const calls = [];
    const statuses = ["off", "on"];
    const api = async (m, path, body) => {
      calls.push([m, path, body]);
      return m === "GET" ? { server: { status: statuses.shift() ?? "on" } } : {};
    };
    await rebootServer(api, { id: 7, name: "x" }, { sleep: async () => {}, pollMs: 1, waitMs: 10 });
    expect(calls[0]).toEqual(["POST", "/api/v1/servers/7/action", { action: "hard_reboot" }]);
  });
});

describe("releaseStuckChallenges", () => {
  it("drops the finalizer of challenges deleted more than 10 minutes ago, nothing else", () => {
    const items = [
      {
        metadata: { name: "old", namespace: "p", deletionTimestamp: "2026-10-03T12:00:00Z" },
        spec: { dnsName: "a.ru" },
      },
      { metadata: { name: "fresh", namespace: "p", deletionTimestamp: "2026-10-03T17:55:00Z" } },
      { metadata: { name: "live", namespace: "p" } },
    ];
    const calls = [];
    const kubectl = (args) => {
      calls.push(args.join(" "));
      return { status: 0, stdout: JSON.stringify({ items }) };
    };
    releaseStuckChallenges({ kubectl, now: () => new Date("2026-10-03T18:00:00Z") });
    expect(calls.filter((c) => c.includes("patch"))).toEqual([
      'p patch challenges.acme.cert-manager.io old --type=merge -p {"metadata":{"finalizers":[]}}'.replace(
        /^/,
        "-n ",
      ),
    ]);
  });
});
