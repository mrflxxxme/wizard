// M2-06: the Helm chart and images stay consistent with the code they deploy.
// * the sandbox NetworkPolicy is generated from apps/runtime sandboxNetworkPolicy() (WIZARD_UPDATE_GENERATED=1 rewrites),
//   the repository sandbox's (V3-32) from apps/platform-api repoSandboxNetworkPolicy();
// * images.json ↔ chart image names ↔ Dockerfile build args;
// * platform-web CSP in nginx = platformCsp();
// * with HELM_BIN (CI job deploy-lint, or locally): helm lint + template for staging and prod, invariants of the
//   rendered manifests (internal port never behind an Ingress, hardening of every pod, default-deny, HSTS), and
//   kubeconform when KUBECONFORM_BIN is set.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  repoSandboxNetworkPolicy,
  repoSandboxPod,
} from "../../../apps/platform-api/src/repo-agent/pod-sandbox.js";
import { platformCsp, systemsFrameSrc } from "../../../apps/platform-web/src/csp.js";
import { sandboxNetworkPolicy, sandboxPod } from "../../../apps/runtime/src/index.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CHART = join(ROOT, "infra/helm/wizard");
const GENERATED = join(CHART, "generated/sandbox-networkpolicy.json");
const GENERATED_REPO = join(CHART, "generated/repo-sandbox-networkpolicy.json");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const values = read("infra/helm/wizard/values.yaml");
const num = (key: string) => Number(new RegExp(`\\n  ${key}: (\\d+)`).exec(values)?.[1]);

// biome-ignore lint/suspicious/noExplicitAny: rendered Kubernetes objects
type K8s = Record<string, any>;

function sandboxPolicyJson(): string {
  const np = sandboxNetworkPolicy({
    namespace: "{{ .Values.namespaces.sandbox }}",
    platformNamespace: "{{ .Values.namespaces.platform }}",
    runtimeSelector: { "wizard.ru/role": "runtime" },
    egressProxySelector: { "wizard.ru/role": "egress-proxy" },
    basePort: num("basePort"),
    systems: num("systems"),
    healthPort: num("healthPort"),
    rpcPort: num("internalPort"),
  });
  return `${JSON.stringify(np, null, 2)}\n`;
}

/** V3-32: the repository sandbox's policies, one YAML document each (JSON is YAML). */
function repoSandboxPolicyText(): string {
  const port = Number(/\negressProxy:\n(?: {2}.*\n)*? {2}port: (\d+)/.exec(values)?.[1]);
  const nps = repoSandboxNetworkPolicy({
    namespace: "{{ .Values.namespaces.sandbox }}",
    proxy: {
      namespace: "{{ .Values.namespaces.platform }}",
      selector: { "wizard.ru/role": "egress-proxy" },
      port,
    },
  });
  return `${nps.map((np) => JSON.stringify(np, null, 2)).join("\n---\n")}\n`;
}

/** A phase pod of the repository sandbox with test inputs. */
const repoPod = (phase: "install" | "build" | "test" | "agent", pool?: string): K8s =>
  repoSandboxPod({
    name: "p",
    namespace: "wizard-sandbox",
    workspace: "w",
    phase,
    argv: ["true"],
    timeoutMs: 1000,
    image: "i",
    pvc: "c",
    save: true,
    ...(pool ? { pool } : {}),
  }) as K8s;

describe("generated manifests", () => {
  it("sandbox NetworkPolicy = sandboxNetworkPolicy() with the chart's ports (RPC on the internal port)", () => {
    const want = sandboxPolicyJson();
    if (process.env.WIZARD_UPDATE_GENERATED === "1") writeFileSync(GENERATED, want);
    expect(readFileSync(GENERATED, "utf8")).toBe(want);
    expect(want).toContain(`"port": ${num("internalPort")}`);
  });

  it("V3-32: repository sandbox NetworkPolicies = repoSandboxNetworkPolicy() with the egress proxy's port", () => {
    const want = repoSandboxPolicyText();
    if (process.env.WIZARD_UPDATE_GENERATED === "1") writeFileSync(GENERATED_REPO, want);
    expect(readFileSync(GENERATED_REPO, "utf8")).toBe(want);
    expect(want).toContain('"port": 3128');
    // The pods' labels select exactly the policy of their phase's network.
    const policies = want.split("\n---\n").map((t) => JSON.parse(t) as K8s);
    for (const [phase, policy] of [
      ["install", "wizard-repo-sandbox-registry"],
      ["build", "wizard-repo-sandbox-none"],
      ["test", "wizard-repo-sandbox-none"],
      ["agent", "wizard-repo-sandbox-none"],
    ] as const) {
      const labels = repoPod(phase).metadata.labels;
      const hits = policies.filter((np) =>
        Object.entries(np.spec.podSelector.matchLabels).every(([k, v]) => labels[k] === v),
      );
      expect(hits.map((np) => np.metadata.name)).toEqual([policy]);
    }
  });

  it("sandbox pods tolerate exactly the taints the sandbox nodes get (k3s bootstrap, Cloud.ru pools)", () => {
    const pod = sandboxPod({
      name: "p",
      namespace: "wizard-sandbox",
      pool: "sandbox-free",
      image: "i",
      configMap: "c",
      basePort: 9000,
      systems: 1,
      healthPort: 8999,
    }) as K8s;
    const tol = pod.spec.tolerations[0];
    const label = Object.keys(pod.spec.nodeSelector)[0];
    // k3s agents (provider-neutral bootstrap): label <pool>, taint <key>=<pool>:NoSchedule, runsc handler.
    const agent = read("infra/k3s/agent.yaml.tftpl");
    expect(agent).toContain(`"${label}=\${pool}"`);
    expect(agent).toContain(`"${tol.key}=\${pool}:${tol.effect}"`);
    expect(agent).toContain("io.containerd.runsc.v1");
    expect(read("infra/k3s/server.yaml.tftpl")).toContain(`${label}=`);
    // Cloud.ru managed pools (alternative provider).
    const tf = read("infra/tofu/cloudru/modules/env/kubernetes.tf");
    expect(tf).toContain(`key    = "${tol.key}"`);
    expect(tf).toContain('effect = "EFFECT_NO_SCHEDULE"');
    expect(tf).toContain(`"${label}"`);
    // The single pilot node is labelled with the free pool (infra/tofu/timeweb/modules/env/main.tf sandbox_pool).
    expect(pod.spec.nodeSelector[label]).toBe("free");
    expect(read("infra/tofu/timeweb/modules/env/main.tf")).toContain('sandbox_pool  = "free"');
    expect(pod.spec.runtimeClassName).toBe("gvisor");
    expect(read("infra/helm/wizard/templates/sandbox.yaml")).toContain("name: gvisor");
    // V3-32: the repository sandbox's pods go to the same nodes (values repoSandbox.pool).
    const repo = repoPod("build", /\nrepoSandbox:\n(?: {2}.*\n)*? {2}pool: (\w+)/.exec(values)?.[1]);
    expect(repo.spec.runtimeClassName).toBe("gvisor");
    expect(repo.spec.nodeSelector).toEqual(pod.spec.nodeSelector);
    expect(repo.spec.tolerations).toEqual(pod.spec.tolerations);
  });
});

describe("images", () => {
  const images = JSON.parse(read("infra/docker/images.json")).images as {
    name: string;
    dockerfile: string;
    args: Record<string, string>;
  }[];

  it("the sandbox image pins the workerd version the CI sandbox job tests (M2-18)", () => {
    const v = /WORKERD_VERSION: "([^"]+)"/.exec(read(".github/workflows/sandbox.yml"))?.[1];
    expect(v).toBeTruthy();
    expect(read("infra/docker/sandbox.Dockerfile")).toContain(`ARG WORKERD_VERSION=${v}`);
  });

  it("every image is buildable from the repo and named in the chart", () => {
    for (const img of images) {
      expect(existsSync(join(ROOT, img.dockerfile)), img.dockerfile).toBe(true);
      expect(values).toContain(`: ${img.name}\n`);
      if (img.args.APP_DIR) {
        expect(existsSync(join(ROOT, img.args.APP_DIR, img.args.ENTRY ?? "")), img.name).toBe(true);
        const pkg = JSON.parse(read(join(img.args.APP_DIR, "package.json")));
        expect(pkg.name).toBe(img.args.FILTER);
        // tsx runs the sources: the app must bring it (resolved from the app folder in the image).
        expect(pkg.devDependencies?.tsx ?? pkg.dependencies?.tsx, img.name).toBeDefined();
      }
    }
    const named = [...values.matchAll(/^ {4}\w+: (wizard-[a-z0-9-]+)$/gm)].map((m) => m[1]);
    expect(named.sort()).toEqual(images.map((i) => i.name).sort());
  });

  it("Dockerfiles: non-root runtime stage, no secrets in the context", () => {
    for (const f of ["app.Dockerfile", "web.Dockerfile", "pgbouncer.Dockerfile", "repo-sandbox.Dockerfile"]) {
      const text = read(`infra/docker/${f}`);
      expect(text, f).toMatch(/^USER (?!0|root)\S+/m);
      expect(text, f).not.toMatch(/\.env\b(?!\.example)|SECRET|PASSWORD|API_KEY/);
    }
    const ignore = read(".dockerignore");
    for (const p of [".env", ".data", ".git", "**/node_modules"]) expect(ignore).toContain(p);
  });

  it("platform-web CSP in nginx equals platformCsp() for the systems domain", () => {
    const tpl = read("infra/docker/web/default.conf.template");
    const csps = [...tpl.matchAll(/Content-Security-Policy "([^"]+)"/g)].map((m) =>
      (m[1] as string).replace(/\$\{WIZARD_SYSTEMS_DOMAIN\}/, "sys.example"),
    );
    expect(csps.length).toBe(2);
    for (const c of csps) expect(c).toBe(platformCsp({ frameSrc: systemsFrameSrc("sys.example") }));
  });
});

const HELM = process.env.HELM_BIN;
const SETS = [
  "images.registry=registry.example/wizard",
  "images.tag=0123abc",
  "domains.platform=platform.example",
  "domains.systems=sys-example.ru",
  "tls.email=ops@platform.example",
  "pgbouncer.postgresHost=pg.internal",
  "network.postgresCidrs[0]=10.20.0.0/24",
  "network.kubeApiCidrs[0]=10.0.0.10/32",
  "postgres.backupsBucket=abc-wizard-backups",
];
// Pilot (founder decision 2026-10-01): Timeweb Cloud, ONE VM with k3s, self-managed PostgreSQL + WAL-G.
// Beta path: Timeweb Cloud, k3s on VMs, managed PostgreSQL. Alternative: Cloud.ru managed Kubernetes.
type Variant = {
  name: string;
  provider: string;
  files: readonly string[];
  envFiles?: Record<"staging" | "prod", string>;
};
const VARIANTS: readonly Variant[] = [
  {
    name: "timeweb+pilot",
    provider: "timeweb",
    files: ["../providers/timeweb.yaml", "../profiles/k3s.yaml", "../profiles/pilot.yaml"],
    envFiles: { staging: "../profiles/pilot-staging.yaml", prod: "../profiles/pilot-prod.yaml" },
  },
  { name: "timeweb+k3s", provider: "timeweb", files: ["../providers/timeweb.yaml", "../profiles/k3s.yaml"] },
  { name: "cloudru", provider: "cloudru", files: ["../providers/cloudru.yaml"] },
];

function yamlDocs(text: string): K8s[] {
  const r = spawnSync(
    "python3",
    ["-c", "import sys,json,yaml; print(json.dumps([d for d in yaml.safe_load_all(sys.stdin) if d]))"],
    { input: text, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

function helmArgs(
  cmd: "template" | "lint",
  v: Variant,
  env: "staging" | "prod",
  extra: readonly string[] = [],
): string[] {
  const args = cmd === "template" ? ["template", "wizard", CHART] : ["lint", CHART, "--strict"];
  const files = [...v.files, `values-${env}.yaml`, ...(v.envFiles ? [v.envFiles[env]] : [])];
  for (const f of files) args.push("-f", join(CHART, f));
  for (const s of SETS) args.push("--set", s);
  // `extra`: further helm flags after every layer (a later -f, --set), e.g. the local rehearsal values.
  args.push(...extra);
  return args;
}

function render(
  v: Variant,
  env: "staging" | "prod",
  extra: readonly string[] = [],
): { docs: K8s[]; text: string } {
  const r = spawnSync(HELM as string, helmArgs("template", v, env, extra), {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return { docs: yamlDocs(r.stdout), text: r.stdout };
}

describe("pilot switches (M2-15, platform/deploy.yaml#pilot.env)", () => {
  it("defaults keep registration open, payments on, cap 15000 (V3); the pilot profile sets invite, off, 15000", () => {
    expect(values).toMatch(/\n {2}registration: open\n {2}payments: "on"\n {2}llmMonthlyCapRub: 15000\n/);
    const pilot = read("infra/helm/profiles/pilot.yaml");
    expect(pilot).toMatch(
      /\nconfig:\n {2}registration: invite\n {2}payments: "off"\n {2}llmMonthlyCapRub: 15000\n/,
    );
    const helpers = read("infra/helm/wizard/templates/_helpers.tpl");
    for (const name of ["WIZARD_REGISTRATION", "WIZARD_PAYMENTS", "WIZARD_LLM_MONTHLY_CAP_RUB"])
      expect(helpers).toContain(`- name: ${name}\n`);
    const platform = read("infra/helm/wizard/templates/platform.yaml");
    expect(platform.match(/include "wizard\.alertEnv"/g)).toHaveLength(2);
  });

  it("M2-09: founder review on, /metrics of platform-api, worker and runtime scraped and open only to observability", () => {
    expect(values).toMatch(/\n {2}founderReview: "on"\n/);
    expect(values).toMatch(/\nmetrics:\n {2}port: 9464\n/);
    expect(read("infra/helm/profiles/pilot.yaml")).toMatch(/\n {2}founderReview: "on"\n/);
    const helpers = read("infra/helm/wizard/templates/_helpers.tpl");
    for (const name of [
      "WIZARD_FOUNDER_REVIEW",
      "WIZARD_METRICS_PORT",
      "WIZARD_METRICS_HOST",
      "WIZARD_OPS_ALERT_EMAIL",
    ])
      expect(helpers).toContain(`- name: ${name}\n`);
    expect(helpers).toContain('prometheus.io/scrape: "true"');
    const platform = read("infra/helm/wizard/templates/platform.yaml");
    const runtime = read("infra/helm/wizard/templates/runtime.yaml");
    expect(platform.match(/include "wizard\.metricsAnnotations"/g)).toHaveLength(2);
    expect(runtime.match(/include "wizard\.metricsAnnotations"/g)).toHaveLength(1);
    expect(platform.match(/name: metrics, containerPort: \{\{ \.Values\.metrics\.port \}\}/g)).toHaveLength(
      2,
    );
    expect(runtime).toContain("name: metrics, containerPort: {{ .Values.metrics.port }}");
    const np = read("infra/helm/wizard/templates/networkpolicies.yaml");
    // platform-api + worker (one range block) and runtime: the metrics port only from the observability namespace.
    expect(
      np.match(
        /observability \}\} \} \} \}\]\n {6}ports: \[\{ protocol: TCP, port: \{\{ \$?\.Values\.metrics\.port \}\} \}\]/g,
      ),
    ).toHaveLength(2);
  });
});

describe("provider neutrality", () => {
  it("the chart has no provider endpoints; providers only in providers/*.yaml and infra/tofu/<provider>", () => {
    const files = ["values.yaml", "values-staging.yaml", "values-prod.yaml"].map(
      (f) => `infra/helm/wizard/${f}`,
    );
    for (const f of readdirSync(join(CHART, "templates"))) files.push(`infra/helm/wizard/templates/${f}`);
    for (const f of files) expect(read(f), f).not.toMatch(/timeweb|twcstorage|cloud\.ru|cloudru/i);
    for (const p of ["timeweb", "cloudru"]) {
      expect(existsSync(join(ROOT, `infra/helm/providers/${p}.yaml`))).toBe(true);
      expect(existsSync(join(ROOT, `infra/tofu/${p}/provider.json`))).toBe(true);
    }
  });
});

describe.skipIf(!HELM)("helm chart (HELM_BIN)", () => {
  it("lints for every provider variant and environment", () => {
    for (const v of VARIANTS) {
      for (const env of ["staging", "prod"] as const) {
        const r = spawnSync(HELM as string, helmArgs("lint", v, env), { encoding: "utf8" });
        expect(r.status, `${v.name} ${env}: ${r.stdout}${r.stderr}`).toBe(0);
      }
    }
  });

  it("refuses to render without domains, registry or tag", () => {
    const r = spawnSync(
      HELM as string,
      ["template", "wizard", CHART, "-f", join(CHART, "values-prod.yaml")],
      {
        encoding: "utf8",
      },
    );
    expect(r.status).not.toBe(0);
  });

  for (const v of VARIANTS) {
    for (const env of ["staging", "prod"] as const) {
      describe(`${v.name} ${env}`, () => {
        const { docs, text } = HELM ? render(v, env) : { docs: [], text: "" };
        const of = (kind: string) => docs.filter((d) => d.kind === kind);
        const pods = of("Deployment").map((d) => ({
          name: d.metadata.name as string,
          spec: d.spec.template.spec,
        }));
        // Every pod template of the release: Deployments, StatefulSets and CronJobs (pilot database and its Jobs).
        const allPods = [
          ...pods,
          ...of("StatefulSet").map((d) => ({ name: d.metadata.name as string, spec: d.spec.template.spec })),
          ...of("CronJob").map((d) => ({
            name: d.metadata.name as string,
            spec: d.spec.jobTemplate.spec.template.spec,
          })),
        ];

        it("mail over the Unisender Go HTTP API: platform-api, worker (and the prod runtime) reach public 443", () => {
          // The pilot's server has the mail ports closed; platform mail leaves over 443 (email.yaml#transport).
          const public443 = (name: string) =>
            (of("NetworkPolicy").find((n) => n.metadata.name === name)?.spec.egress ?? []).some(
              (e: K8s) =>
                (e.to ?? []).some((t: K8s) => t.ipBlock?.cidr === "0.0.0.0/0") &&
                (e.ports ?? []).some((p: K8s) => p.port === 443),
            );
          expect(public443("wizard-platform-api")).toBe(true);
          expect(public443("wizard-worker")).toBe(true);
          if (env === "prod") expect(public443("wizard-runtime")).toBe(true);
        });

        it("the runtime internal port is never behind an Ingress (L3-19)", () => {
          const internal = of("Service").find((s) => s.metadata.name === "wizard-runtime-internal");
          expect(internal?.spec.type).toBe("ClusterIP");
          expect(internal?.spec.ports.map((p: K8s) => p.port)).toEqual([4101]);
          const backends = of("Ingress").flatMap((i) =>
            i.spec.rules.flatMap((r: K8s) => r.http.paths.map((p: K8s) => p.backend.service)),
          );
          expect(backends.length).toBeGreaterThan(0);
          for (const b of backends) {
            expect(b.name).not.toBe("wizard-runtime-internal");
            expect(b.port.name).not.toBe("internal");
          }
          const runtime = pods.find((p) => p.name === "wizard-runtime");
          const env0 = Object.fromEntries(
            runtime?.spec.containers[0].env.map((e: K8s) => [e.name, e.value]) ?? [],
          );
          expect(env0).toMatchObject({ WIZARD_RUNTIME_INTERNAL_PORT: "4101", WIZARD_PUBLIC_SCHEME: "https" });
          expect(env0.WIZARD_TRUSTED_PROXIES).toMatch(/^\d+\.\d+\.\d+\.\d+\/\d+$/);
          expect(env0.WIZARD_S3_ENDPOINT).toMatch(/^https:\/\//);
        });

        it("every pod is hardened (PodSecurity restricted) and has resources", () => {
          expect(pods.length).toBeGreaterThanOrEqual(7);
          for (const p of allPods) {
            expect(p.spec.securityContext.runAsNonRoot, p.name).toBe(true);
            expect(p.spec.securityContext.seccompProfile.type, p.name).toBe("RuntimeDefault");
            // The DNS-01 solver and, with the sandbox orchestrator (M2-18), the runtime talk to the API server.
            const sandboxOrchestrator =
              (p.name === "wizard-runtime" && p.spec.serviceAccountName === "wizard-runtime") ||
              (p.name === "wizard-worker" &&
                ["wizard-g1", "wizard-repo-agent"].includes(p.spec.serviceAccountName));
            if (p.name !== "wizard-acme-dns01" && !sandboxOrchestrator)
              expect(p.spec.automountServiceAccountToken, p.name).toBe(false);
            for (const c of [...p.spec.containers, ...(p.spec.initContainers ?? [])]) {
              expect(c.securityContext.readOnlyRootFilesystem, p.name).toBe(true);
              expect(c.securityContext.allowPrivilegeEscalation, p.name).toBe(false);
              expect(c.securityContext.capabilities.drop, p.name).toEqual(["ALL"]);
              expect(c.resources.limits.memory, p.name).toBeTruthy();
              expect(c.resources.requests.cpu, p.name).toBeTruthy();
              expect(c.image, p.name).toMatch(/^registry\.example\/wizard\/wizard-[a-z0-9-]+:0123abc$/);
            }
          }
        });

        it("default-deny NetworkPolicies; runtime/proxy egress never reaches metadata or the API server", () => {
          const nps = of("NetworkPolicy");
          for (const ns of ["wizard-platform", "wizard-sandbox"]) {
            const deny = nps.find((n) => n.metadata.name === "default-deny" && n.metadata.namespace === ns);
            expect(deny?.spec.policyTypes).toEqual(["Ingress", "Egress"]);
            expect(deny?.spec.podSelector).toEqual({});
          }
          for (const name of ["wizard-runtime", "wizard-egress-proxy"]) {
            const np = nps.find((n) => n.metadata.name === name);
            const blocks = np?.spec.egress.flatMap((e: K8s) =>
              (e.to ?? []).map((t: K8s) => t.ipBlock).filter(Boolean),
            );
            for (const b of blocks) {
              if (b.cidr !== "0.0.0.0/0") continue;
              for (const c of ["169.254.0.0/16", "10.0.0.0/8", "10.0.0.10/32", "100.64.0.0/10"]) {
                expect(b.except).toContain(c);
              }
            }
          }
          const runtime = nps.find((n) => n.metadata.name === "wizard-runtime");
          const open = runtime?.spec.egress.some((e: K8s) =>
            (e.to ?? []).some((t: K8s) => t.ipBlock?.cidr === "0.0.0.0/0"),
          );
          expect(open).toBe(env === "prod"); // only the temporary direct connector egress of prod
          const sandbox = nps.find((n) => n.metadata.name === "wizard-sandbox");
          expect(sandbox?.metadata.namespace).toBe("wizard-sandbox");
          expect(JSON.stringify(sandbox?.spec.egress)).toContain('"port":4101');
        });

        it("M3-02: the runtime reaches the AI gateway of platform-api on its port only", () => {
          const runtime = pods.find((p) => p.name === "wizard-runtime");
          const env0 = Object.fromEntries(
            runtime?.spec.containers[0].env.map((e: K8s) => [e.name, e.value]) ?? [],
          );
          expect(env0.WIZARD_PLATFORM_INTERNAL_URL).toBe(
            "http://wizard-platform-api.wizard-platform.svc:4000",
          );
          const nps = of("NetworkPolicy");
          const toApi = (n: K8s) =>
            n.spec.egress.filter((e: K8s) =>
              (e.to ?? []).some(
                (t: K8s) => t.podSelector?.matchLabels?.["wizard.ru/role"] === "platform-api",
              ),
            );
          const rt = nps.find((n) => n.metadata.name === "wizard-runtime");
          expect(toApi(rt).map((e: K8s) => e.ports)).toEqual([[{ protocol: "TCP", port: 4000 }]]);
          const api = nps.find((n) => n.metadata.name === "wizard-platform-api");
          const fromRuntime = api.spec.ingress.filter((i: K8s) =>
            (i.from ?? []).some((f: K8s) => f.podSelector?.matchLabels?.["wizard.ru/role"] === "runtime"),
          );
          expect(fromRuntime.map((i: K8s) => i.ports)).toEqual([[{ protocol: "TCP", port: 4000 }]]);
          // Nobody else from the platform namespace gets in: worker, sandbox and egress-proxy are not admitted.
          for (const role of ["worker", "egress-proxy", "pgbouncer"])
            expect(JSON.stringify(api.spec.ingress)).not.toContain(`"wizard.ru/role":"${role}"`);
        });

        it("platform-api and worker (only) reach the Traefik pods on websecure: the post-publish smoke goes through the DNATed ingress address", () => {
          // The smoke opens https://<slug>.<systems>; the domain resolves to the ingress LoadBalancer IP, which
          // kube-proxy DNATs in-cluster to the private IPs of the Traefik pods, so the 0.0.0.0/0-except-private rule
          // never matched and every publication rolled back with SMOKE_FAILED.
          expect(num("websecurePort")).toBe(8443);
          const nps = of("NetworkPolicy");
          const toTraefik = (n: K8s) =>
            (n.spec.egress ?? []).filter((e: K8s) =>
              (e.to ?? []).some(
                (t: K8s) => t.podSelector?.matchLabels?.["app.kubernetes.io/name"] === "traefik",
              ),
            );
          for (const name of ["wizard-platform-api", "wizard-worker"]) {
            const np = nps.find((n) => n.metadata.name === name);
            expect(np?.metadata.namespace, name).toBe("wizard-platform");
            // Exactly one rule: namespace AND pod selector in the same peer (not two peers = a union), one TCP port.
            expect(toTraefik(np as K8s), name).toEqual([
              {
                to: [
                  {
                    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "wizard-ingress" } },
                    podSelector: { matchLabels: { "app.kubernetes.io/name": "traefik" } },
                  },
                ],
                ports: [{ protocol: "TCP", port: 8443 }],
              },
            ]);
          }
          // Nobody else got the hop: not the runtime (its public egress goes via the egress proxy), not the sandbox,
          // proxy, web, PgBouncer or Postgres policies.
          for (const n of nps) {
            if (["wizard-platform-api", "wizard-worker"].includes(n.metadata.name)) continue;
            expect(toTraefik(n), n.metadata.name).toEqual([]);
            expect(JSON.stringify(n.spec.egress ?? []), n.metadata.name).not.toMatch(
              /traefik|wizard-ingress|"port":8443/,
            );
          }
          const runtime = nps.find((n) => n.metadata.name === "wizard-runtime");
          expect(runtime?.spec.egress.length).toBeGreaterThan(0);
        });

        it("every object of the release is unique by apiVersion, kind, namespace and name", () => {
          const seen = new Map<string, number>();
          for (const d of docs) {
            const id = `${d.apiVersion} ${d.kind} ${d.metadata?.namespace ?? "-"}/${d.metadata?.name}`;
            seen.set(id, (seen.get(id) ?? 0) + 1);
          }
          expect(seen.size).toBeGreaterThan(30);
          expect([...seen].filter(([, n]) => n > 1).map(([id]) => id)).toEqual([]);
        });

        it("extraCa is off by default: no CA volume, mount or NODE_EXTRA_CA_CERTS on the Node services", () => {
          // (the DNS-01 solver sets its own NODE_EXTRA_CA_CERTS to the service account CA: not ours)
          for (const p of allPods) {
            expect(
              (p.spec.volumes ?? []).filter((x: K8s) => x.name === "extra-ca"),
              p.name,
            ).toEqual([]);
            for (const c of p.spec.containers) {
              expect(
                (c.volumeMounts ?? []).filter((m: K8s) => m.name === "extra-ca"),
                p.name,
              ).toEqual([]);
              expect(
                (c.env ?? []).filter(
                  (e: K8s) => e.name === "NODE_EXTRA_CA_CERTS" && p.name !== "wizard-acme-dns01",
                ),
                p.name,
              ).toEqual([]);
            }
          }
          expect(text).not.toContain("/etc/wizard/extra-ca");
        });

        it("extraCa.configMap: platform-api, worker and runtime mount it read-only and trust it; nothing else does", () => {
          const out = render(v, env, ["--set", "extraCa.configMap=my-ca", "--set", "extraCa.key=bundle.pem"]);
          const deployments = out.docs.filter((d) => d.kind === "Deployment");
          const trusting = ["wizard-platform-api", "wizard-worker", "wizard-runtime"];
          for (const d of deployments) {
            const spec = d.spec.template.spec;
            const name = d.metadata.name as string;
            const vol = (spec.volumes ?? []).find((x: K8s) => x.name === "extra-ca");
            for (const c of spec.containers) {
              const mount = (c.volumeMounts ?? []).find((m: K8s) => m.name === "extra-ca");
              const envVar = (c.env ?? []).find((e: K8s) => e.name === "NODE_EXTRA_CA_CERTS");
              if (!trusting.includes(name)) {
                expect(vol, name).toBeUndefined();
                expect(mount, name).toBeUndefined();
                // (the DNS-01 solver's own NODE_EXTRA_CA_CERTS is the service account CA)
                expect(envVar?.value ?? "", name).not.toContain("/etc/wizard/extra-ca");
                continue;
              }
              expect(vol, name).toEqual({
                name: "extra-ca",
                configMap: { name: "my-ca", items: [{ key: "bundle.pem", path: "bundle.pem" }] },
              });
              expect(mount, name).toEqual({
                name: "extra-ca",
                mountPath: "/etc/wizard/extra-ca",
                readOnly: true,
              });
              expect(envVar, name).toEqual({
                name: "NODE_EXTRA_CA_CERTS",
                value: "/etc/wizard/extra-ca/bundle.pem",
              });
              // The hardening stays: read-only root, restricted pod, the data volume is still there.
              expect(c.securityContext.readOnlyRootFilesystem, name).toBe(true);
              expect(spec.securityContext.runAsNonRoot, name).toBe(true);
              expect(
                c.volumeMounts.map((m: K8s) => m.name),
                name,
              ).toEqual(expect.arrayContaining(["tmp", "data"]));
            }
          }
          expect(
            deployments.filter((d) => trusting.includes(d.metadata.name)).length,
            "all three Deployments exist",
          ).toBe(3);
          // Only those three containers get our file (not the egress proxy, PgBouncer, PostgreSQL, Jobs).
          expect(out.text.match(/value: "\/etc\/wizard\/extra-ca\/bundle\.pem"/g)).toHaveLength(3);
          expect(out.text.match(/mountPath: \/etc\/wizard\/extra-ca\r?$/gm)).toHaveLength(3);
        });

        it("the local rehearsal values trust wizard-local-ca (key ca.crt) in the three Node services", () => {
          const out = render(v, env, ["-f", join(ROOT, "infra/local/values-local.yaml")]);
          for (const name of ["wizard-platform-api", "wizard-worker", "wizard-runtime"]) {
            const spec = out.docs.find((d) => d.kind === "Deployment" && d.metadata.name === name)?.spec
              .template.spec;
            expect(spec.volumes.find((x: K8s) => x.name === "extra-ca").configMap, name).toEqual({
              name: "wizard-local-ca",
              items: [{ key: "ca.crt", path: "ca.crt" }],
            });
            expect(
              spec.containers[0].env.find((e: K8s) => e.name === "NODE_EXTRA_CA_CERTS").value,
              name,
            ).toBe("/etc/wizard/extra-ca/ca.crt");
          }
        });

        it("WIZARD_FIXTURE is set for the fixture and record LLM modes and only for them", () => {
          const fixtureOf = (mode: string) => {
            const out = render(v, env, [
              "--set",
              `config.llmMode=${mode}`,
              "--set",
              "config.fixture=demo/forum",
            ]);
            const dep = out.docs.find((d) => d.kind === "Deployment" && d.metadata.name === "wizard-worker");
            const e = dep?.spec.template.spec.containers[0].env;
            expect(e.find((x: K8s) => x.name === "WIZARD_LLM_MODE").value).toBe(mode);
            return e.find((x: K8s) => x.name === "WIZARD_FIXTURE")?.value;
          };
          expect(fixtureOf("fixture")).toBe("demo/forum");
          expect(fixtureOf("record")).toBe("demo/forum");
          expect(fixtureOf("live")).toBeUndefined();
        });

        it("HSTS with includeSubDomains everywhere; preload and ≥ 1 year on prod (L3-14)", () => {
          const mw = docs.find((d) => d.kind === "Middleware" && d.metadata.name === "wizard-hsts");
          expect(mw?.spec.headers.stsIncludeSubdomains).toBe(true);
          if (env === "prod") {
            expect(mw?.spec.headers.stsPreload).toBe(true);
            expect(mw?.spec.headers.stsSeconds).toBeGreaterThanOrEqual(31_536_000);
          }
          for (const ing of of("Ingress")) {
            expect(ing.metadata.annotations["traefik.ingress.kubernetes.io/router.middlewares"]).toContain(
              "wizard-hsts",
            );
          }
        });

        it("wildcard certificates through the provider's DNS-01 backend, renewed 30 days ahead", () => {
          const certs = of("Certificate").filter((c) => c.spec.issuerRef.kind === "ClusterIssuer");
          expect(certs.flatMap((c) => c.spec.dnsNames)).toEqual(
            expect.arrayContaining(["*.sys-example.ru", "sys-example.ru", "platform.example"]),
          );
          for (const c of certs) expect(c.spec.renewBefore).toBe("720h");
          const issuer = of("ClusterIssuer")[0];
          expect(issuer?.spec.acme.solvers[0].dns01.webhook).toMatchObject({
            groupName: "acme.wizard.ru",
            solverName: "dns01",
          });
          expect(issuer?.spec.acme.server).toContain(env === "prod" ? "acme-v02" : "acme-staging-v02");
          const solver = pods.find((p) => p.name === "wizard-acme-dns01");
          const senv = Object.fromEntries(
            solver?.spec.containers[0].env.map((e: K8s) => [e.name, e.value]) ?? [],
          );
          expect(senv.DNS_PROVIDER).toBe(v.provider);
          expect(solver?.spec.containers[0].envFrom).toEqual([{ secretRef: { name: "wizard-dns-solver" } }]);
        });

        if (v.name === "timeweb+k3s") {
          it("V3-32 without G1 orchestration: the worker alone gets wizard-repo-agent and its token; platform-api none", () => {
            const out = render(v, env, ["--set", "repoSandbox.enabled=true"]);
            const dep = (name: string) =>
              out.docs.find((d) => d.kind === "Deployment" && d.metadata.name === name)?.spec.template.spec;
            expect(dep("wizard-worker")).toMatchObject({
              serviceAccountName: "wizard-repo-agent",
              automountServiceAccountToken: true,
            });
            expect(dep("wizard-platform-api")).toMatchObject({
              serviceAccountName: "wizard-app",
              automountServiceAccountToken: false,
            });
            const sa = out.docs.find(
              (d) => d.kind === "ServiceAccount" && d.metadata.name === "wizard-repo-agent",
            );
            expect(sa?.automountServiceAccountToken).toBe(false);
            const binding = out.docs.find(
              (d) => d.kind === "RoleBinding" && d.metadata.name === "wizard-repo-sandbox",
            );
            expect(binding?.subjects).toEqual([
              { kind: "ServiceAccount", name: "wizard-repo-agent", namespace: "wizard-platform" },
            ]);
            const npOf = (name: string) =>
              JSON.stringify(
                out.docs.find((d) => d.kind === "NetworkPolicy" && d.metadata.name === name)?.spec.egress,
              );
            expect(npOf("wizard-worker")).toContain('"port":6443');
            expect(npOf("wizard-platform-api")).not.toContain('"port":6443');
          });

          it("k3s profile: local-path RWO data volume, gVisor RuntimeClass, k3s networks", () => {
            const pvc = of("PersistentVolumeClaim").find((d) => d.metadata.name === "wizard-data");
            expect(pvc?.spec).toMatchObject({
              accessModes: ["ReadWriteOnce"],
              storageClassName: "local-path",
            });
            const rc = of("RuntimeClass")[0];
            expect(rc).toMatchObject({ metadata: { name: "gvisor" }, handler: "runsc" });
            expect(text).toContain("10.42.0.0/16");
          });
        }

        if (v.name === "timeweb+pilot") {
          const env0 = (c: K8s) => Object.fromEntries((c.env ?? []).map((e: K8s) => [e.name, e.value]));
          const sts = of("StatefulSet").find((d) => d.metadata.name === "wizard-postgres");
          const cron = (name: string) => of("CronJob").find((d) => d.metadata.name === name);

          it("pilot: invite-only registration, payments off, LLM cap 15000 ₽ (V3) for platform-api and worker", () => {
            for (const name of ["wizard-platform-api", "wizard-worker"]) {
              const c = of("Deployment").find((d) => d.metadata.name === name)?.spec.template.spec
                .containers[0];
              expect(env0(c), name).toMatchObject({
                WIZARD_REGISTRATION: "invite",
                WIZARD_PAYMENTS: "off",
                WIZARD_LLM_MONTHLY_CAP_RUB: "15000",
              });
              expect(
                c.env.find((e: K8s) => e.name === "WIZARD_OPS_ALERT_URL")?.valueFrom.secretKeyRef,
              ).toMatchObject({
                key: "WIZARD_OPS_ALERT_URL",
                optional: true,
              });
            }
          });

          it("pilot: one replica of everything, images from GHCR with a pull secret, small sandbox quota", () => {
            for (const d of [...of("Deployment"), ...of("StatefulSet")]) {
              expect(d.spec.replicas, d.metadata.name).toBe(1);
              expect(d.spec.template.spec.imagePullSecrets, d.metadata.name).toEqual([
                { name: "wizard-ghcr" },
              ]);
            }
            expect(of("PodDisruptionBudget")).toEqual([]);
            // Sandbox pods of the orchestrator plus one replacement in flight (512Mi each).
            const quota = of("ResourceQuota")[0];
            // prod also has room for one phase pod of the repository sandbox (V3-32).
            expect(quota?.spec.hard.pods).toBe(env === "prod" ? "5" : "3");
            const rc = of("RuntimeClass")[0];
            expect(rc).toMatchObject({ metadata: { name: "gvisor" }, handler: "runsc" });
          });

          it("pilot (M2-18): the runtime orchestrates workerd pods with a Role on pods/ConfigMaps of the sandbox only", () => {
            const runtime = of("Deployment").find((d) => d.metadata.name === "wizard-runtime");
            const spec = runtime?.spec.template.spec;
            expect(spec.serviceAccountName).toBe("wizard-runtime");
            expect(spec.automountServiceAccountToken).toBe(true);
            const env0 = Object.fromEntries(
              spec.containers[0].env.map((e: K8s) => [e.name, e.value ?? e.valueFrom?.fieldRef?.fieldPath]),
            );
            expect(env0).toMatchObject({
              WIZARD_SANDBOX: "k8s",
              WIZARD_SANDBOX_NAMESPACE: "wizard-sandbox",
              WIZARD_SANDBOX_RPC_ADDRESS: "$(POD_IP):4101",
              POD_IP: "status.podIP",
              WIZARD_SANDBOX_MEMORY: "512Mi",
            });
            expect(env0.WIZARD_SANDBOX_IMAGE).toMatch(/\/wizard-sandbox:0123abc$/);
            const role = of("Role").find((r) => r.metadata.name === "wizard-runtime-sandbox");
            expect(role?.metadata.namespace).toBe("wizard-sandbox");
            expect(role?.rules).toEqual([
              {
                apiGroups: [""],
                resources: ["pods", "configmaps"],
                verbs: ["get", "list", "create", "delete"],
              },
            ]);
            const binding = of("RoleBinding").find((r) => r.metadata.name === "wizard-runtime-sandbox");
            expect(binding?.subjects).toEqual([
              { kind: "ServiceAccount", name: "wizard-runtime", namespace: "wizard-platform" },
              { kind: "ServiceAccount", name: "wizard-g1", namespace: "wizard-platform" },
            ]);
            // M2-19: the worker runs G1 in the sandbox — one pod, callbacks on its G1 RPC port only.
            const worker = of("Deployment").find((d) => d.metadata.name === "wizard-worker")?.spec.template
              .spec;
            expect(worker.serviceAccountName).toBe("wizard-g1");
            const wenv = Object.fromEntries(
              worker.containers[0].env.map((e: K8s) => [e.name, e.value ?? e.valueFrom?.fieldRef?.fieldPath]),
            );
            expect(wenv).toMatchObject({
              WIZARD_SANDBOX: "k8s",
              WIZARD_SANDBOX_RPC_ADDRESS: "$(POD_IP):4102",
              WIZARD_G1_RPC_PORT: "4102",
              WIZARD_SANDBOX_MAX_PODS: "1",
            });
            const g1np = of("NetworkPolicy").find((n) => n.metadata.name === "wizard-sandbox-g1");
            expect(g1np?.spec.podSelector.matchLabels["wizard.ru/sandbox-owner"]).toBe("g1");
            expect(g1np?.spec.egress).toEqual([
              {
                to: [
                  {
                    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "wizard-platform" } },
                    podSelector: { matchLabels: { "wizard.ru/role": "worker" } },
                  },
                ],
                ports: [{ protocol: "TCP", port: 4102 }],
              },
            ]);
            const wnp = of("NetworkPolicy").find((n) => n.metadata.name === "wizard-worker");
            expect(JSON.stringify(wnp?.spec.ingress)).toContain('"port":4102');
            // API server only on its ports and only on the node addresses (k3s).
            const np = of("NetworkPolicy").find((n) => n.metadata.name === "wizard-runtime");
            const api = np?.spec.egress.find((e: K8s) => (e.ports ?? []).some((p: K8s) => p.port === 6443));
            expect(api.ports).toEqual([
              { protocol: "TCP", port: 6443 },
              { protocol: "TCP", port: 443 },
            ]);
            expect(api.to.map((t: K8s) => t.ipBlock.cidr)).toEqual([expect.stringMatching(/\/\d+$/)]);
          });

          it("pilot (V3-32): the repository sandbox on prod only — run by the worker; platform-api holds no token", () => {
            const spec = (name: string) =>
              of("Deployment").find((d) => d.metadata.name === name)?.spec.template.spec;
            const api = spec("wizard-platform-api");
            const worker = spec("wizard-worker");
            const role = of("Role").find((r) => r.metadata.name === "wizard-repo-sandbox");
            const quota = of("ResourceQuota")[0];
            // The internet-facing API never gets a Kubernetes token, with or without the repository sandbox.
            expect(api.serviceAccountName).toBe("wizard-app");
            expect(api.automountServiceAccountToken).toBe(false);
            const bindings = of("RoleBinding").flatMap((b) => b.subjects ?? []);
            expect(bindings.map((x: K8s) => x.name)).not.toContain("wizard-app");
            const apiNp = of("NetworkPolicy").find((n) => n.metadata.name === "wizard-platform-api");
            expect(JSON.stringify(apiNp?.spec.egress)).not.toMatch(/"port":6443|wizard-repo-sandbox/);
            if (env === "staging") {
              // The 4 GB staging VM has no room for a phase pod: nothing of it is rendered.
              expect(role).toBeUndefined();
              expect(text).not.toContain("wizard-repo-sandbox");
              expect(quota?.spec.hard.persistentvolumeclaims).toBeUndefined();
              return;
            }
            // The worker runs the tasks: the declaration on the API, the runner's env on the worker.
            expect(env0(api.containers[0]).WIZARD_REPO_SANDBOX).toBe("pod");
            expect(env0(api.containers[0]).WIZARD_REPO_SANDBOX_IMAGE).toBeUndefined();
            const e = env0(worker.containers[0]);
            expect(e).toMatchObject({
              WIZARD_REPO_SANDBOX: "pod",
              WIZARD_REPO_SANDBOX_NAMESPACE: "wizard-sandbox",
              WIZARD_REPO_SANDBOX_PROXY: "http://wizard-egress-proxy.wizard-platform.svc:3128",
              WIZARD_REPO_SANDBOX_POOL: "free",
              WIZARD_REPO_SANDBOX_MEMORY: "1536Mi",
              WIZARD_REPO_SANDBOX_CPU: "2",
              WIZARD_REPO_SANDBOX_REGISTRY: "",
            });
            expect(e.WIZARD_REPO_SANDBOX_IMAGE).toMatch(/\/wizard-repo-sandbox:0123abc$/);
            // One identity per pod: on the pilot the worker already is wizard-g1 (G1 in sandbox pods, M2-19).
            expect(worker.serviceAccountName).toBe("wizard-g1");
            expect(worker.automountServiceAccountToken).toBe(true);
            // Minimal RBAC: no Secrets, no exec/attach/portforward, no update/patch, the sandbox namespace only.
            expect(role?.metadata.namespace).toBe("wizard-sandbox");
            expect(role?.rules).toEqual([
              { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "create", "delete"] },
              { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
              {
                apiGroups: [""],
                resources: ["configmaps", "persistentvolumeclaims"],
                verbs: ["list", "create", "delete"],
              },
            ]);
            expect(of("ClusterRole").map((r) => r.metadata.name)).not.toContain("wizard-repo-sandbox");
            const binding = of("RoleBinding").find((r) => r.metadata.name === "wizard-repo-sandbox");
            expect(binding?.metadata.namespace).toBe("wizard-sandbox");
            expect(binding?.subjects).toEqual([
              { kind: "ServiceAccount", name: "wizard-g1", namespace: "wizard-platform" },
            ]);
            // Its pods: install → only the egress proxy; the rest → nothing; no ingress.
            const nps = of("NetworkPolicy");
            const none = nps.find((n) => n.metadata.name === "wizard-repo-sandbox-none");
            const reg = nps.find((n) => n.metadata.name === "wizard-repo-sandbox-registry");
            expect(none?.metadata.namespace).toBe("wizard-sandbox");
            expect(none?.spec).toMatchObject({ policyTypes: ["Ingress", "Egress"], ingress: [], egress: [] });
            expect(reg?.spec.egress).toEqual([
              {
                to: [
                  {
                    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "wizard-platform" } },
                    podSelector: { matchLabels: { "wizard.ru/role": "egress-proxy" } },
                  },
                ],
                ports: [{ protocol: "TCP", port: 3128 }],
              },
            ]);
            // Both sides of the install's flow: the proxy admits exactly those pods.
            const proxy = nps.find((n) => n.metadata.name === "wizard-egress-proxy");
            expect(proxy?.spec.ingress[0].from).toContainEqual({
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "wizard-sandbox" } },
              podSelector: {
                matchLabels: {
                  "app.kubernetes.io/name": "wizard-repo-sandbox",
                  "wizard.ru/repo-sandbox-network": "registry",
                },
              },
            });
            // The worker reaches the API server (node addresses on k3s), the phase pods never.
            const wNp = nps.find((n) => n.metadata.name === "wizard-worker");
            const kubeApi = wNp?.spec.egress.find((x: K8s) =>
              (x.ports ?? []).some((p: K8s) => p.port === 6443),
            );
            expect(kubeApi?.ports).toEqual([
              { protocol: "TCP", port: 6443 },
              { protocol: "TCP", port: 443 },
            ]);
            expect(kubeApi?.to.map((t: K8s) => t.ipBlock.cidr)).toEqual([expect.stringMatching(/\/\d+$/)]);
            expect(JSON.stringify(wNp?.spec.egress)).not.toContain("wizard-repo-sandbox");
            // Quota: the workspaces' PVCs and storage; a phase pod fits the LimitRange.
            expect(quota?.spec.hard).toMatchObject({
              persistentvolumeclaims: "2",
              "requests.storage": "12Gi",
            });
            const lr = of("LimitRange")[0]?.spec.limits[0].max;
            const mib = (q: string) => Number(/^(\d+)/.exec(q)?.[1]) * (q.endsWith("Gi") ? 1024 : 1);
            expect(mib(e.WIZARD_REPO_SANDBOX_MEMORY as string)).toBeLessThanOrEqual(mib(lr.memory));
            expect(Number(e.WIZARD_REPO_SANDBOX_CPU)).toBeLessThanOrEqual(Number(lr.cpu));
          });

          it("pilot (M2-19): the worker reaches its own G1 sandbox pods on exactly the system ports (production defect)", () => {
            // Without this egress rule the default-deny of the platform namespace cut G1 off from its workerd pods.
            const worker = of("Deployment").find((d) => d.metadata.name === "wizard-worker");
            const wenv = env0(worker?.spec.template.spec.containers[0]);
            const systems = Number(wenv.WIZARD_SANDBOX_SYSTEMS_PER_POD);
            const base = Number(wenv.WIZARD_SANDBOX_BASE_PORT);
            const health = Number(wenv.WIZARD_SANDBOX_HEALTH_PORT);
            expect(base).toBe(num("basePort"));
            expect(systems).toBeGreaterThan(0);
            const systemPorts = Array.from({ length: systems }, (_, k) => ({
              protocol: "TCP",
              port: base + k,
            }));

            const wnp = of("NetworkPolicy").find(
              (n) => n.metadata.name === "wizard-worker" && n.metadata.namespace === "wizard-platform",
            );
            expect(wnp?.spec.policyTypes).toEqual(["Ingress", "Egress"]);
            const toSandbox = wnp?.spec.egress.filter((e: K8s) =>
              (e.to ?? []).some(
                (t: K8s) =>
                  t.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "wizard-sandbox",
              ),
            );
            expect(toSandbox).toEqual([
              {
                to: [
                  {
                    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "wizard-sandbox" } },
                    podSelector: {
                      matchLabels: {
                        "app.kubernetes.io/name": "wizard-sandbox",
                        "wizard.ru/sandbox-owner": "g1",
                      },
                    },
                  },
                ],
                ports: systemPorts,
              },
            ]);
            // The pods' own policy admits the same ports from the worker (both sides of the flow); the health port
            // belongs to the kubelet probes, which the orchestrator and the executors never call.
            const g1np = of("NetworkPolicy").find((n) => n.metadata.name === "wizard-sandbox-g1");
            expect(g1np?.spec.ingress).toEqual([
              {
                from: [
                  {
                    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "wizard-platform" } },
                    podSelector: { matchLabels: { "wizard.ru/role": "worker" } },
                  },
                ],
                ports: systemPorts,
              },
            ]);
            expect(JSON.stringify([toSandbox, g1np?.spec.ingress])).not.toContain(`"port":${health}`);
            // The runtime keeps reaching all pods (not only owner g1) on the system ports.
            const rnp = of("NetworkPolicy").find((n) => n.metadata.name === "wizard-runtime");
            expect(JSON.stringify(rnp?.spec.egress)).toContain(`"port":${base}`);
          });

          it("pilot: PostgreSQL 16 StatefulSet with WAL-G archiving every ≤ 60 s, encrypted, never overwriting", () => {
            const pg = sts?.spec.template.spec.containers.find((c: K8s) => c.name === "postgres");
            expect(pg.args).toEqual(
              expect.arrayContaining([
                "wal_level=replica",
                "archive_mode=on",
                "archive_command=wal-g wal-push %p",
                "archive_timeout=60",
              ]),
            );
            expect(env0(pg)).toMatchObject({
              WALG_S3_PREFIX: "s3://abc-wizard-backups/pg",
              AWS_ENDPOINT: "https://s3.twcstorage.ru",
              WALG_LIBSODIUM_KEY_TRANSFORM: "hex",
              WALG_PREVENT_WAL_OVERWRITE: "true",
              PGDATA: "/var/lib/postgresql/data/pgdata",
            });
            expect(pg.envFrom).toEqual([{ secretRef: { name: "wizard-postgres" } }]);
            expect(sts?.spec.template.spec.initContainers[0].command).toEqual([
              "node",
              "/opt/wizard/pg-ops.mjs",
              "bootstrap",
            ]);
            const ops = sts?.spec.template.spec.containers.find((c: K8s) => c.name === "pg-ops");
            expect(ops.command.at(-1)).toBe("monitor");
            expect(env0(ops)).toMatchObject({
              WIZARD_ARCHIVE_MAX_LAG_SEC: "300",
              WIZARD_DRILL_MAX_AGE_H: "192",
            });
            expect(sts?.spec.volumeClaimTemplates[0].spec).toMatchObject({
              accessModes: ["ReadWriteOnce"],
              storageClassName: "local-path",
            });
          });

          it("pilot: daily base backup (14 days), weekly restore drill of platform tables, Moscow time", () => {
            const bb = cron("wizard-pg-basebackup");
            expect(bb?.spec).toMatchObject({ schedule: "17 2 * * *", timeZone: "Europe/Moscow" });
            const bbc = bb?.spec.jobTemplate.spec.template.spec.containers[0];
            expect(env0(bbc)).toMatchObject({ WIZARD_BACKUP_RETENTION_DAYS: "14" });
            expect(bb?.spec.jobTemplate.spec.template.spec.volumes[0].persistentVolumeClaim).toEqual({
              claimName: "pgdata-wizard-postgres-0",
              readOnly: true,
            });
            const dr = cron("wizard-pg-restore-drill");
            expect(dr?.spec.schedule).toMatch(/^\d+ \d+ \* \* 0$/);
            const drc = dr?.spec.jobTemplate.spec.template.spec.containers[0];
            expect(drc.command.at(-1)).toBe("restore-drill");
            expect(env0(drc)).toMatchObject({ WIZARD_DRILL_SCHEMAS: "platform", WIZARD_DRILL_DIR: "/drill" });
            expect(cron("wizard-data-restore")?.spec.suspend).toBe(true);
            const sync = pods.find((p) => p.name === "wizard-data-backup");
            expect(env0(sync?.spec.containers[0])).toMatchObject({
              RCLONE_CONFIG_ENC_TYPE: "crypt",
              RCLONE_CONFIG_ENC_REMOTE: "s3:abc-wizard-backups/data",
            });
          });

          it("pilot: PgBouncer in front of the in-cluster server; NetworkPolicy by pod, not by CIDR", () => {
            const ini = of("ConfigMap").find((c) => c.metadata.name === "wizard-pgbouncer")?.data[
              "pgbouncer.ini"
            ];
            expect(ini).toContain(
              "wizard = host=wizard-postgres.wizard-platform.svc port=5432 dbname=wizard",
            );
            expect(ini).toContain("server_tls_sslmode = disable");
            expect(ini).not.toContain("server_tls_ca_file");
            const nps = of("NetworkPolicy");
            const bouncer = nps.find((n) => n.metadata.name === "wizard-pgbouncer");
            expect(JSON.stringify(bouncer?.spec.egress)).toContain('"wizard.ru/role":"postgres"');
            expect(JSON.stringify(bouncer?.spec.egress)).not.toContain("ipBlock");
            const pgnp = nps.find((n) => n.metadata.name === "wizard-postgres");
            const from = pgnp?.spec.ingress[0].from.map(
              (f: K8s) => f.podSelector.matchLabels["wizard.ru/role"],
            );
            expect(from).toEqual(["pgbouncer", "platform-api", "worker", "pg-job"]);
            for (const name of ["wizard-postgres", "wizard-pg-job", "wizard-data-backup"]) {
              const np = nps.find((n) => n.metadata.name === name);
              for (const e of np?.spec.egress ?? []) {
                for (const t of e.to ?? []) {
                  if (t.ipBlock)
                    expect(t.ipBlock.except, name).toEqual(
                      expect.arrayContaining(["10.0.0.0/8", "169.254.0.0/16"]),
                    );
                }
              }
            }
          });

          it("pilot: requests of the release fit the VM next to k3s and the addons", () => {
            const mib = (q: string) => {
              const m = /^(\d+(?:\.\d+)?)(Mi|Gi)?$/.exec(String(q));
              if (!m) throw new Error(`quantity ${q}`);
              return Number(m[1]) * (m[2] === "Gi" ? 1024 : m[2] === "Mi" ? 1 : 1 / 1048576);
            };
            let sum = 0;
            for (const p of [...pods, { spec: sts?.spec.template.spec }]) {
              for (const c of p.spec.containers) sum += mib(c.resources.requests.memory);
            }
            sum += mib(of("ResourceQuota")[0]?.spec.hard["requests.memory"]);
            // Allocatable ≈ RAM − 0.25 GiB; k3s system pods and the pilot addons request ≈ 0.6 GiB.
            const vmGiB = env === "prod" ? 8 : 4;
            expect(sum / 1024, `requests ${Math.round(sum)} MiB`).toBeLessThanOrEqual(vmGiB - 0.25 - 0.6);
          });
        }

        it.skipIf(!process.env.KUBECONFORM_BIN)(
          "kubeconform: built-in kinds are valid",
          () => {
            const r = spawnSync(
              process.env.KUBECONFORM_BIN as string,
              ["-strict", "-ignore-missing-schemas", "-summary", "-"],
              {
                input: text,
                encoding: "utf8",
              },
            );
            expect(r.status, r.stdout + r.stderr).toBe(0);
          },
          120_000,
        );
      });
    }
  }
});
