// V3-32: the cloud runner of the repository sandbox — gVisor pods per phase, created by platform-api. Without a cluster:
// the manifests (pod, NetworkPolicies) are checked field by field; the runner works against a fake Kubernetes API that
// either scripts pod states or emulates a kubelet (the real restore/save scripts and GNU tar on temp directories; the
// commands of the run step are this test's own `node -e`, not a client's code). Covered: network by phase, the
// workspace carried between phases (and the agent's changes), output cap, time limit, size limit, quota waits, stuck
// and unschedulable pods, the isolation probe, eviction and OOM, abort, cleanup and the TTL sweep.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SandboxCommand, SandboxPolicyError, snapshotOf } from "@wizard/agents/repo";
import { EgressGrants, egressGrantKey } from "@wizard/runtime";
import { afterAll, describe, expect, test } from "vitest";
import { NeedsOwner, RetryLater } from "../src/git-sync/context.js";
import {
  PodSandbox,
  type PodSandboxOptions,
  PROBE_JS,
  podEnv,
  quantityBytes,
  REGISTRY_HOSTS,
  RepoAgent,
  type RepoAgentOptions,
  registryHosts,
  repoKube,
  repoSandboxFromEnv,
  repoSandboxNetworkPolicy,
  repoSandboxPod,
  snapshotEntries,
  tar,
} from "../src/repo-agent/index.js";
import { FakeRepoKube, finalStatus, type Obj, term } from "./repo-kube-fake.js";

const TOKEN = "g2.test-grant.sig";
const fakes: FakeRepoKube[] = [];
afterAll(() => {
  for (const k of fakes) k.cleanup();
});

function sandbox(o: Partial<PodSandboxOptions> & { scripted?: boolean } = {}) {
  const kube = new FakeRepoKube();
  fakes.push(kube);
  const sb = new PodSandbox({
    kube,
    namespace: "wizard-sandbox",
    image: "registry.example/wizard/wizard-repo-sandbox:abc",
    proxy: async () => ({ host: "10.43.0.9", port: 3128 }),
    grant: () => TOKEN,
    pollMs: o.scripted ? 1000 : 20,
    ...(o.scripted ? { now: kube.now, sleep: kube.sleep } : {}),
    ...o,
  });
  return { kube, sb };
}

const cmd = (phase: SandboxCommand["phase"], code: string, timeoutMs = 30_000): SandboxCommand => ({
  phase,
  argv: [process.execPath, "-e", code],
  network: phase === "install" ? "registry" : "none",
  timeoutMs,
  label: "node -e",
});

const pod = (phase: SandboxCommand["phase"], extra: Record<string, unknown> = {}): Obj =>
  repoSandboxPod({
    name: "wz-repo-1-x",
    namespace: "wizard-sandbox",
    workspace: "1",
    phase,
    argv: ["pnpm", "run", "build"],
    timeoutMs: 600_000,
    image: "i",
    pvc: "wz-repo-1",
    save: phase !== "test",
    ...extra,
  }) as Obj;

const envOf = (c: Obj) => Object.fromEntries((c.env as Obj[]).map((e) => [e.name, e.value]));

describe("the pod of a phase (contract)", () => {
  test("gVisor, no service account token, no DNS, PodSecurity restricted in every container, the deadline", () => {
    const p = pod("build", { snapshot: ["cm-snap-0"], changes: ["cm-ch-0"] });
    const spec = p.spec;
    expect(spec).toMatchObject({
      runtimeClassName: "gvisor",
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      dnsPolicy: "None",
      dnsConfig: { nameservers: ["127.0.0.1"] },
      activeDeadlineSeconds: 600 + 600,
      nodeSelector: { "wizard.ru/pool": "free" },
    });
    expect(spec.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      fsGroup: 10001,
      seccompProfile: { type: "RuntimeDefault" },
    });
    const all = [...spec.initContainers, ...spec.containers] as Obj[];
    expect(all.map((c) => c.name)).toEqual(["restore", "run", "save"]);
    for (const c of all) {
      expect(c.securityContext).toEqual({
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        privileged: false,
        capabilities: { drop: ["ALL"] },
      });
      // Within the sandbox LimitRange (max 2 CPU, 2Gi per container).
      expect(quantityBytes(c.resources.limits.memory)).toBeLessThanOrEqual(2 * 2 ** 30);
      expect(Number(c.resources.limits.cpu)).toBeLessThanOrEqual(2);
      expect(c.resources.requests.memory).toBe(c.resources.limits.memory);
    }
    // Volumes PodSecurity restricted allows: emptyDir (sized), the PVC, ConfigMaps through projected.
    for (const v of spec.volumes as Obj[])
      expect(Object.keys(v).filter((k) => k !== "name")).toEqual([
        expect.stringMatching(/^(emptyDir|persistentVolumeClaim|projected)$/),
      ]);
    expect((spec.volumes as Obj[]).find((v) => v.name === "work")?.emptyDir).toEqual({ sizeLimit: "3Gi" });
  });

  test("only the trusted steps touch the saved workspace and the platform's files; the command sees /work and /tmp", () => {
    const [restore, run] = pod("build", { snapshot: ["s"], changes: ["c"] }).spec.initContainers as Obj[];
    const save = pod("build").spec.containers[0] as Obj;
    const mounts = (c: Obj) =>
      (c.volumeMounts as Obj[]).map((m) => `${m.name}:${m.mountPath}:${m.readOnly ? "ro" : "rw"}`);
    expect(mounts(restore as Obj)).toEqual([
      "work:/work:rw",
      "tmp:/tmp:rw",
      "store:/store:ro",
      "snap:/in/snap:ro",
      "changes:/in/changes:ro",
    ]);
    expect(mounts(run as Obj)).toEqual(["work:/work:rw", "tmp:/tmp:rw"]);
    expect(mounts(save)).toEqual(["work:/work:ro", "tmp:/tmp:rw", "store:/store:rw"]);
    // The command under `timeout` (PID 1 of its container), in the repository.
    expect(run?.command).toEqual(["timeout", "-k", "10", "600", "pnpm", "run", "build"]);
    expect(run?.workingDir).toBe("/work/repo");
    expect(envOf(save)).toEqual({ WZ_SAVE: "1", WZ_LIMIT_KIB: String(3 * 1024 * 1024) });
    expect(envOf(pod("test").spec.containers[0]).WZ_SAVE).toBe("0");
  });

  test("install: the egress proxy by address with the grant, label «registry»; the rest: offline, no proxy, «none»", () => {
    const install = pod("install", { proxyUrl: `http://wizard:${TOKEN}@10.43.0.9:3128` });
    expect(install.metadata.labels).toEqual({
      "app.kubernetes.io/name": "wizard-repo-sandbox",
      "wizard.ru/repo-sandbox-ws": "1",
      "wizard.ru/repo-sandbox-network": "registry",
      "wizard.ru/repo-sandbox-phase": "install",
    });
    const ie = envOf(install.spec.initContainers[1]);
    for (const k of ["HTTPS_PROXY", "https_proxy", "npm_config_https_proxy", "YARN_HTTPS_PROXY"])
      expect(ie[k]).toBe(`http://wizard:${TOKEN}@10.43.0.9:3128`);
    expect(ie.npm_config_offline).toBeUndefined();
    expect(ie.COREPACK_NPM_REGISTRY).toBe("https://registry.npmjs.org");
    // Downloads from CDNs (browsers of puppeteer/playwright, cypress, electron) would fail behind the proxy: skipped.
    expect(ie).toMatchObject({ PUPPETEER_SKIP_DOWNLOAD: "1", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" });
    for (const phase of ["build", "test", "agent"] as const) {
      const p = pod(phase);
      expect(p.metadata.labels["wizard.ru/repo-sandbox-network"]).toBe("none");
      const e = envOf(p.spec.initContainers[1]);
      expect(e).toMatchObject({
        npm_config_offline: "true",
        YARN_ENABLE_NETWORK: "0",
        COREPACK_ENABLE_NETWORK: "0",
      });
      expect(JSON.stringify(p)).not.toMatch(/PROXY|wizard:/);
    }
    // Nothing of the platform in any environment: built from scratch.
    expect(JSON.stringify([install.spec.initContainers, install.spec.containers])).not.toMatch(
      /WIZARD_|DATABASE|SECRET|INTERNAL_TOKEN/,
    );
    expect(envOf(install.spec.initContainers[1]).NODE_OPTIONS).toBe("--max-old-space-size=1536");
  });

  test("the registry: npm by default, else the stand's mirror for every manager (and an https mirror only)", () => {
    expect(registryHosts()).toEqual([...REGISTRY_HOSTS]);
    expect(registryHosts("https://npm.mirror.example.ru/repository/npm/")).toEqual(["npm.mirror.example.ru"]);
    expect(() => registryHosts("http://npm.mirror.example.ru")).toThrow(/https/);
    expect(() => registryHosts("https://npm.mirror.example.ru:8443")).toThrow(/443/);
    const e = Object.fromEntries(
      podEnv("registry", { registry: "https://npm.mirror.example.ru/" }).map((x) => [x.name, x.value]),
    );
    expect(e).toMatchObject({
      npm_config_registry: "https://npm.mirror.example.ru/",
      YARN_NPM_REGISTRY_SERVER: "https://npm.mirror.example.ru/",
      COREPACK_NPM_REGISTRY: "https://npm.mirror.example.ru/",
    });
  });

  test("NetworkPolicy: build, tests and the agent — nothing; install — only the egress proxy; no ingress", () => {
    const [none, registry] = repoSandboxNetworkPolicy({
      namespace: "sandbox",
      proxy: { namespace: "platform", selector: { "wizard.ru/role": "egress-proxy" }, port: 3128 },
    }) as Obj[];
    expect(none?.spec).toEqual({
      podSelector: {
        matchLabels: {
          "app.kubernetes.io/name": "wizard-repo-sandbox",
          "wizard.ru/repo-sandbox-network": "none",
        },
      },
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress: [],
    });
    expect(registry?.spec.podSelector.matchLabels["wizard.ru/repo-sandbox-network"]).toBe("registry");
    expect(registry?.spec.ingress).toEqual([]);
    expect(registry?.spec.egress).toEqual([
      {
        to: [
          {
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "platform" } },
            podSelector: { matchLabels: { "wizard.ru/role": "egress-proxy" } },
          },
        ],
        ports: [{ protocol: "TCP", port: 3128 }],
      },
    ]);
  });
});

describe("the files of a workspace", () => {
  test("GNU tar unpacks what the platform packs: long and Cyrillic names, symlinks, executables", () => {
    const long = `${"каталог/".repeat(20)}file.txt`;
    const deep = `${"d".repeat(99)}/${"e".repeat(99)}/${"f".repeat(80)}.txt`;
    const dir = mkdtempSync(join(tmpdir(), "wz-tar-"));
    try {
      const archive = tar([
        { path: "a.txt", data: Buffer.from("текст") },
        { path: long, data: Buffer.from("long") },
        { path: deep, data: Buffer.alloc(1500, 65) },
        { path: "bin/run.sh", data: Buffer.from("#!/bin/sh\necho ok\n"), exec: true },
        { path: "link", link: "a.txt" },
        { path: "ссылка", link: `${"x/".repeat(60)}target` },
      ]);
      expect(archive.length % 512).toBe(0);
      const r = spawnSync("tar", ["-xf", "-", "-C", dir], { input: archive });
      expect(r.status, String(r.stderr)).toBe(0);
      expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("текст");
      expect(readFileSync(join(dir, long), "utf8")).toBe("long");
      expect(readFileSync(join(dir, deep)).length).toBe(1500);
      expect(statSync(join(dir, "bin/run.sh")).mode & 0o111).not.toBe(0);
      expect(statSync(join(dir, "a.txt")).mode & 0o111).toBe(0);
      expect(readlinkSync(join(dir, "link"))).toBe("a.txt");
      expect(readlinkSync(join(dir, "ссылка"))).toBe(`${"x/".repeat(60)}target`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the snapshot keeps to the repository: no submodules, no symlinks outward, no unsafe paths", () => {
    const entries = snapshotEntries(
      snapshotOf({
        "src/a.ts": "export {}",
        "run.sh": { exec: "#!/bin/sh" },
        "ok-link": { link: "src/a.ts" },
        "up-link": { link: "../../etc/passwd" },
        "abs-link": { link: "/etc/passwd" },
        vendor: { submodule: "0".repeat(40) },
      }),
    );
    expect(entries.map((e) => [e.path, e.link ?? null, e.exec ?? false])).toEqual([
      ["ok-link", "src/a.ts", false],
      ["run.sh", null, true],
      ["src/a.ts", null, false],
    ]);
  });
});

describe("the runner against the Kubernetes API (emulated kubelet)", () => {
  test("install → build → the agent's change → tests: network by phase, the workspace carried in a PVC", async () => {
    const { kube, sb } = sandbox();
    const ws = await sb.open(
      snapshotOf({
        "package.json": '{"name":"x"}',
        "src/a.txt": "текст",
        "src/old.txt": "old",
        "ok-link": { link: "src/a.txt" },
        "evil-link": { link: "../../../../etc/passwd" },
      }),
    );
    // The snapshot in immutable ConfigMaps of the workspace, its PVC with the store's size.
    const cms = [...kube.objects.configmaps.values()];
    expect(cms).toHaveLength(1);
    expect(cms[0]).toMatchObject({
      immutable: true,
      metadata: { labels: { "app.kubernetes.io/name": "wizard-repo-sandbox" } },
    });
    expect(Object.keys(cms[0]?.binaryData)).toEqual(["part-0000"]);
    const pvc = [...kube.objects.persistentvolumeclaims.values()][0];
    expect(pvc?.spec).toEqual({
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: "6Gi" } },
    });

    const install = await ws.run(
      cmd(
        "install",
        `const fs=require("fs");fs.mkdirSync("node_modules/dep",{recursive:true});fs.writeFileSync("node_modules/dep/index.js","1");console.log(JSON.stringify({a:fs.readFileSync("src/a.txt","utf8"),ok:fs.readFileSync("ok-link","utf8"),evil:fs.existsSync("evil-link"),proxy:process.env.HTTPS_PROXY,home:process.env.HOME.endsWith("/home"),secret:process.env.WIZARD_INTERNAL_TOKEN??null}))`,
      ),
    );
    expect(install).toMatchObject({ phase: "install", ok: true, exitCode: 0, timedOut: false });
    expect(JSON.parse(install.output.trim())).toEqual({
      a: "текст",
      ok: "текст",
      evil: false,
      proxy: "http://wizard:***@10.43.0.9:3128",
      home: true,
      secret: null,
    });
    expect(install.output).not.toContain(TOKEN);
    expect(kube.created[0]?.metadata.labels["wizard.ru/repo-sandbox-network"]).toBe("registry");
    // Saved: the client's files leave the ConfigMaps; the phase pod is gone.
    expect(kube.objects.configmaps.size).toBe(0);
    expect(kube.objects.pods.size).toBe(0);
    expect(existsSync(join(kube.root, "pvc", pvc?.metadata.name, "ws.tar"))).toBe(true);

    const build = await ws.run(
      cmd(
        "build",
        `const fs=require("fs");fs.mkdirSync("dist");fs.writeFileSync("dist/out.txt","built");console.log(fs.readFileSync("node_modules/dep/index.js","utf8"),process.env.npm_config_offline,process.env.HTTPS_PROXY??"no-proxy")`,
      ),
    );
    expect(build).toMatchObject({ ok: true, exitCode: 0 });
    expect(build.output.trim()).toBe("1 true no-proxy");
    expect(kube.created[1]?.metadata.labels["wizard.ru/repo-sandbox-network"]).toBe("none");

    await ws.write(
      new Map<string, string | null>([
        ["src/a.txt", "правка"],
        ["src/new.txt", "новый"],
        ["src/old.txt", null],
        ["../outside.txt", "x"],
      ]),
    );
    const agent = await ws.run(
      cmd(
        "agent",
        `const fs=require("fs");console.log(JSON.stringify([fs.readFileSync("src/a.txt","utf8"),fs.readFileSync("src/new.txt","utf8"),fs.existsSync("src/old.txt"),fs.readFileSync("dist/out.txt","utf8"),fs.existsSync("../outside.txt")]))`,
      ),
    );
    expect(JSON.parse(agent.output.trim())).toEqual(["правка", "новый", false, "built", false]);
    // The changes travelled in their own ConfigMap, deleted with the phase.
    expect(kube.calls.filter((c) => /configmaps .*-ch\d+-0$/.test(c))).toHaveLength(2);
    expect(kube.objects.configmaps.size).toBe(0);

    // Tests are not saved: what they write is gone for the next phase; the change stays.
    const t1 = await ws.run(
      cmd("test", `require("fs").writeFileSync("coverage.txt","x");console.log("tests ok")`),
    );
    expect(t1).toMatchObject({ phase: "test", ok: true });
    const after = await ws.run(
      cmd(
        "agent",
        `const fs=require("fs");console.log(fs.existsSync("coverage.txt"),fs.readFileSync("src/a.txt","utf8"))`,
      ),
    );
    expect(after.output.trim()).toBe("false правка");

    await ws.close();
    for (const kind of ["pods", "configmaps", "persistentvolumeclaims"] as const)
      expect(kube.objects[kind].size, kind).toBe(0);
    await expect(ws.run(cmd("build", "1"))).rejects.toThrow(/closed/);
  }, 60_000);

  test("a failing command: its exit code and output; nothing it wrote survives into the next phase", async () => {
    const { sb } = sandbox();
    const ws = await sb.open(snapshotOf({ "package.json": "{}" }));
    try {
      const fail = await ws.run(
        cmd(
          "build",
          `require("fs").writeFileSync("half.txt","x");console.error("Error: boom");process.exit(3)`,
        ),
      );
      expect(fail).toMatchObject({ ok: false, exitCode: 3, timedOut: false });
      expect(fail.output).toContain("Error: boom");
      const next = await ws.run(cmd("build", `console.log(require("fs").existsSync("half.txt"))`));
      expect(next.output.trim()).toBe("false");
    } finally {
      await ws.close();
    }
  }, 60_000);

  test("time limit: `timeout` stops the command, the result says so; output is the last 8 KB", async () => {
    const { sb } = sandbox();
    const ws = await sb.open(snapshotOf({ "package.json": "{}" }));
    try {
      const slow = await ws.run(cmd("agent", "setInterval(() => {}, 1000)", 1000));
      expect(slow).toMatchObject({ ok: false, timedOut: true, exitCode: 124 });
      expect(slow.output).toContain("[песочница] команда остановлена");
      const loud = await ws.run(cmd("build", `process.stdout.write("x".repeat(20000)+"END")`));
      expect(loud.output.length).toBeLessThanOrEqual(8 * 1024);
      expect(loud.output.endsWith("END")).toBe(true);
    } finally {
      await ws.close();
    }
  }, 60_000);

  test("a workspace over its size is not saved (trusted save step, exit 3) and the owner reads why", async () => {
    const { sb } = sandbox({ workspaceSize: "256Ki" });
    const ws = await sb.open(snapshotOf({ "package.json": "{}" }));
    try {
      const big = await ws.run(
        cmd("install", `require("fs").writeFileSync("big.bin",Buffer.alloc(1024*1024,1))`),
      );
      expect(big).toMatchObject({ ok: false, exitCode: 0, timedOut: false });
      expect(big.output).toContain("[песочница] рабочий каталог больше 256 КБ");
    } finally {
      await ws.close();
    }
  }, 60_000);

  test("network outside install is refused before any pod", async () => {
    const { kube, sb } = sandbox();
    const ws = await sb.open(snapshotOf({ "package.json": "{}" }));
    await expect(ws.run({ ...cmd("build", "1"), network: "registry" })).rejects.toBeInstanceOf(
      SandboxPolicyError,
    );
    expect(kube.created).toHaveLength(0);
    await ws.close();
  });
});

describe("the runner against the Kubernetes API (scripted states)", () => {
  const open = async (
    o: Parameters<typeof sandbox>[0],
    script: (p: Obj) => ReturnType<NonNullable<FakeRepoKube["script"]>>,
  ) => {
    const s = sandbox({ scripted: true, ...o });
    s.kube.script = script;
    const ws = await s.sb.open(snapshotOf({ "package.json": "{}" }));
    return { ...s, ws };
  };
  const ok = finalStatus(
    "Succeeded",
    [term("restore", 0), term("run", 0, { ms: 42_000 })],
    [term("save", 0)],
  );

  test("the namespace quota: waits for room, then gives up as «busy» (retried later), nothing left behind", async () => {
    const { kube, ws } = await open({ quotaWaitMs: 60_000 }, () => ({ status: ok, logs: { run: "done\n" } }));
    kube.quotaRefusals.pods = 3;
    const r = await ws.run(cmd("build", "1"));
    expect(r).toMatchObject({ ok: true, durationMs: 42_000, output: "done\n" });
    expect(kube.calls.filter((c) => c.startsWith("create pods"))).toHaveLength(4);
    kube.quotaRefusals.pods = 1000;
    const busy = await ws.run(cmd("build", "1")).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(RetryLater);
    expect((busy as RetryLater).code).toBe("SANDBOX_BUSY");
    expect(kube.objects.pods.size).toBe(0);
    await ws.close();
  });

  test("a pod that cannot start (image pull, nowhere to schedule) is the platform's problem: RetryLater, pod deleted", async () => {
    const { kube, ws } = await open({}, (p) =>
      p.metadata.labels["wizard.ru/repo-sandbox-phase"] === "build"
        ? { pending: Number.POSITIVE_INFINITY, waiting: "ImagePullBackOff" }
        : { pending: Number.POSITIVE_INFINITY, unschedulable: true },
    );
    for (const phase of ["build", "agent"] as const) {
      const e = await ws.run(cmd(phase, "1")).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RetryLater);
      expect((e as RetryLater).message_ru).toMatch(/не запустилась/);
    }
    expect(kube.objects.pods.size).toBe(0);
    await ws.close();
  });

  test("the restore step finds the network open (isolation not in effect): no command runs, RetryLater", async () => {
    const { kube, ws } = await open({}, () => ({
      status: finalStatus("Failed", [term("restore", 70)]),
      logs: { restore: "restore: network isolation is not in effect\n" },
    }));
    const e = await ws.run(cmd("build", "1")).catch((x: unknown) => x);
    expect((e as RetryLater).message_ru).toMatch(/изоляцию сети/);
    expect(kube.objects.pods.size).toBe(0);
    await ws.close();
  });

  test("OOM and eviction: the command failed — the owner reads the limit; not a timeout", async () => {
    const { ws } = await open({ memory: "1536Mi", workspaceSize: "3Gi" }, (p) =>
      p.metadata.labels["wizard.ru/repo-sandbox-phase"] === "build"
        ? {
            status: finalStatus("Failed", [
              term("restore", 0),
              term("run", 137, { reason: "OOMKilled", ms: 5000 }),
            ]),
          }
        : {
            status: finalStatus("Failed", [term("restore", 0), term("run", 137, { ms: 5000 })], [], {
              reason: "Evicted",
              message: 'Usage of EmptyDir volume "work" exceeds the limit "3Gi".',
            }),
          },
    );
    const oom = await ws.run(cmd("build", "1"));
    expect(oom).toMatchObject({ ok: false, timedOut: false, exitCode: 137 });
    expect(oom.output).toBe("[песочница] процесс остановлен: не хватило памяти (предел 1,5 ГБ)\n");
    const ev = await ws.run(cmd("agent", "1"));
    expect(ev).toMatchObject({ ok: false, timedOut: false });
    expect(ev.output).toContain("рабочий каталог больше 3 ГБ");
    await ws.close();
  });

  test("a pod that never gets to the command by the deadline: the platform's failure (RetryLater), pod deleted", async () => {
    const { kube, ws } = await open({ prepMs: 60_000 }, () => ({ pending: Number.POSITIVE_INFINITY }));
    const e = await ws.run(cmd("build", "1", 120_000)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RetryLater);
    expect(kube.objects.pods.size).toBe(0);
    await ws.close();
  });

  test("deadline while the command runs → timedOut; abort → the pod goes, the result is a failure", async () => {
    const running = {
      status: {
        status: {
          phase: "Running",
          initContainerStatuses: [
            term("restore", 0),
            { name: "run", state: { running: { startedAt: "2026-10-09T10:00:00Z" } } },
          ],
        },
      },
    };
    const { kube, ws } = await open({ prepMs: 60_000 }, () => ({ ...running, pending: 0 }));
    // A scripted «Running» status never ends: the platform deadline (limit + prep + 30 s) ends it.
    const r = await ws.run(cmd("build", "1", 120_000));
    expect(r).toMatchObject({ ok: false, timedOut: true, exitCode: null });
    expect(kube.objects.pods.size).toBe(0);
    const aborted = await ws.run(cmd("build", "1", 120_000), AbortSignal.abort());
    expect(aborted).toMatchObject({ ok: false, timedOut: false, exitCode: null });
    expect(kube.objects.pods.size).toBe(0);
    // The pod's deadline hits the save after a successful command: not a timeout of the command, the save failed.
    kube.script = () => ({
      status: finalStatus("Failed", [term("restore", 0), term("run", 0)], [], { reason: "DeadlineExceeded" }),
    });
    const late = await ws.run(cmd("build", "1"));
    expect(late).toMatchObject({ ok: false, timedOut: false, exitCode: 0 });
    expect(late.output).toBe("[песочница] не удалось сохранить рабочий каталог после команды\n");
    await ws.close();
  });

  test("the sweep removes the sandbox's objects older than the TTL and nothing else", async () => {
    const { kube, sb } = sandbox({ scripted: true, ttlMs: 60 * 60_000 });
    const ws = await sb.open(snapshotOf({ "package.json": "{}" }));
    // Someone else's ConfigMap in the namespace (the runtime's workerd config): never listed by our selector.
    await kube.create("configmaps", {
      metadata: { name: "wz-runtime-x", labels: { "app.kubernetes.io/name": "wizard-sandbox" } },
    });
    expect(await sb.sweep()).toBe(0);
    kube.t += 61 * 60_000;
    expect(await sb.sweep()).toBe(2);
    expect([...kube.objects.configmaps.keys()]).toEqual(["wz-runtime-x"]);
    expect(kube.objects.persistentvolumeclaims.size).toBe(0);
    await ws.close();
  });

  test("a repository too large for the ConfigMaps is the owner's (NeedsOwner) and leaves nothing", async () => {
    const { kube, sb } = sandbox({ scripted: true });
    const e = await sb
      .open(snapshotOf({ "blob.bin": randomBytes(46 * 1024 * 1024) }))
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NeedsOwner);
    for (const kind of ["pods", "configmaps", "persistentvolumeclaims"] as const)
      expect(kube.objects[kind].size).toBe(0);
  }, 60_000);
});

describe("the isolation probe of the restore step", () => {
  const probe = (target: string) =>
    spawnSync(process.execPath, ["-e", PROBE_JS], {
      env: { PATH: process.env.PATH, WZ_PROBE: target, WZ_PROBE_TRIES: "2" },
      encoding: "utf8",
      timeout: 20_000,
    });

  test("an unreachable API server lets the restore go on; a reachable one fails the pod (70)", async () => {
    const server = createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      expect(probe(`127.0.0.1:${port}`).status).toBe(70);
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(probe(`127.0.0.1:${port}`).status).toBe(0);
  }, 30_000);
});

describe("the Kubernetes API client", () => {
  test("paths and verbs of the sandbox namespace; 404 on delete and get is no error; logs by tail and size", async () => {
    const seen: string[] = [];
    const answers: Record<string, { status: number; text: string }> = {
      "GET /api/v1/namespaces/wizard-sandbox/pods/missing": { status: 404, text: "{}" },
      "DELETE /api/v1/namespaces/wizard-sandbox/pods/gone?gracePeriodSeconds=0": { status: 404, text: "{}" },
      "GET /api/v1/namespaces/wizard-sandbox/pods?labelSelector=wizard.ru%2Frepo-sandbox-ws%3Dab": {
        status: 200,
        text: JSON.stringify({
          items: [
            { metadata: { name: "p1", labels: { a: "b" }, creationTimestamp: "2026-10-09T10:00:00Z" } },
          ],
        }),
      },
      "GET /api/v1/namespaces/wizard-sandbox/pods/p1/log?container=run&tailLines=200&limitBytes=1048576": {
        status: 200,
        text: '{"not":"json for us"}\n',
      },
      "GET /api/v1/namespaces/wizard-sandbox/pods/p2/log?container=run&tailLines=200&limitBytes=1048576": {
        status: 400,
        text: "{}",
      },
      "POST /api/v1/namespaces/wizard-sandbox/pods": {
        status: 403,
        text: JSON.stringify({ message: 'pods "x" is forbidden: exceeded quota' }),
      },
    };
    const k = repoKube("wizard-sandbox", async (method, path) => {
      seen.push(`${method} ${path}`);
      return answers[`${method} ${path}`] ?? { status: 201, text: "{}" };
    });
    expect(await k.getPod("missing")).toBeNull();
    await k.delete("pods", "gone");
    await k.delete("persistentvolumeclaims", "wz-repo-ab");
    expect(await k.list("pods", "wizard.ru/repo-sandbox-ws=ab")).toEqual([
      { name: "p1", labels: { a: "b" }, createdAt: Date.parse("2026-10-09T10:00:00Z") },
    ]);
    expect(await k.podLog("p1", "run", { tailLines: 200, limitBytes: 1048576 })).toBe(
      '{"not":"json for us"}\n',
    );
    expect(await k.podLog("p2", "run", { tailLines: 200, limitBytes: 1048576 })).toBe("");
    await expect(k.create("pods", {})).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/exceeded quota/),
    });
    await k.create("configmaps", {});
    expect(seen).toContain("DELETE /api/v1/namespaces/wizard-sandbox/persistentvolumeclaims/wz-repo-ab");
    expect(seen).toContain("POST /api/v1/namespaces/wizard-sandbox/configmaps");
    expect(seen.every((s) => s.includes("/namespaces/wizard-sandbox/"))).toBe(true);
  });
});

describe("the runner of a stand", () => {
  const ENV = {
    WIZARD_REPO_SANDBOX: "pod",
    WIZARD_REPO_SANDBOX_IMAGE: "registry.example/wizard/wizard-repo-sandbox:abc",
    WIZARD_REPO_SANDBOX_PROXY: "http://10.43.0.9:3128",
    WIZARD_INTERNAL_TOKEN: "t".repeat(32),
    KUBERNETES_SERVICE_HOST: "10.43.0.1",
    KUBERNETES_SERVICE_PORT: "443",
  };

  test("pod in the cloud (whatever WIZARD_UNSAFE_LOCAL_EXEC says); its grants open the registry hosts only", async () => {
    const kube = new FakeRepoKube();
    fakes.push(kube);
    const sb = repoSandboxFromEnv({ unsafeLocalExec: false }, ENV, { kube, sweep: false }) as PodSandbox;
    expect(sb.kind).toBe("pod");
    expect(sb.o.probe).toBe("10.43.0.1:443");
    expect(await sb.o.proxy()).toEqual({ host: "10.43.0.9", port: 3128 });
    // The runtime (egress-authorize) opens the grant with the key of the same secret.
    const g = new EgressGrants(egressGrantKey(ENV)).open(sb.o.grant(registryHosts(), 700_000));
    expect(g).toMatchObject({
      systemId: "repo_sandbox",
      https: ["registry.npmjs.org", "registry.yarnpkg.com"],
      maxBytes: 1024 * 1024 * 1024,
      maxDurationMs: 700_000,
    });
    const mirror = repoSandboxFromEnv(
      { unsafeLocalExec: false },
      { ...ENV, WIZARD_REPO_SANDBOX_REGISTRY: "https://npm.mirror.example.ru/" },
      { kube, sweep: false },
    ) as PodSandbox;
    expect(mirror.o.registry).toBe("https://npm.mirror.example.ru/");
  });

  test("a misconfigured pod runner fails loudly; the process runner stays local-only", () => {
    const { WIZARD_REPO_SANDBOX_IMAGE: _i, ...noImage } = ENV;
    expect(() => repoSandboxFromEnv({ unsafeLocalExec: false }, noImage, { sweep: false })).toThrow(/IMAGE/);
    const { WIZARD_INTERNAL_TOKEN: _t, ...noKey } = ENV;
    expect(() => repoSandboxFromEnv({ unsafeLocalExec: false }, noKey, { sweep: false })).toThrow(
      /INTERNAL_TOKEN/,
    );
    expect(repoSandboxFromEnv({ unsafeLocalExec: false }, { WIZARD_REPO_SANDBOX: "process" })).toBeNull();
    expect(repoSandboxFromEnv({ unsafeLocalExec: false }, {})).toBeNull();
  });
});

describe("who runs the tasks", () => {
  const ENV = {
    WIZARD_REPO_SANDBOX: "pod",
    WIZARD_REPO_SANDBOX_IMAGE: "registry.example/wizard/wizard-repo-sandbox:abc",
    WIZARD_REPO_SANDBOX_PROXY: "http://10.43.0.9:3128",
    WIZARD_INTERNAL_TOKEN: "t".repeat(32),
  };
  const sync = { available: true, d: { now: () => new Date() } } as unknown as RepoAgentOptions["sync"];
  const agent = (o: Partial<RepoAgentOptions>) =>
    new RepoAgent({
      db: {} as RepoAgentOptions["db"],
      config: { unsafeLocalExec: false } as RepoAgentOptions["config"],
      sync,
      billing: {} as RepoAgentOptions["billing"],
      env: ENV,
      ...o,
    });

  test("platform-api (enqueue-only) builds no runner and no Kubernetes client, runs nothing, reports the stand's sandbox", async () => {
    // Building the pod runner here would need the service account files: it must not even be tried.
    const api = agent({ executes: false });
    expect(api.sandbox).toBeNull();
    expect(api.sandboxKind).toBe("pod");
    expect(await api.tick()).toBe(0);
    api.start();
    api.stop();
    expect(agent({ executes: false, env: {} }).sandboxKind).toBeNull();
  });

  test("the executing process (the worker) builds the runner from its env", () => {
    expect(() => agent({})).toThrow(/KUBERNETES_SERVICE_HOST/);
    const kube = new FakeRepoKube();
    fakes.push(kube);
    const fake = new PodSandbox({
      kube,
      namespace: "n",
      image: "i",
      proxy: async () => ({ host: "10.0.0.1", port: 1 }),
      grant: () => TOKEN,
    });
    const worker = agent({ sandbox: fake });
    expect(worker.sandbox).toBe(fake);
    expect(worker.sandboxKind).toBe("pod");
  });
});
