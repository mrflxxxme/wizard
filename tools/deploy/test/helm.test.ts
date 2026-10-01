// M2-06: the Helm chart and images stay consistent with the code they deploy.
// * the sandbox NetworkPolicy is generated from apps/runtime sandboxNetworkPolicy() (WIZARD_UPDATE_GENERATED=1 rewrites);
// * images.json ↔ chart image names ↔ Dockerfile build args;
// * platform-web CSP in nginx = platformCsp();
// * with HELM_BIN (CI job deploy-lint, or locally): helm lint + template for staging and prod, invariants of the
//   rendered manifests (internal port never behind an Ingress, hardening of every pod, default-deny, HSTS), and
//   kubeconform when KUBECONFORM_BIN is set.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { platformCsp, systemsFrameSrc } from "../../../apps/platform-web/src/csp.js";
import { sandboxNetworkPolicy, sandboxPod } from "../../../apps/runtime/src/index.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CHART = join(ROOT, "infra/helm/wizard");
const GENERATED = join(CHART, "generated/sandbox-networkpolicy.json");
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

describe("generated manifests", () => {
  it("sandbox NetworkPolicy = sandboxNetworkPolicy() with the chart's ports (RPC on the internal port)", () => {
    const want = sandboxPolicyJson();
    if (process.env.WIZARD_UPDATE_GENERATED === "1") writeFileSync(GENERATED, want);
    expect(readFileSync(GENERATED, "utf8")).toBe(want);
    expect(want).toContain(`"port": ${num("internalPort")}`);
  });

  it("sandbox pods tolerate exactly the taints the sandbox nodes get (k3s bootstrap, Cloud.ru pools)", () => {
    const pod = sandboxPod({
      name: "p",
      namespace: "wizard-sandbox",
      pool: "free",
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
    expect(pod.spec.runtimeClassName).toBe("gvisor");
    expect(read("infra/helm/wizard/templates/sandbox.yaml")).toContain("name: gvisor");
  });
});

describe("images", () => {
  const images = JSON.parse(read("infra/docker/images.json")).images as {
    name: string;
    dockerfile: string;
    args: Record<string, string>;
  }[];

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
    for (const f of ["app.Dockerfile", "web.Dockerfile", "pgbouncer.Dockerfile"]) {
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
];
// Beta path (founder decision): Timeweb Cloud, k3s on VMs. Alternative: Cloud.ru managed Kubernetes.
const VARIANTS = [
  { name: "timeweb+k3s", provider: "timeweb", files: ["../providers/timeweb.yaml", "../profiles/k3s.yaml"] },
  { name: "cloudru", provider: "cloudru", files: ["../providers/cloudru.yaml"] },
] as const;

function yamlDocs(text: string): K8s[] {
  const r = spawnSync(
    "python3",
    ["-c", "import sys,json,yaml; print(json.dumps([d for d in yaml.safe_load_all(sys.stdin) if d]))"],
    { input: text, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

function helmArgs(cmd: "template" | "lint", files: readonly string[], env: string): string[] {
  const args = cmd === "template" ? ["template", "wizard", CHART] : ["lint", CHART, "--strict"];
  for (const f of [...files, `values-${env}.yaml`]) args.push("-f", join(CHART, f));
  for (const s of SETS) args.push("--set", s);
  return args;
}

function render(files: readonly string[], env: "staging" | "prod"): { docs: K8s[]; text: string } {
  const r = spawnSync(HELM as string, helmArgs("template", files, env), {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return { docs: yamlDocs(r.stdout), text: r.stdout };
}

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
      for (const env of ["staging", "prod"]) {
        const r = spawnSync(HELM as string, helmArgs("lint", v.files, env), { encoding: "utf8" });
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
        const { docs, text } = HELM ? render(v.files, env) : { docs: [], text: "" };
        const of = (kind: string) => docs.filter((d) => d.kind === kind);
        const pods = of("Deployment").map((d) => ({
          name: d.metadata.name as string,
          spec: d.spec.template.spec,
        }));

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
          for (const p of pods) {
            expect(p.spec.securityContext.runAsNonRoot, p.name).toBe(true);
            expect(p.spec.securityContext.seccompProfile.type, p.name).toBe("RuntimeDefault");
            if (p.name !== "wizard-acme-dns01")
              expect(p.spec.automountServiceAccountToken, p.name).toBe(false);
            for (const c of p.spec.containers) {
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
