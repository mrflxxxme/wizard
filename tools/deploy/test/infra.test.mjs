// M2-06: `pnpm infra:apply --env staging|prod` and the PITR drill — planning, preflight and the control-row check.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  addonArgs,
  addonsFor,
  CLUSTER_SECRETS,
  certificateGate,
  certificateReport,
  clusterSecrets,
  createRunner,
  diagnoseCluster,
  gvisorProbe,
  imageNames,
  kubeconfigText,
  loadProvider,
  main,
  openTunnel,
  parseArgs,
  preflight,
  profileChain,
  registrySecret,
  releaseWizard,
  requiredEnv,
  smokeWithRetry,
  TUNNEL_PORT,
  tofuEnv,
  valueFiles,
  waitForImages,
  wizardReleaseArgs,
} from "../infra.mjs";
import { parseArgs as drillArgs, mark, psql, verify } from "../pitr-drill.mjs";

const STATE = {
  WIZARD_TF_STATE_BUCKET: "wizard-tfstate",
  WIZARD_TF_STATE_ACCESS_KEY_ID: "tenant:key",
  WIZARD_TF_STATE_SECRET_ACCESS_KEY: "s3-secret-value",
  WIZARD_TF_STATE_PASSPHRASE: "correct horse battery staple",
  WIZARD_TFVARS_FILE: "/runner/staging.tfvars",
  GITHUB_SHA: "abc1234",
};
const TIMEWEB = { ...STATE, TWC_TOKEN: "twc-very-secret-token", WIZARD_SSH_KEY_FILE: "/runner/id_ed25519" };
const CLOUDRU = {
  ...STATE,
  WIZARD_PROVIDER: "cloudru",
  CLOUDRU_PROJECT_ID: "proj-1",
  CLOUDRU_IAC_KEY_ID: "kid-123456",
  CLOUDRU_IAC_KEY_SECRET: "very-secret-value",
};
const yes = () => true;

describe("infra.mjs", () => {
  it("arguments: command, --env, provider and profile", () => {
    expect(parseArgs(["apply", "--env", "staging"], {})).toMatchObject({
      command: "apply",
      env: "staging",
      provider: "timeweb",
    });
    expect(parseArgs(["deploy", "--env=prod", "--yes", "--tag", "x", "--build-images"], {})).toMatchObject({
      yes: true,
      tag: "x",
      buildImages: true,
    });
    expect(parseArgs(["plan", "--env", "prod"], { WIZARD_PROVIDER: "cloudru" }).provider).toBe("cloudru");
    expect(() => parseArgs(["apply"], {})).toThrow(/--env/);
    expect(() => parseArgs(["pause", "--env", "staging"], {})).toThrow(/unknown command/);
    expect(() => loadProvider("nope")).toThrow(/no provider/);
  });

  it("each provider declares its credentials; the state settings are shared", () => {
    const tw = loadProvider("timeweb");
    expect(tw).toMatchObject({
      profile: "k3s",
      destroyable: ["staging"],
      helmValues: "infra/helm/providers/timeweb.yaml",
    });
    expect(requiredEnv(tw).map(([n]) => n)).toEqual([
      "TWC_TOKEN",
      "WIZARD_SSH_KEY_FILE",
      "WIZARD_TF_STATE_BUCKET",
      "WIZARD_TF_STATE_ACCESS_KEY_ID",
      "WIZARD_TF_STATE_SECRET_ACCESS_KEY",
      "WIZARD_TF_STATE_PASSPHRASE",
    ]);
    const cr = loadProvider("cloudru");
    expect(
      requiredEnv(cr)
        .map(([n]) => n)
        .slice(0, 3),
    ).toEqual(["CLOUDRU_PROJECT_ID", "CLOUDRU_IAC_KEY_ID", "CLOUDRU_IAC_KEY_SECRET"]);
    expect(tofuEnv(CLOUDRU, cr)).toMatchObject({
      TF_VAR_project_id: "proj-1",
      TF_VAR_iac_key_secret: "very-secret-value",
      TF_VAR_state_passphrase: "correct horse battery staple",
      AWS_ACCESS_KEY_ID: "tenant:key",
    });
    expect(tofuEnv(CLOUDRU, cr).TF_CLI_CONFIG_FILE).toMatch(/infra\/tofu\/cloudru\/tofurc$/);
    // Timeweb's provider reads TWC_TOKEN from the environment itself; no CLI config needed.
    expect(tofuEnv(TIMEWEB, tw).TF_CLI_CONFIG_FILE).toBeUndefined();
  });

  it("preflight names every missing credential, tool and the tfvars file", () => {
    const r = preflight(
      "staging",
      {},
      () => false,
      () => false,
    );
    expect(r.ok).toBe(false);
    expect(r.vars.map(([n]) => n)).toEqual(
      expect.arrayContaining(["TWC_TOKEN", "WIZARD_TF_STATE_PASSPHRASE"]),
    );
    expect(r.tools).toEqual(["tofu", "helm", "kubectl"]);
    expect(r.tfvars).toMatch(/infra\/tofu\/timeweb\/envs\/staging\/terraform\.tfvars$/);
    expect(preflight("staging", TIMEWEB, yes, yes).ok).toBe(true);
    expect(preflight("staging", { ...TIMEWEB, WIZARD_TF_STATE_PASSPHRASE: "short" }, yes, yes).ok).toBe(
      false,
    );
  });

  it("without access: --if-configured is a clean skip (exit 0), a real run stops with 2 and runs nothing", async () => {
    const lines = [];
    const ran = [];
    const deps = {
      log: (s) => lines.push(s),
      run: (c) => ran.push(c),
      has: () => false,
      exists: () => false,
    };
    expect(await main(["apply", "--env", "staging", "--if-configured"], {}, deps)).toBe(0);
    expect(lines.join("\n")).toMatch(/пропущено: нет доступов Timeweb Cloud/);
    expect(await main(["apply", "--env", "prod"], {}, deps)).toBe(2);
    expect(ran).toEqual([]);
  });

  it("k3s on VMs: tofu → kubeconfig over SSH → addons with the registry → images → release; no secrets printed", async () => {
    const lines = [];
    const deps = { log: (s) => lines.push(s), has: yes, exists: yes, skipSmoke: true };
    expect(await main(["apply", "--env", "staging", "--dry-run", "--build-images"], TIMEWEB, deps)).toBe(0);
    const text = lines.join("\n");
    const order = [
      "tofu -chdir=infra/tofu/timeweb/envs/staging init",
      "tofu -chdir=infra/tofu/timeweb/envs/staging apply",
      "output -json",
      "ssh -i /runner/id_ed25519",
      "root@192.168.10.10 cat /etc/rancher/k3s/k3s.yaml",
      "kubectl apply -f infra/k8s/namespaces.yaml",
      "helm upgrade --install cert-manager",
      "helm upgrade --install traefik",
      "helm upgrade --install registry",
      "helm upgrade --install metrics",
      "helm upgrade --install logs",
      "get secret wizard-platform-env",
      "node tools/deploy/images.mjs build --registry 192.168.10.10:30500 --tag abc1234 --push",
      "helm upgrade --install wizard infra/helm/wizard",
      "-f infra/helm/providers/timeweb.yaml -f infra/helm/profiles/k3s.yaml -f infra/helm/wizard/values-staging.yaml",
    ];
    let at = -1;
    for (const step of order) {
      const i = text.indexOf(step, at + 1);
      expect(i, step).toBeGreaterThan(at);
      at = i;
    }
    // The floating IP is known up front: no second apply for DNS.
    expect(text).not.toContain("-var=ingress_ip=");
    for (const secret of ["twc-very-secret-token", "s3-secret-value", "correct horse battery staple"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("a failed close of the temporary access is a warning, not a failed run (close-access step repeats it)", async () => {
    const lines = [];
    const hooks = {
      beforeCluster: async () => ({
        vars: {},
        close: async () => {
          throw new Error("fetch failed");
        },
      }),
    };
    const deps = { log: (s) => lines.push(s), has: yes, exists: yes, skipSmoke: true, hooks };
    expect(await main(["apply", "--env", "staging", "--dry-run"], TIMEWEB, deps)).toBe(0);
    expect(lines.join("\n")).toMatch(/::warning::доступ не закрыт: fetch failed/);
  });

  it("managed Kubernetes (Cloud.ru): kubeconfig from outputs, second apply for the LoadBalancer IP, no registry addon", async () => {
    const lines = [];
    const out = {
      env: {
        value: {
          registry_url: "wizard-staging.cr.cloud.ru",
          domains: { platform: "p.example", systems: "s.example" },
          network: { pods_cidr: "10.1.0.0/16", services_cidr: "10.96.0.0/12", nodes_cidr: "10.0.0.0/22" },
          postgres_cidr: "10.0.8.0/24",
        },
      },
      postgres: { value: { main: { connection_string: "postgres://u@pg.internal:5432/wizard" } } },
      kubeconfig: { value: "apiVersion: v1\n" },
    };
    const run = (cmd, args) => {
      lines.push(`$ ${cmd} ${args.join(" ")}`);
      if (cmd === "tofu" && args[1] === "output") return { status: 0, stdout: JSON.stringify(out) };
      if (cmd === "kubectl" && args.includes("jsonpath={.status.loadBalancer.ingress[0].ip}"))
        return { status: 0, stdout: "203.0.113.7" };
      return { status: 0, stdout: "" };
    };
    const deps = { log: (s) => lines.push(s), has: yes, exists: yes, skipSmoke: true, run };
    expect(await main(["apply", "--env", "staging", "--dry-run"], CLOUDRU, deps)).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("tofu -chdir=infra/tofu/cloudru/envs/staging apply");
    expect(text).toContain("-var=ingress_ip=203.0.113.7");
    expect(text).not.toContain("ssh ");
    expect(text).not.toContain("--install registry");
    expect(text).toContain("-f infra/helm/providers/cloudru.yaml -f infra/helm/wizard/values-staging.yaml");
  });

  it("staging is destroyed by one command; prod never", async () => {
    const lines = [];
    const deps = { log: (s) => lines.push(s), has: yes, exists: yes };
    expect(await main(["destroy", "--env", "staging", "--dry-run"], TIMEWEB, deps)).toBe(0);
    expect(lines.join("\n")).toContain(
      "tofu -chdir=infra/tofu/timeweb/envs/staging destroy -input=false -auto-approve",
    );
    const ran = [];
    const real = { ...deps, run: (c, a) => ran.push(`${c} ${a.join(" ")}`) };
    expect(await main(["destroy", "--env", "staging"], TIMEWEB, real)).toBe(2); // needs --yes
    expect(await main(["destroy", "--env", "prod", "--yes"], TIMEWEB, real)).toBe(2);
    expect(ran).toEqual([]);
  });

  it("CD to a destroyed staging is a no-op (no state → nothing to deploy)", async () => {
    const lines = [];
    const run = (cmd, args) =>
      cmd === "tofu" && args[1] === "output" ? { status: 0, stdout: "{}" } : { status: 0, stdout: "" };
    const deps = { log: (s) => lines.push(s), has: yes, exists: yes, run };
    expect(await main(["deploy", "--env", "staging"], TIMEWEB, deps)).toBe(0);
    expect(lines.join("\n")).toMatch(/staging не создан/);
    expect(await main(["deploy", "--env", "prod", "--yes"], TIMEWEB, deps)).toBe(3);
  });

  it("prod needs --yes outside dry runs (deploy-prod.yml passes it after the owner check)", async () => {
    const lines = [];
    const deps = {
      log: (s) => lines.push(s),
      has: yes,
      exists: yes,
      run: () => ({ status: 0, stdout: "{}" }),
    };
    expect(await main(["apply", "--env", "prod"], TIMEWEB, deps)).toBe(2);
    expect(lines.join("\n")).toMatch(/--yes/);
  });

  it("k3s kubeconfig: retried while cloud-init installs k3s, API address rewritten to the private IP", async () => {
    let calls = 0;
    const run = () => {
      calls++;
      return calls < 3
        ? { status: 255, stdout: "" }
        : { status: 0, stdout: "clusters:\n- cluster:\n    server: https://127.0.0.1:6443\n" };
    };
    const logs = [];
    const text = await kubeconfigText(
      { k3s_server: { value: { private_ip: "192.168.10.10" } } },
      {
        run,
        vars: { WIZARD_SSH_KEY_FILE: "/k" },
        log: (s) => logs.push(s),
        dryRun: true,
        kubeDir: "/tmp/x",
        sleep: async () => {},
      },
    );
    expect(text).toContain("server: https://192.168.10.10:6443");
    expect(calls).toBe(3);
    await expect(
      kubeconfigText(
        { k3s_server: { value: { private_ip: "192.168.10.10" } } },
        {
          run: () => ({ status: 255, stdout: "" }),
          vars: { WIZARD_SSH_KEY_FILE: "/k" },
          log: () => {},
          dryRun: true,
          kubeDir: "/tmp/x",
          sleep: async () => {},
          attempts: 2,
        },
      ),
    ).rejects.toThrow(/not ready/);
    await expect(
      kubeconfigText({}, { run, vars: {}, log: () => {}, dryRun: true, kubeDir: "/tmp/x" }),
    ).rejects.toThrow(/neither kubeconfig nor k3s_server/);
    // Staging in its own on-demand VPC: the runner reaches it on the public address.
    const pub = await kubeconfigText(
      { k3s_server: { value: { private_ip: "192.168.10.10", public_ip: "203.0.113.5" } } },
      {
        run: () => ({ status: 0, stdout: "server: https://127.0.0.1:6443\n" }),
        vars: { WIZARD_SSH_KEY_FILE: "/k", WIZARD_K3S_ACCESS: "public" },
        log: () => {},
        dryRun: true,
        kubeDir: "/tmp/x",
      },
    );
    expect(pub).toContain("server: https://203.0.113.5:6443");
    // Pilot from a GitHub-hosted runner: SSH to the public address, the API through the local tunnel end.
    const sshTo = [];
    const tun = await kubeconfigText(
      { k3s_server: { value: { private_ip: "192.168.10.10", public_ip: "203.0.113.5" } } },
      {
        run: (_cmd, args) => {
          sshTo.push(args.at(-2));
          return { status: 0, stdout: "server: https://127.0.0.1:6443\n" };
        },
        vars: { WIZARD_SSH_KEY_FILE: "/k", WIZARD_K3S_ACCESS: "tunnel" },
        log: () => {},
        dryRun: true,
        kubeDir: "/tmp/x",
      },
    );
    expect(tun).toContain(`server: https://127.0.0.1:${TUNNEL_PORT}`);
    expect(sshTo).toEqual(["root@203.0.113.5"]);
  });

  it("tunnel: a background control master with a forward to the API only, closed through its socket", () => {
    const calls = [];
    const close = openTunnel({
      run: (cmd, args, o) => calls.push({ cmd, args: args.join(" "), stdio: o.stdio }),
      vars: { WIZARD_SSH_KEY_FILE: "/k" },
      ip: "203.0.113.5",
      kubeDir: "/w",
    });
    expect(calls[0].args).toContain("-f -N -M -S /w/k3s-tunnel.sock -E /w/k3s-tunnel.log");
    expect(calls[0].args).toContain(`-L 127.0.0.1:${TUNNEL_PORT}:127.0.0.1:6443 root@203.0.113.5`);
    expect(calls[0].stdio).toBe("ignore");
    close();
    expect(calls[1].args).toBe("-S /w/k3s-tunnel.sock -O exit root@203.0.113.5");
  });

  it("smoke is retried while certificates are issued, then fails with the last reason", async () => {
    let n = 0;
    const ok = (status) => ({
      status,
      headers: { get: () => "max-age=63072000; includeSubDomains; preload" },
    });
    const f = async (url) => {
      n++;
      if (n <= 2) throw new TypeError("fetch failed");
      return ok(url.endsWith("/") ? 200 : url.endsWith("/api/v1/me") ? 401 : 404);
    };
    const logs = [];
    await smokeWithRetry(
      { platform: "p.ru", systems: "s.ru" },
      { log: (s) => logs.push(s), attempts: 5, sleep: async () => {}, f },
    );
    expect(logs.filter((l) => l.includes("повтор"))).toHaveLength(2);
    // onRetry runs between attempts and may stop the wait.
    await expect(
      smokeWithRetry(
        { platform: "p.ru", systems: "s.ru" },
        {
          log: () => {},
          attempts: 40,
          sleep: async () => {},
          f: async () => {
            throw new TypeError("fetch failed");
          },
          onRetry: (i) => {
            if (i === 3) throw new Error("stop");
          },
        },
      ),
    ).rejects.toThrow("stop");
    await expect(
      smokeWithRetry(
        { platform: "p.ru", systems: "s.ru" },
        {
          log: () => {},
          attempts: 2,
          sleep: async () => {},
          f: async () => {
            throw Object.assign(new TypeError("fetch failed"), {
              cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
            });
          },
        },
      ),
    ).rejects.toThrow(/smoke https:\/\/p\.ru\/: fetch failed \(CERT_HAS_EXPIRED certificate has expired\)/);
  });

  it("the release takes registry, domains, networks, S3 and the PG host from tofu outputs", () => {
    const out = {
      env: {
        registry_url: "registry.wizard.local",
        domains: { platform: "codename.ru", systems: "neutral.ru" },
        network: { pods_cidr: "10.42.0.0/16", services_cidr: "10.43.0.0/16", nodes_cidr: "192.168.10.0/24" },
        postgres_cidr: "192.168.10.0/24",
        s3_endpoint: "https://s3.twcstorage.ru",
      },
      postgres: {
        main: { connection_string: "postgres://wizard:pw@192.168.10.4:5432/wizard?sslmode=require" },
      },
    };
    const args = wizardReleaseArgs({
      env: "prod",
      out,
      tag: "abc",
      email: "ops@codename.ru",
      profile: "k3s",
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "--wait",
        "infra/helm/wizard/values-prod.yaml",
        "infra/helm/profiles/k3s.yaml",
      ]),
    );
    expect(args).toContain("pgbouncer.postgresHost=192.168.10.4");
    expect(args).toContain("config.s3Endpoint=https://s3.twcstorage.ru");
    expect(args).toContain("domains.systems=neutral.ru");
    expect(() =>
      wizardReleaseArgs({ env: "prod", out: { ...out, postgres: {} }, tag: "abc", email: "x" }),
    ).toThrow(/postgresHost/);
    expect(
      addonArgs({ name: "x", chart: "c", repo: "https://r", version: "1", namespace: "n", values: "v" }),
    ).toEqual(expect.arrayContaining(["--version", "1", "--create-namespace"]));
    expect(addonsFor("k3s").map((a) => a.name)).toEqual([
      "cert-manager",
      "traefik",
      "registry",
      "metrics",
      "logs",
    ]);
    expect(addonsFor(null).map((a) => a.name)).not.toContain("registry");
    expect(CLUSTER_SECRETS.map((s) => s.name)).toEqual([
      "wizard-platform-env",
      "wizard-pgbouncer",
      "wizard-dns-solver",
    ]);
  });
});

describe("infra.mjs: pilot profile (one VM, PostgreSQL + WAL-G in the cluster, images from GHCR)", () => {
  const PILOT_OUT = {
    env: {
      value: {
        registry_url: "ghcr.io/owner",
        registry_push: null,
        ingress_ip: "203.0.113.10",
        domains: { platform: "codename.ru", systems: "neutral.ru" },
        network: { pods_cidr: "10.42.0.0/16", services_cidr: "10.43.0.0/16", nodes_cidr: "192.168.10.0/24" },
        postgres_cidr: null,
        postgres_mode: "in-cluster",
        cluster_profile: "pilot",
        s3_endpoint: "https://s3.twcstorage.ru",
        buckets: { files: "abc-wizard-prod-files", backups: "abc-wizard-prod-backups" },
      },
    },
    postgres: { value: { main: { in_cluster: true } } },
    k3s_server: { value: { private_ip: "192.168.10.10", public_ip: "203.0.113.10" } },
  };

  it("pilot = k3s + pilot: values layered base first, then the environment and pilot-<env>", () => {
    expect(profileChain("pilot")).toEqual(["k3s", "pilot"]);
    expect(profileChain(null)).toEqual([]);
    expect(valueFiles("prod", loadProvider("timeweb"), "pilot")).toEqual([
      "infra/helm/wizard/values.yaml",
      "infra/helm/providers/timeweb.yaml",
      "infra/helm/profiles/k3s.yaml",
      "infra/helm/profiles/pilot.yaml",
      "infra/helm/wizard/values-prod.yaml",
      "infra/helm/profiles/pilot-prod.yaml",
    ]);
    expect(valueFiles("staging", loadProvider("timeweb"), "k3s")).toEqual([
      "infra/helm/wizard/values.yaml",
      "infra/helm/providers/timeweb.yaml",
      "infra/helm/profiles/k3s.yaml",
      "infra/helm/wizard/values-staging.yaml",
    ]);
  });

  it("pilot addons: no in-cluster registry, vlagent instead of vector, small overlays", () => {
    expect(addonsFor("pilot").map((a) => a.name)).toEqual([
      "cert-manager",
      "traefik",
      "metrics",
      "logs",
      "logs-collector",
    ]);
    const cm = addonsFor("pilot")[0];
    expect(addonArgs(cm, "pilot").join(" ")).toContain(
      "-f infra/helm/addons/cert-manager-values.yaml -f infra/helm/addons/pilot/cert-manager.yaml",
    );
    expect(addonArgs(cm, "k3s").join(" ")).not.toContain("addons/pilot/");
  });

  it("one command: the profile comes from the tofu output; database secrets and the GHCR pull secret; no image build", async () => {
    const lines = [];
    const inputs = [];
    const run = (cmd, args, o = {}) => {
      lines.push(`$ ${cmd} ${args.join(" ")}`);
      if (o.input) inputs.push(o.input);
      if (cmd === "tofu" && args[1] === "output") return { status: 0, stdout: JSON.stringify(PILOT_OUT) };
      if (cmd === "ssh") return { status: 0, stdout: "server: https://127.0.0.1:6443\n" };
      return { status: 0, stdout: "" };
    };
    const vars = {
      ...TIMEWEB,
      WIZARD_POSTGRES_ENV_FILE: "/etc/wizard/postgres-prod.env",
      WIZARD_GHCR_USER: "owner",
      WIZARD_GHCR_TOKEN: "ghp_secret_read_packages",
    };
    const deps = {
      log: (s) => lines.push(s),
      has: yes,
      exists: yes,
      skipSmoke: true,
      skipImageWait: true,
      run,
    };
    expect(
      await main(["apply", "--env", "prod", "--yes", "--build-images", "--tag", "abc1234"], vars, deps),
    ).toBe(0);
    const text = lines.join("\n");
    expect(text).not.toContain("--install registry");
    expect(text).toContain("helm upgrade --install logs-collector");
    expect(text).toContain("-f infra/helm/addons/pilot/traefik.yaml");
    expect(text).toContain("--from-env-file=/etc/wizard/postgres-prod.env");
    expect(text).not.toContain("images.mjs build");
    expect(text).toContain(
      "-f infra/helm/profiles/k3s.yaml -f infra/helm/profiles/pilot.yaml -f infra/helm/wizard/values-prod.yaml -f infra/helm/profiles/pilot-prod.yaml",
    );
    expect(text).toContain("postgres.backupsBucket=abc-wizard-prod-backups");
    expect(text).toContain("images.registry=ghcr.io/owner");
    expect(text).not.toContain("pgbouncer.postgresHost");
    expect(text).not.toContain("ghp_secret_read_packages");
    // The pull secret goes through stdin as a dockerconfigjson Secret.
    const pull = inputs.map((i) => JSON.parse(i)).find((x) => x.metadata?.name === "wizard-ghcr");
    expect(pull.type).toBe("kubernetes.io/dockerconfigjson");
    const cfg = JSON.parse(Buffer.from(pull.data[".dockerconfigjson"], "base64").toString());
    expect(cfg.auths["ghcr.io"]).toMatchObject({ username: "owner", password: "ghp_secret_read_packages" });
    expect(clusterSecrets("pilot").map((x) => x.name)).toEqual([
      ...CLUSTER_SECRETS.map((x) => x.name),
      "wizard-postgres",
      "wizard-ghcr",
    ]);
    expect(clusterSecrets("k3s")).toBe(CLUSTER_SECRETS);
    expect(JSON.parse(registrySecret("ns", "n", "ghcr.io", "u", "t")).metadata).toEqual({
      name: "n",
      namespace: "ns",
    });
  });

  it("public packages: the pull secret carries no credentials (a job token would expire with the job)", () => {
    const anon = JSON.parse(registrySecret("ns", "n", "ghcr.io"));
    expect(JSON.parse(Buffer.from(anon.data[".dockerconfigjson"], "base64").toString())).toEqual({
      auths: {},
    });
  });

  it("a missing database secret stops the pilot release before Helm", async () => {
    const lines = [];
    const run = (cmd, args) => {
      lines.push(`$ ${cmd} ${args.join(" ")}`);
      if (cmd === "tofu" && args[1] === "output") return { status: 0, stdout: JSON.stringify(PILOT_OUT) };
      if (cmd === "kubectl" && args.includes("wizard-postgres") && args.includes("get"))
        return { status: 1, stdout: "" };
      return { status: 0, stdout: "server: https://127.0.0.1:6443\n" };
    };
    const deps = { log: (s) => lines.push(s), has: yes, exists: yes, skipSmoke: true, run };
    expect(await main(["deploy", "--env", "prod", "--yes", "--tag", "abc"], TIMEWEB, deps)).toBe(3);
    expect(lines.join("\n")).toContain("Нет секрета wizard-platform/wizard-postgres");
    expect(lines.join("\n")).not.toContain("upgrade --install wizard");
  });

  it("the release waits for every image of the tag in GHCR (pull token from read:packages)", async () => {
    const calls = [];
    let missing = 1;
    const f = async (url, init) => {
      calls.push(`${init.method ?? "GET"} ${url} ${init.headers.authorization.split(" ")[0]}`);
      if (url.includes("/token?")) return { ok: true, json: async () => ({ token: "pull" }) };
      if (url.endsWith("/wizard-worker/manifests/abc") && missing-- > 0) return { status: 404 };
      return { status: 200 };
    };
    const logs = [];
    await waitForImages({
      registry: "ghcr.io/owner",
      names: ["wizard-runtime", "wizard-worker"],
      tag: "abc",
      user: "owner",
      token: "t",
      f,
      log: (s) => logs.push(s),
      sleep: async () => {},
    });
    expect(calls).toEqual([
      "GET https://ghcr.io/token?service=ghcr.io&scope=repository:owner/wizard-runtime:pull Basic",
      "HEAD https://ghcr.io/v2/owner/wizard-runtime/manifests/abc Bearer",
      "GET https://ghcr.io/token?service=ghcr.io&scope=repository:owner/wizard-worker:pull Basic",
      "HEAD https://ghcr.io/v2/owner/wizard-worker/manifests/abc Bearer",
      "GET https://ghcr.io/token?service=ghcr.io&scope=repository:owner/wizard-worker:pull Basic",
      "HEAD https://ghcr.io/v2/owner/wizard-worker/manifests/abc Bearer",
    ]);
    expect(logs).toHaveLength(1);
    await expect(
      waitForImages({
        registry: "ghcr.io/owner",
        names: ["x"],
        tag: "abc",
        user: "u",
        token: "t",
        f: async (url) => (url.includes("/token?") ? { ok: false } : { status: 401 }),
        sleep: async () => {},
        attempts: 2,
      }),
    ).rejects.toThrow(/not in the registry \(401\)/);
    expect(imageNames()).toContain("wizard-postgres");
  });
});

const DB = process.env.WIZARD_DB_URL ?? "postgres://wizard@localhost:5433/wizard";
const hasPsql = spawnSync("psql", ["--version"]).status === 0;

describe.skipIf(!hasPsql)("pitr-drill.mjs (control rows)", () => {
  const schema = `wz_ops_test_${randomBytes(4).toString("hex")}`;
  afterAll(() => {
    psql(DB, `DROP SCHEMA IF EXISTS ${schema} CASCADE;`);
  });

  it("rows written before T are present after restore, rows after T are absent", () => {
    const before = mark(DB, "before T; it's quoted", schema);
    const after = mark(DB, "after T", schema);
    expect(before.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(after.at)).toBeGreaterThanOrEqual(Date.parse(before.at));
    // Same database plays the restored one: both exist, so "absent" fails — as it would for a wrong PITR point.
    expect(verify(DB, [before.id], [], schema)).toEqual({ ok: true, missing: [], leaked: [] });
    expect(verify(DB, [before.id], [after.id], schema)).toEqual({
      ok: false,
      missing: [],
      leaked: [after.id],
    });
    psql(DB, `DELETE FROM ${schema}.drill_markers WHERE id = :'id';`, { id: after.id });
    expect(verify(DB, [before.id], [after.id], schema).ok).toBe(true);
    const ghost = "00000000-0000-4000-8000-000000000000";
    expect(verify(DB, [ghost], [], schema)).toMatchObject({ ok: false, missing: [ghost] });
  });

  it("arguments: marker ids must be UUIDs, schema names are identifiers", () => {
    expect(() => drillArgs(["verify", "--present", "1;drop"])).toThrow(/marker id/);
    expect(() => drillArgs(["mark", "--schema", "x;y"])).toThrow(/schema/);
    expect(drillArgs(["restore", "--at", "Thu, 01 Oct 2026 11:00:00 UTC"]).at).toBe(
      "Thu, 01 Oct 2026 11:00:00 UTC",
    );
  });
});

describe("createRunner", () => {
  it("feeds o.input to stdin also without capture (`kubectl apply -f -`)", () => {
    const run = createRunner({ log: () => {} });
    expect(run("sh", ["-c", 'test "$(cat)" = hello'], { input: "hello", allowFail: true }).status).toBe(0);
    expect(run("sh", ["-c", "cat"], { input: "x", capture: true }).stdout).toBe("x");
  });
});

describe("wizardReleaseArgs: first bring-up", () => {
  it("postgres.firstBoot only for an in-cluster database on the first release", () => {
    const out = {
      env: {
        registry_url: "ghcr.io/o",
        domains: { platform: "p.ru", systems: "s.ru" },
        network: { pods_cidr: "10.42.0.0/16", services_cidr: "10.43.0.0/16", nodes_cidr: "1.2.3.4/32" },
        postgres_mode: "in-cluster",
        buckets: { backups: "b" },
        s3_endpoint: "https://s3",
      },
    };
    const base = { env: "prod", out, tag: "t", email: "a@p.ru", profile: "pilot" };
    expect(wizardReleaseArgs({ ...base, firstBoot: true })).toContain("postgres.firstBoot=true");
    expect(wizardReleaseArgs(base)).not.toContain("postgres.firstBoot=true");
  });
});

describe("releaseWizard", () => {
  const fake = (history, failRelease) => {
    const calls = [];
    const helm = (args) => {
      calls.push(["helm", ...args]);
      if (args[0] === "history") return { status: 0, stdout: JSON.stringify(history) };
      if (args[0] === "upgrade" && failRelease) throw new Error("helm upgrade failed with 1");
      return { status: 0, stdout: "" };
    };
    const kubectl = (args) => {
      calls.push(["kubectl", ...args]);
      if (args.includes("json"))
        return {
          status: 0,
          stdout: JSON.stringify({
            items: [
              {
                metadata: { name: "api-1" },
                spec: { containers: [{ name: "api", image: "ghcr.io/o/wizard-platform-api:t" }] },
                status: {
                  phase: "Pending",
                  conditions: [{ type: "Ready", status: "False" }],
                  initContainerStatuses: [{ name: "bootstrap", state: { running: {} }, restartCount: 0 }],
                  containerStatuses: [{ name: "api", state: { waiting: {} }, restartCount: 0 }],
                },
              },
              {
                metadata: { name: "web-1" },
                status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
              },
            ],
          }),
        };
      return { status: 0, stdout: "" };
    };
    return { calls, helm, kubectl };
  };
  const args = ["upgrade", "--install", "wizard", "infra/helm/wizard", "--wait"];

  it("a ready release: no diagnostics, no rollback", () => {
    const f = fake([], false);
    releaseWizard({ ...f, args, log: () => {} });
    expect(f.calls.map((c) => c[1])).toEqual(["history", "upgrade"]);
  });
  it("first install not ready: diagnostics of the pods that are not ready, then uninstall", () => {
    const f = fake([], true);
    expect(() => releaseWizard({ ...f, args, log: () => {} })).toThrow(/helm upgrade failed/);
    const flat = f.calls.map((c) => c.join(" "));
    expect(flat).toContain("kubectl -n wizard-platform describe pod api-1");
    expect(flat.some((c) => c.includes("describe pod web-1"))).toBe(false);
    // logs container by container (the init one runs, the waiting main one has none), then a probe from inside
    expect(flat).toContain("kubectl -n wizard-platform logs api-1 -c bootstrap --tail=80");
    expect(flat.some((c) => c.includes("logs api-1 -c api"))).toBe(false);
    expect(
      flat.some((c) => c.startsWith("kubectl -n wizard-platform exec api-1 -c bootstrap -- node -e")),
    ).toBe(true);
    // probe pods: with the egress rules of PostgreSQL, and without any NetworkPolicy
    expect(flat).toContain("kubectl -n wizard-platform logs wizard-net-probe");
    expect(flat).toContain("kubectl -n default logs wizard-net-probe");
    expect(flat.at(-1)).toMatch(/^helm uninstall wizard/);
  });
  it("an upgrade not ready: back to the last deployed revision", () => {
    const f = fake(
      [
        { revision: 3, status: "deployed" },
        { revision: 4, status: "failed" },
      ],
      true,
    );
    expect(() => releaseWizard({ ...f, args, log: () => {} })).toThrow();
    expect(f.calls.at(-1).slice(0, 4)).toEqual(["helm", "rollback", "wizard", "3"]);
  });
});

describe("diagnoseCluster", () => {
  it("reads the cluster; the only things it creates are one-shot probe pods, removed again", () => {
    const calls = [];
    const inputs = [];
    const sql = [];
    const sts = {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "postgres",
                image: "ghcr.io/o/wizard-postgres:t",
                env: [
                  { name: "WALG_S3_PREFIX", value: "s3://wizard-prod-backups/pg" },
                  { name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: "x", key: "y" } } },
                ],
                envFrom: [{ secretRef: { name: "wizard-postgres" } }],
              },
            ],
          },
        },
      },
    };
    const kubectl = (args, o = {}) => {
      calls.push(args.join(" "));
      if (o.input?.trimStart().startsWith("{")) inputs.push(JSON.parse(o.input));
      else if (o.input) sql.push(o.input);
      return args.includes("statefulset")
        ? { status: 0, stdout: JSON.stringify(sts) }
        : { status: 0, stdout: "" };
    };
    diagnoseCluster({ kubectl, log: () => {} });
    expect(calls).toContain("get certificates,certificaterequests,orders,challenges -A -o wide");
    expect(calls).toContain("-n cert-manager logs deploy/wizard-acme-dns01 --tail=120");
    const writes = calls.filter((c) => /\b(apply|delete|create|patch|edit|scale|rollout)\b/.test(c));
    expect(writes.every((c) => c === "apply -f -" || /delete pod wizard-(net|walg)-probe/.test(c))).toBe(
      true,
    );
    expect(inputs.map((m) => m.metadata.name)).toEqual(["wizard-net-probe", "wizard-walg-probe"]);
    const [net, walg] = inputs.map((m) => m.spec.containers[0]);
    expect(net.env).toEqual([{ name: "PROBE_BUCKET", value: "wizard-prod-backups" }]);
    expect(walg.command).toEqual(["timeout", "45", "wal-g", "backup-list"]);
    // plain values and the database Secret as is; secretKeyRef entries are not copied
    expect(walg.env.map((e) => e.name)).toEqual([
      "WALG_S3_PREFIX",
      "WALG_LOG_LEVEL",
      "S3_LOG_LEVEL",
      "GODEBUG",
    ]);
    expect(walg.envFrom).toEqual([{ secretRef: { name: "wizard-postgres" } }]);
    expect(inputs[1].spec.securityContext.runAsUser).toBe(999);
    // Model calls: a read-only aggregate of platform.llm_calls (codes and counts) and a probe from the worker pod.
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/^select provider, model_id/);
    expect(sql[0]).not.toMatch(/\b(insert|update|delete|drop|alter)\b/i);
    expect(
      calls.filter((c) => c.startsWith("-n wizard-platform exec deploy/wizard-worker -- node -e")),
    ).toHaveLength(2);
    expect(calls.some((c) => c.startsWith("-n wizard-platform exec deploy/wizard-worker -- node -e"))).toBe(
      true,
    );
  });
});

describe("certificates during the smoke (certificateReport, certificateGate)", () => {
  const items = (challengeState, reason = "") => ({
    items: [
      {
        kind: "Certificate",
        metadata: { namespace: "wizard-platform", name: "platform" },
        status: {
          conditions: [{ type: "Ready", status: "False", reason: "DoesNotExist", message: "Issuing" }],
        },
      },
      {
        kind: "Order",
        metadata: { namespace: "wizard-platform", name: "platform-1" },
        status: { state: challengeState === "pending" ? "pending" : challengeState },
      },
      {
        kind: "Challenge",
        metadata: { namespace: "wizard-platform", name: "platform-1-0" },
        spec: { dnsName: "borntobuild.ru" },
        status: { state: challengeState, reason },
      },
    ],
  });
  const kubectlOf = (doc) => {
    const calls = [];
    const kubectl = (args) => {
      calls.push(args.join(" "));
      return { status: 0, stdout: JSON.stringify(doc) };
    };
    return { kubectl, calls };
  };

  it("pending issuance: a line per certificate, order and challenge, no failure", () => {
    const { lines, failure } = certificateReport(
      kubectlOf(items("pending", "Waiting for DNS-01 challenge propagation")),
    );
    expect(failure).toBe("");
    expect(lines).toEqual([
      "сертификат wizard-platform/platform: не готов (DoesNotExist: Issuing)",
      "заказ wizard-platform/platform-1: pending",
      "челлендж borntobuild.ru: pending — Waiting for DNS-01 challenge propagation",
    ]);
  });

  it("an errored challenge stops the smoke with its reason and the solver log; checked every 4th retry", () => {
    const { kubectl, calls } = kubectlOf(items("errored", "malformed ChallengeRequest"));
    const log = [];
    expect(certificateGate({ kubectl, log: (s) => log.push(s), attempt: 2 })).toBeUndefined();
    expect(calls).toEqual([]);
    expect(() => certificateGate({ kubectl, log: (s) => log.push(s), attempt: 5 })).toThrow(
      /сертификаты не выпускаются: заказ wizard-platform\/platform-1: errored/,
    );
    expect(calls.at(-1)).toContain("logs deploy/wizard-acme-dns01");
  });
});

describe("certificate gate: a failed order is retried once, stale orders are history", () => {
  const cert = (ready) => ({
    kind: "Certificate",
    metadata: { namespace: "wizard-platform", name: "wizard-platform" },
    status: { conditions: [{ type: "Ready", status: ready ? "True" : "False", reason: "DoesNotExist" }] },
  });
  const order = (name, state, at) => ({
    kind: "Order",
    metadata: {
      namespace: "wizard-platform",
      name,
      creationTimestamp: at,
      annotations: { "cert-manager.io/certificate-name": "wizard-platform" },
    },
    status: { state },
  });
  const challenge = (orderName, state) => ({
    kind: "Challenge",
    metadata: {
      namespace: "wizard-platform",
      name: `${orderName}-0`,
      ownerReferences: [{ name: orderName }],
    },
    spec: { dnsName: "borntobuild.ru" },
    status: { state, reason: state === "invalid" ? "NXDOMAIN looking up TXT" : "" },
  });
  const cluster = (items) => {
    const calls = [];
    const kubectl = (args) => {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify({ items: items() }) };
    };
    return { kubectl, calls };
  };

  it("an Issuing condition left by the failed issuance is replaced, not duplicated", () => {
    const failed = cert(false);
    failed.status.conditions.push({ type: "Issuing", status: "False", reason: "Failed" });
    const items = [failed, order("p-1", "invalid", "2026-10-04T17:25:29Z"), challenge("p-1", "invalid")];
    const { kubectl, calls } = cluster(() => items);
    const log = [];
    certificateGate({ kubectl, log: (s) => log.push(s), attempt: 1, retried: new Set() });
    const patch = JSON.parse(calls.find((a) => a.includes("patch")).at(-1));
    expect(patch).toEqual([
      expect.objectContaining({
        op: "replace",
        path: "/status/conditions/1",
        value: expect.objectContaining({ type: "Issuing", status: "True" }),
      }),
    ]);
    expect(log.join("\n")).toMatch(/запрошен новый выпуск/);
  });

  it("a rejected patch is reported, not claimed as a new issuance", () => {
    const items = [cert(false), order("p-1", "invalid", "2026-10-04T17:25:29Z"), challenge("p-1", "invalid")];
    const kubectl = (args) =>
      args.includes("patch") ? { status: 1, stdout: "" } : { status: 0, stdout: JSON.stringify({ items }) };
    const log = [];
    certificateGate({ kubectl, log: (s) => log.push(s), attempt: 1, retried: new Set() });
    expect(log.join("\n")).toMatch(/новый выпуск не запрошен/);
    expect(log.join("\n")).not.toMatch(/запрошен новый выпуск/);
  });

  it("first failure asks cert-manager for a new issuance (Issuing condition), a second failure throws", () => {
    let items = [cert(false), order("p-1", "invalid", "2026-10-04T17:25:29Z"), challenge("p-1", "invalid")];
    const { kubectl, calls } = cluster(() => items);
    const retried = new Set();
    const log = [];
    expect(certificateGate({ kubectl, log: (s) => log.push(s), attempt: 1, retried })).toBeUndefined();
    const patch = calls.find((a) => a.includes("patch"));
    expect(patch.slice(0, 6)).toEqual([
      "-n",
      "wizard-platform",
      "patch",
      "certificate",
      "wizard-platform",
      "--subresource=status",
    ]);
    expect(JSON.parse(patch.at(-1))[0].value).toMatchObject({
      type: "Issuing",
      status: "True",
      reason: "ManuallyTriggered",
    });
    expect(log.join("\n")).toMatch(/запрошен новый выпуск/);
    // The certificate already carries Ready only: the Issuing condition is appended.
    expect(JSON.parse(patch.at(-1))[0]).toMatchObject({ op: "add", path: "/status/conditions/-" });
    // The new order is pending: the old invalid one is history, no failure.
    items = [...items, order("p-2", "pending", "2026-10-04T19:00:00Z"), challenge("p-2", "pending")];
    expect(certificateReport({ kubectl }).failure).toBe("");
    expect(certificateGate({ kubectl, log: () => {}, attempt: 5, retried })).toBeUndefined();
    // It fails too: no second retry.
    items = [
      cert(false),
      order("p-1", "invalid", "2026-10-04T17:25:29Z"),
      order("p-2", "invalid", "2026-10-04T19:00:00Z"),
      challenge("p-2", "invalid"),
    ];
    expect(() => certificateGate({ kubectl, log: () => {}, attempt: 9, retried })).toThrow(
      /сертификаты не выпускаются: заказ wizard-platform\/p-2: invalid/,
    );
  });

  it("an invalid order of a ready certificate is not a failure", () => {
    const { kubectl } = cluster(() => [cert(true), order("p-1", "invalid", "2026-10-04T17:25:29Z")]);
    expect(certificateReport({ kubectl })).toMatchObject({ failure: "", stuck: [] });
  });
});

describe("kubeconfigText on an unreachable server", () => {
  it("WIZARD_K3S_WAIT_ATTEMPTS bounds the SSH waits; a network timeout says to look at the server", async () => {
    let calls = 0;
    const run = () => {
      calls++;
      return {
        status: 255,
        stdout: "",
        stderr: "ssh: connect to host 1.2.3.4 port 22: Connection timed out\n",
      };
    };
    const logs = [];
    await expect(
      kubeconfigText(
        { k3s_server: { value: { private_ip: "192.168.10.10" } } },
        {
          run,
          vars: { WIZARD_SSH_KEY_FILE: "/k", WIZARD_K3S_WAIT_ATTEMPTS: "3" },
          log: (s) => logs.push(s),
          dryRun: true,
          kubeDir: "/tmp/x",
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow(/Connection timed out\) — сервер не отвечает по сети/);
    expect(calls).toBe(3);
    expect(logs[0]).toMatch(/попытка 1\/3, ssh: connect to host/);
  });
});

describe("gvisorProbe (M2-18)", () => {
  it("one restricted pod of the sandbox image under RuntimeClass gvisor, with quota-compliant resources, removed after", () => {
    const calls = [];
    let pod = null;
    const kubectl = (args, o = {}) => {
      calls.push(args.join(" "));
      if (o.input) pod = JSON.parse(o.input);
      return { status: 0, stdout: "workerd 2026-09-30" };
    };
    const log = [];
    expect(gvisorProbe({ kubectl, image: "ghcr.io/o/wizard-sandbox:abc", log: (s) => log.push(s) })).toBe(
      true,
    );
    expect(pod.spec.runtimeClassName).toBe("gvisor");
    expect(pod.metadata.namespace).toBe("wizard-sandbox");
    expect(pod.spec.containers[0].image).toBe("ghcr.io/o/wizard-sandbox:abc");
    expect(pod.spec.containers[0].resources.requests).toEqual({ cpu: "50m", memory: "128Mi" });
    expect(pod.spec.securityContext.runAsUser).toBe(65532);
    expect(calls.at(-1)).toContain("delete pod wizard-gvisor-probe");
    expect(log).toEqual(["gVisor: под песочницы запускается (workerd 2026-09-30)"]);
  });
  it("a pod that does not run is described and reported as a warning", () => {
    const log = [];
    const kubectl = (args) => ({ status: args.includes("wait") ? 1 : 0, stdout: "" });
    expect(gvisorProbe({ kubectl, image: "i", log: (s) => log.push(s) })).toBe(false);
    expect(log.at(-1)).toMatch(/::warning.*gVisor/);
  });
});
