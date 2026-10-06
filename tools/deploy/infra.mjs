#!/usr/bin/env node
// One-command bring-up of a Wizard environment (platform/deploy.yaml#cloud.ci_cd.iac, M2-06), provider-neutral:
//   pnpm infra:apply --env staging|prod     OpenTofu → kubeconfig → namespaces → addons → DNS A records →
//                                           secrets check → Helm release → HTTPS smoke
//   node tools/deploy/infra.mjs plan    --env …   tofu plan only
//   node tools/deploy/infra.mjs deploy  --env …   Helm release of --tag only (CD after images are pushed)
//   node tools/deploy/infra.mjs destroy --env staging --yes   staging on demand: removes the whole environment
//                                           (only environments listed in provider.json destroyable)
//   node tools/deploy/infra.mjs check   --env … [--if-configured]   preflight; --if-configured: a missing
//                                           credential is a clean skip (exit 0), used by the GitHub workflows
// Provider: --provider / WIZARD_PROVIDER (default timeweb) → infra/tofu/<provider>/ (provider.json, envs/<env>, tofurc)
// and infra/helm/providers/<provider>.yaml; cluster profile: --profile, else the environment's tofu output
// env.cluster_profile (Timeweb pilot: `pilot`), else provider.json. A profile layers on its bases (PROFILES).
// --build-images builds and pushes the images of infra/docker/images.json to the environment's registry between the
// addons and the release (the in-cluster registry exists only after the addons).
// --dry-run prints every command (secret values masked) and executes nothing. Runs on the self-hosted runner (beta) or,
// for the pilot, on a GitHub-hosted runner through tools/deploy/pilot.mjs (deps.hooks: secrets from the encrypted
// bundle, a temporary SSH rule, WIZARD_K3S_ACCESS=tunnel): tofu, helm, kubectl on PATH. Inputs: docs/ops/deploy.md.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ENVS = ["staging", "prod"];
export const COMMANDS = ["apply", "plan", "deploy", "destroy", "check", "diagnose"];
export const DEFAULT_PROVIDER = "timeweb";
export const TOOLS = ["tofu", "helm", "kubectl"];
const SECRET_NAMES = /SECRET|PASSPHRASE|KEY_ID|PASSWORD|TOKEN/;

/** State of OpenTofu: provider-neutral names (S3-compatible bucket of the provider + client-side encryption). */
export const STATE_ENV = [
  ["WIZARD_TF_STATE_BUCKET", "бакет состояния OpenTofu (создаётся вручную, docs/ops/deploy.md)"],
  ["WIZARD_TF_STATE_ACCESS_KEY_ID", "ключ S3 к бакету состояния"],
  ["WIZARD_TF_STATE_SECRET_ACCESS_KEY", "секрет ключа S3 к бакету состояния"],
  ["WIZARD_TF_STATE_PASSPHRASE", "пароль шифрования состояния OpenTofu (≥ 16 символов)"],
];

/** infra/tofu/<name>/provider.json: credentials (env → TF_VAR_*) and the Helm values layer of the provider. */
export function loadProvider(name = DEFAULT_PROVIDER) {
  if (!/^[a-z0-9-]{2,32}$/.test(name)) throw new Error(`bad provider ${name}`);
  const dir = `infra/tofu/${name}`;
  const file = join(ROOT, dir, "provider.json");
  if (!existsSync(file)) throw new Error(`no provider ${name} (${dir}/provider.json)`);
  const p = JSON.parse(readFileSync(file, "utf8"));
  return {
    name,
    title: p.title ?? name,
    dir,
    requiredEnv: p.requiredEnv ?? [],
    optionalEnv: p.optionalEnv ?? [],
    helmValues: p.helmValues,
    profile: p.profile ?? null,
    destroyable: p.destroyable ?? [],
    cliConfig: existsSync(join(ROOT, dir, "tofurc")) ? join(ROOT, dir, "tofurc") : null,
  };
}

/** Required inputs of a provider: its credentials, then the state settings. */
export function requiredEnv(provider) {
  return [...provider.requiredEnv.map(([n, h]) => [n, h]), ...STATE_ENV];
}

export function parseArgs(argv, vars = process.env) {
  const [command = "apply", ...rest] = argv;
  const o = {
    command,
    env: null,
    dryRun: false,
    ifConfigured: false,
    yes: false,
    tag: null,
    provider: vars.WIZARD_PROVIDER || DEFAULT_PROVIDER,
    profile: vars.WIZARD_CLUSTER_PROFILE || null,
    buildImages: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--env") o.env = rest[++i] ?? null;
    else if (a.startsWith("--env=")) o.env = a.slice(6);
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--if-configured") o.ifConfigured = true;
    else if (a === "--yes") o.yes = true;
    else if (a === "--tag") o.tag = rest[++i] ?? null;
    else if (a === "--provider") o.provider = rest[++i] ?? "";
    else if (a === "--profile") o.profile = rest[++i] ?? null;
    else if (a === "--build-images") o.buildImages = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!COMMANDS.includes(o.command)) throw new Error(`unknown command ${o.command}`);
  if (!ENVS.includes(o.env)) throw new Error("--env staging|prod is required");
  if (o.profile !== null && !/^[a-z0-9-]+$/.test(o.profile)) throw new Error("bad --profile");
  return o;
}

export function tfvarsPath(
  env,
  vars = process.env,
  provider = loadProvider(vars.WIZARD_PROVIDER || DEFAULT_PROVIDER),
) {
  return vars.WIZARD_TFVARS_FILE || join(ROOT, provider.dir, "envs", env, "terraform.tfvars");
}

/** Missing inputs: {vars: [[name, hint]], tools: [], tfvars: path|null}. */
export function preflight(env, vars = process.env, has = (bin) => which(bin), exists = existsSync, provider) {
  const p = provider ?? loadProvider(vars.WIZARD_PROVIDER || DEFAULT_PROVIDER);
  const missing = requiredEnv(p).filter(([n]) => !vars[n]);
  if (vars.WIZARD_TF_STATE_PASSPHRASE && vars.WIZARD_TF_STATE_PASSPHRASE.length < 16) {
    missing.push(["WIZARD_TF_STATE_PASSPHRASE", "слишком короткий (нужно ≥ 16 символов)"]);
  }
  const tools = TOOLS.filter((t) => !has(t));
  const path = tfvarsPath(env, vars, p);
  const tfvars = exists(path) ? null : path;
  return { vars: missing, tools, tfvars, ok: missing.length === 0 && tools.length === 0 && tfvars === null };
}

function which(bin) {
  return spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
}

/** Environment of tofu: provider credentials as TF_VAR_* (provider.json), S3 backend keys, CLI config. */
export function tofuEnv(vars, provider = loadProvider(vars.WIZARD_PROVIDER || DEFAULT_PROVIDER)) {
  const out = {
    TF_IN_AUTOMATION: "1",
    TF_INPUT: "0",
    TF_VAR_state_passphrase: vars.WIZARD_TF_STATE_PASSPHRASE,
    AWS_ACCESS_KEY_ID: vars.WIZARD_TF_STATE_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: vars.WIZARD_TF_STATE_SECRET_ACCESS_KEY,
  };
  if (provider.cliConfig) out.TF_CLI_CONFIG_FILE = provider.cliConfig;
  for (const [name, , tfvar] of [...provider.requiredEnv, ...provider.optionalEnv]) {
    if (tfvar && vars[name]) out[tfvar] = vars[name];
  }
  return out;
}

export function tofuInitArgs(env, vars, provider = loadProvider(vars.WIZARD_PROVIDER || DEFAULT_PROVIDER)) {
  return [
    `-chdir=${provider.dir}/envs/${env}`,
    "init",
    "-input=false",
    `-backend-config=bucket=${vars.WIZARD_TF_STATE_BUCKET ?? "<WIZARD_TF_STATE_BUCKET>"}`,
  ];
}

/** Cluster profiles and their bases (values and addons of a base apply first): pilot = k3s + one VM for everything. */
export const PROFILES = { k3s: [], pilot: ["k3s"] };

/** Profile with its bases, base first: profileChain("pilot") → ["k3s", "pilot"]. */
export function profileChain(profile) {
  if (!profile) return [];
  return [...(PROFILES[profile] ?? []).flatMap((b) => profileChain(b)), profile];
}

/**
 * Values layers of the release: chart defaults → provider → cluster profiles (base first) → environment →
 * profiles/<profile>-<env>.yaml where present (a profile can override what values-<env>.yaml scales up).
 */
export function valueFiles(env, provider, profile) {
  const chain = profileChain(profile);
  const files = ["infra/helm/wizard/values.yaml"];
  if (provider.helmValues) files.push(provider.helmValues);
  for (const p of chain) files.push(`infra/helm/profiles/${p}.yaml`);
  files.push(`infra/helm/wizard/values-${env}.yaml`);
  for (const p of chain) {
    const f = `infra/helm/profiles/${p}-${env}.yaml`;
    if (existsSync(join(ROOT, f))) files.push(f);
  }
  for (const f of files) if (!existsSync(join(ROOT, f))) throw new Error(`no values file ${f}`);
  return files;
}

/** `helm upgrade --install wizard` from tofu outputs (the only place values meet infrastructure facts). */
export function wizardReleaseArgs({
  env,
  out,
  tag,
  email,
  provider = loadProvider(DEFAULT_PROVIDER),
  profile = null,
  ingressNamespace = "wizard-ingress",
  firstBoot = false,
}) {
  const pgHost = hostOf(
    out.postgres?.platform?.connection_string ?? out.postgres?.main?.connection_string ?? "",
  );
  // Pilot: PostgreSQL runs in the cluster (WAL-G into the backups bucket) — no managed host or subnet.
  const inCluster = out.env.postgres_mode === "in-cluster";
  const database = inCluster
    ? { "postgres.backupsBucket": out.env.buckets?.backups }
    : { "network.postgresCidrs[0]": out.env.postgres_cidr, "pgbouncer.postgresHost": pgHost };
  const set = {
    ...(out.env.s3_endpoint ? { "config.s3Endpoint": out.env.s3_endpoint } : {}),
    "images.registry": out.env.registry_url,
    "images.tag": tag,
    "domains.platform": out.env.domains.platform,
    "domains.systems": out.env.domains.systems,
    "tls.email": email,
    "network.podCidr": out.env.network.pods_cidr,
    "network.serviceCidr": out.env.network.services_cidr,
    "network.nodeCidr": out.env.network.nodes_cidr,
    ...database,
    "namespaces.ingress": ingressNamespace,
  };
  const args = ["upgrade", "--install", "wizard", "infra/helm/wizard", "--namespace", "wizard-platform"];
  for (const f of valueFiles(env, provider, profile)) args.push("-f", f);
  // No --atomic: releaseWizard rolls back itself, after printing why the release did not become ready.
  args.push("--wait", "--timeout", "15m");
  // First bring-up of an in-cluster database: initdb without asking the (necessarily empty) archive.
  if (inCluster && firstBoot) args.push("--set", "postgres.firstBoot=true");
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined || v === null || v === "") throw new Error(`missing value for ${k}`);
    args.push("--set-string", `${k}=${v}`);
  }
  return args;
}

function hostOf(conn) {
  const m = /@([^:/?\s]+)(?::\d+)?\//.exec(conn) ?? /host=([^\s]+)/.exec(conn);
  return m ? m[1] : "";
}

/** `helm upgrade --install` of an addon; overlays of the profiles in the chain come after its values. */
export function addonArgs(a, profile = null) {
  const overlays = profileChain(profile)
    .map((p) => a.overlays?.[p])
    .filter(Boolean)
    .flatMap((f) => ["-f", f]);
  return [
    "upgrade",
    "--install",
    a.name,
    a.chart,
    "--repo",
    a.repo,
    "--version",
    a.version,
    "--namespace",
    a.namespace,
    "--create-namespace",
    "-f",
    a.values,
    ...overlays,
    "--wait",
    "--timeout",
    "10m",
  ];
}

/** Secrets the release expects (created from OpenBao or by hand; never from GitHub). */
export const CLUSTER_SECRETS = [
  {
    namespace: "wizard-platform",
    name: "wizard-platform-env",
    fromFile: "WIZARD_PLATFORM_ENV_FILE",
    kind: "env-file",
  },
  {
    namespace: "wizard-platform",
    name: "wizard-pgbouncer",
    fromFile: "WIZARD_PGBOUNCER_SECRET_DIR",
    kind: "dir",
  },
  {
    namespace: "cert-manager",
    name: "wizard-dns-solver",
    fromFile: "WIZARD_DNS_SOLVER_ENV_FILE",
    kind: "env-file",
  },
];

/**
 * Secrets of a profile chain. Pilot: the self-managed database (env file: POSTGRES_PASSWORD, WALG_LIBSODIUM_KEY,
 * AWS_* of the backups bucket, WIZARD_DATA_BACKUP_KEY, optional alert webhook) and the pull secret of GHCR (built from
 * WIZARD_GHCR_USER / WIZARD_GHCR_TOKEN, a token with read:packages only).
 */
export function clusterSecrets(profile) {
  const chain = profileChain(profile);
  if (!chain.includes("pilot")) return CLUSTER_SECRETS;
  return [
    ...CLUSTER_SECRETS,
    {
      namespace: "wizard-platform",
      name: "wizard-postgres",
      fromFile: "WIZARD_POSTGRES_ENV_FILE",
      kind: "env-file",
    },
    {
      namespace: "wizard-platform",
      name: "wizard-ghcr",
      fromFile: "WIZARD_GHCR_TOKEN",
      kind: "registry",
    },
  ];
}

/** kubernetes.io/dockerconfigjson Secret as JSON (applied through stdin: the token never appears in argv). */
export function registrySecret(namespace, name, server, user = "", token = "") {
  const auth = Buffer.from(`${user}:${token}`).toString("base64");
  // No token → an empty auths map: kubelet pulls anonymously (public packages).
  const config = JSON.stringify({
    auths: token ? { [server]: { username: user, password: token, auth } } : {},
  });
  return JSON.stringify({
    apiVersion: "v1",
    kind: "Secret",
    type: "kubernetes.io/dockerconfigjson",
    metadata: { name, namespace },
    data: { ".dockerconfigjson": Buffer.from(config).toString("base64") },
  });
}

/** Names of the release's images (infra/docker/images.json). */
export function imageNames() {
  return JSON.parse(readFileSync(join(ROOT, "infra/docker/images.json"), "utf8")).images.map((i) => i.name);
}

/**
 * Waits until `<registry>/<name>:<tag>` exists for every name (OCI distribution API with a pull token, as GHCR
 * issues it for a read:packages token). Throws after `attempts` × 30 s.
 */
export async function waitForImages({
  registry,
  names,
  tag,
  user,
  token,
  log = () => {},
  f = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  attempts = 40,
}) {
  const [host, ...rest] = String(registry).split("/");
  const basic = Buffer.from(`${user}:${token}`).toString("base64");
  const accept = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ].join(", ");
  for (const name of names) {
    const repo = [...rest, name].join("/");
    for (let i = 1; ; i++) {
      const t = await f(`https://${host}/token?service=${host}&scope=repository:${repo}:pull`, {
        headers: { authorization: `Basic ${basic}` },
      });
      const bearer = t.ok ? (await t.json()).token : "";
      const r = await f(`https://${host}/v2/${repo}/manifests/${tag}`, {
        method: "HEAD",
        headers: { authorization: `Bearer ${bearer}`, accept },
      });
      if (r.status === 200) break;
      if (i >= attempts) throw new Error(`image ${host}/${repo}:${tag} is not in the registry (${r.status})`);
      log(`жду образ ${repo}:${tag} в ${host} (${i}/${attempts})…`);
      await sleep(30_000);
    }
  }
}

/** Registry host of an image reference prefix: "ghcr.io/owner" → "ghcr.io". */
export const registryHost = (registry) => String(registry).split("/")[0];

const mask = (args, env) =>
  args.map((a) => {
    for (const [k, v] of Object.entries(env ?? {}))
      if (v && SECRET_NAMES.test(k) && a.includes(v)) return "***";
    return a;
  });

export function createRunner({ dryRun, log = (s) => console.log(s), env = process.env } = {}) {
  return function run(cmd, args, o = {}) {
    log(`$ ${cmd} ${mask(args, { ...env, ...o.env }).join(" ")}`);
    if (dryRun) return { status: 0, stdout: o.fake ?? "" };
    const r = spawnSync(cmd, args, {
      cwd: ROOT,
      env: { ...env, ...o.env },
      encoding: "utf8",
      // tee: shown as usual, and also kept for the caller (the error carries it: Timeweb capacity errors, pilot.mjs).
      // stdin is a pipe whenever there is input: with "inherit" spawnSync silently drops o.input (`kubectl apply -f -`
      // got nothing — first live bootstrap, 2026-10-03).
      stdio: o.stdio ?? [
        o.capture || o.tee || o.input !== undefined ? "pipe" : "inherit",
        o.capture || o.tee ? "pipe" : "inherit",
        o.tee ? "pipe" : "inherit",
      ],
      input: o.input,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (o.tee) {
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
    }
    if (r.status !== 0 && !o.allowFail) {
      const err = new Error(`${cmd} ${args[0]} failed with ${r.status}`);
      if (o.tee) err.output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
      throw err;
    }
    return r;
  };
}

const FAKE_OUTPUTS = {
  env: {
    value: {
      registry_url: "registry.wizard.local",
      registry_push: "192.168.10.10:30500",
      ingress_ip: "203.0.113.10",
      domains: { platform: "<platform-domain>", systems: "<systems-domain>" },
      network: { pods_cidr: "10.1.0.0/16", services_cidr: "10.96.0.0/12", nodes_cidr: "10.0.0.0/22" },
      postgres_cidr: "10.0.8.0/24",
    },
  },
  postgres: { value: { main: { connection_string: "postgres://u@pg.internal:5432/wizard" } } },
  k3s_server: { value: { private_ip: "192.168.10.10", public_ip: "203.0.113.10" } },
};

export async function main(argv = process.argv.slice(2), vars = process.env, deps = {}) {
  const o = parseArgs(argv, vars);
  const provider = loadProvider(o.provider);
  const log = deps.log ?? ((s) => console.log(s));
  const pre = preflight(o.env, vars, deps.has, deps.exists, provider);
  if (!pre.ok) {
    const lines = [
      ...pre.vars.map(([n, h]) => `  - ${n}: ${h}`),
      ...pre.tools.map((t) => `  - нет утилиты ${t} на раннере`),
      ...(pre.tfvars ? [`  - нет файла ${pre.tfvars} (образец: terraform.tfvars.example)`] : []),
    ];
    const msg = `Развёртывание ${o.env} пропущено: нет доступов ${provider.title} (docs/ops/deploy.md, §«Что нужно от основателя»).\n${lines.join("\n")}`;
    if (o.ifConfigured || o.command === "check") {
      log(msg);
      return o.ifConfigured ? 0 : 2;
    }
    if (!o.dryRun) {
      log(msg);
      return 2;
    }
    log(`${msg}\n(--dry-run: команды показаны с заглушками)`);
  }
  if (o.command === "check") {
    log(`Окружение ${o.env} (${provider.title}): всё на месте.`);
    return 0;
  }
  if (o.env === "prod" && o.command !== "plan" && !o.yes && !o.dryRun) {
    log("prod: добавьте --yes (запуск только из deploy-prod.yml владельцем репозитория)");
    return 2;
  }
  let profile = o.profile ?? provider.profile;
  const run = deps.run ?? createRunner({ dryRun: o.dryRun, log, env: vars });
  const tenv = tofuEnv(vars, provider);
  const tag = o.tag ?? vars.WIZARD_IMAGE_TAG ?? vars.GITHUB_SHA ?? (o.dryRun ? "<image-tag>" : "");
  const tofu = (args, x = {}) => run("tofu", args, { env: tenv, ...x });
  const chdir = `-chdir=${provider.dir}/envs/${o.env}`;
  const varFile = `-var-file=${tfvarsPath(o.env, vars, provider)}`;
  const applyArgs = (...extra) => [
    chdir,
    "apply",
    "-input=false",
    "-auto-approve",
    varFile,
    "-lock-timeout=5m",
    ...extra,
  ];

  if (o.command === "destroy") {
    if (!provider.destroyable.includes(o.env)) {
      log(`${o.env} у ${provider.title} не удаляется одной командой (provider.json destroyable).`);
      return 2;
    }
    if (!o.yes && !o.dryRun) {
      log("destroy: добавьте --yes");
      return 2;
    }
  }
  tofu(tofuInitArgs(o.env, vars, provider));
  if (o.command === "plan") {
    tofu([chdir, "plan", "-input=false", varFile, "-lock-timeout=5m"]);
    return 0;
  }
  if (o.command === "destroy") {
    tofu([chdir, "destroy", "-input=false", "-auto-approve", varFile, "-lock-timeout=5m"]);
    log(
      o.dryRun
        ? "--dry-run: команды выше не выполнялись."
        : `${o.env} удалён; \`pnpm infra:apply --env ${o.env}\` создаст его заново.`,
    );
    return 0;
  }
  const out = () =>
    JSON.parse(
      tofu([chdir, "output", "-json"], { capture: true, fake: JSON.stringify(FAKE_OUTPUTS) }).stdout || "{}",
    );
  if (o.command === "apply") tofu(applyArgs(), { tee: true });
  let raw = out();
  if (!raw.env) {
    // Staging on demand: CD after a green main is a no-op while the environment does not exist.
    log(`${o.env} не создан (нет состояния OpenTofu): \`pnpm infra:apply --env ${o.env}\` создаст его.`);
    return o.env === "staging" ? 0 : 3;
  }
  profile = o.profile ?? raw.env.value?.cluster_profile ?? profile;
  const outputsOf = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v?.value]));
  // Hooks of tools/deploy/pilot.mjs (all optional): beforeCluster(outputs) → {vars, close} — secret files from the
  // encrypted bundle and a temporary SSH rule; afterKubeconfig({kubectl}); afterRelease({kubectl, outputs, tag});
  // onCluster({kubectl, helm, outputs}) → exit code — replaces the diagnose report (pilot.mjs eval).
  const hooks = deps.hooks ?? {};
  const access = hooks.beforeCluster ? await hooks.beforeCluster(outputsOf(raw)) : null;
  const v = { ...vars, ...(access?.vars ?? {}) };
  let closeTunnel = null;
  try {
    const kubeDir = v.RUNNER_TEMP || join(ROOT, ".kube");
    const kubeconfig = join(kubeDir, `wizard-${o.env}.kubeconfig`);
    const text = await kubeconfigText(raw, {
      run,
      vars: v,
      log,
      dryRun: o.dryRun,
      kubeDir,
      sleep: deps.sleep,
    });
    if (!o.dryRun) {
      mkdirSync(kubeDir, { recursive: true });
      writeFileSync(kubeconfig, text, { mode: 0o600 });
      chmodSync(kubeconfig, 0o600);
    } else log(`# kubeconfig → ${kubeconfig} (0600)`);
    if (v.WIZARD_K3S_ACCESS === "tunnel" && raw.k3s_server?.value) {
      closeTunnel = openTunnel({ run, vars: v, ip: k3sAddress(raw.k3s_server.value, v), kubeDir, log });
    }
    const kenv = { KUBECONFIG: kubeconfig };
    const kubectl = (args, x = {}) => run("kubectl", args, { env: kenv, ...x });
    const helm = (args, x = {}) => run("helm", args, { env: kenv, ...x });
    if (o.command === "diagnose") {
      // pilot.mjs eval: the same read access (SSH tunnel, kubeconfig) for its own work in the cluster instead.
      if (hooks.onCluster) return (await hooks.onCluster({ kubectl, helm, outputs: outputsOf(raw) })) ?? 0;
      diagnoseCluster({ kubectl, log });
      return 0;
    }
    if (hooks.afterKubeconfig) await hooks.afterKubeconfig({ kubectl, helm });

    if (o.command === "apply") {
      kubectl(["apply", "-f", "infra/k8s/namespaces.yaml"]);
      for (const a of addonsFor(profile)) helm(addonArgs(a, profile));
      // Providers whose ingress IP is only known after the addons (managed LoadBalancer) get a second apply for DNS.
      const known = raw.env?.value?.ingress_ip;
      if (!known) {
        const ip = kubectl(
          [
            "-n",
            "wizard-ingress",
            "get",
            "service",
            "traefik",
            "-o",
            "jsonpath={.status.loadBalancer.ingress[0].ip}",
          ],
          { capture: true, fake: "203.0.113.10" },
        ).stdout.trim();
        if (ip) {
          tofu(applyArgs(`-var=ingress_ip=${ip}`));
          raw = out();
        } else
          log("! у балансировщика ingress ещё нет IP: повторите apply, когда он появится (A-записи DNS)");
      }
    }

    for (const s of clusterSecrets(profile)) {
      const exists =
        kubectl(["-n", s.namespace, "get", "secret", s.name, "-o", "name"], {
          capture: true,
          allowFail: true,
          fake: s.name,
        }).status === 0;
      const src = v[s.fromFile];
      if (s.kind === "registry") {
        const registry = raw.env.value?.registry_url ?? "ghcr.io";
        if (src && v.WIZARD_GHCR_USER) {
          kubectl(["apply", "-f", "-"], {
            input: registrySecret(s.namespace, s.name, registryHost(registry), v.WIZARD_GHCR_USER, src),
          });
        } else if (v.WIZARD_GHCR_ANONYMOUS === "1") {
          // Public packages: no credentials at all. A job token here expires with the job, and a pod restarted later
          // would fail its pull with the stale credentials (pilot, 2026-10-03).
          kubectl(["apply", "-f", "-"], {
            input: registrySecret(s.namespace, s.name, registryHost(registry)),
          });
          log(`${s.namespace}/${s.name}: образы ${registry} публичные — загрузка без учётных данных`);
        } else if (!exists) {
          log(
            `Нет секрета ${s.namespace}/${s.name}: задайте WIZARD_GHCR_USER и WIZARD_GHCR_TOKEN (read:packages) — docs/ops/deploy.md`,
          );
          return 3;
        }
        continue;
      }
      // A runner-local file is used when it is there (first bring-up); later the Secret lives in the cluster.
      if (src && (deps.exists ?? existsSync)(src)) {
        const from = s.kind === "dir" ? `--from-file=${src}` : `--from-env-file=${src}`;
        const yaml = kubectl(
          ["-n", s.namespace, "create", "secret", "generic", s.name, from, "--dry-run=client", "-o", "yaml"],
          { capture: true, fake: "" },
        ).stdout;
        kubectl(["apply", "-f", "-"], { input: yaml });
      } else if (!exists) {
        log(
          `Нет секрета ${s.namespace}/${s.name}: задайте ${s.fromFile} (файл из OpenBao) — docs/ops/deploy.md`,
        );
        return 3;
      }
    }

    if (!tag) throw new Error("image tag: --tag, WIZARD_IMAGE_TAG or GITHUB_SHA");
    const outputs = outputsOf(raw);
    if (outputs.env.registry_push === null) {
      // Pilot: images are built by .github/workflows/images.yml on GitHub-hosted runners and pushed to GHCR; the
      // release waits until every image of this tag is there (images.yml may still be running for the same commit).
      log(
        `Образы ${tag} берутся из ${outputs.env.registry_url} (собирает images.yml), сборка на раннере не нужна.`,
      );
      const waitToken = v.WIZARD_GHCR_TOKEN || v.WIZARD_GHCR_JOB_TOKEN;
      if (!o.dryRun && waitToken && !deps.skipImageWait) {
        await waitForImages({
          registry: outputs.env.registry_url,
          names: imageNames(),
          tag,
          user: v.WIZARD_GHCR_USER ?? "",
          token: waitToken,
          log,
          sleep: deps.sleep,
        });
      }
    } else if (o.buildImages) {
      const server = outputs.k3s_server;
      const registry = server
        ? `${k3sAddress(server, v)}:30500`
        : (outputs.env.registry_push ?? outputs.env.registry_url);
      if (v.WIZARD_REGISTRY_PASSWORD) {
        run("docker", ["login", registry, "-u", v.WIZARD_REGISTRY_USER ?? "", "--password-stdin"], {
          input: v.WIZARD_REGISTRY_PASSWORD,
        });
      }
      run("node", ["tools/deploy/images.mjs", "build", "--registry", registry, "--tag", tag, "--push"]);
    }
    const email = v.WIZARD_ACME_EMAIL || `security@${outputs.env.domains.platform}`;
    releaseWizard({
      helm,
      kubectl,
      args: wizardReleaseArgs({
        env: o.env,
        out: outputs,
        tag,
        email,
        provider,
        profile,
        firstBoot: v.WIZARD_PG_FIRST_BOOT === "1",
      }),
      log,
    });
    if (hooks.afterRelease) await hooks.afterRelease({ kubectl, helm, outputs, tag });
    if (!o.dryRun && !deps.skipSmoke) {
      // A fresh environment gets its certificates over DNS-01 after the release: WIZARD_SMOKE_ATTEMPTS × 30 s.
      const retried = new Set();
      await smokeWithRetry(outputs.env.domains, {
        log,
        attempts: Number(v.WIZARD_SMOKE_ATTEMPTS ?? 1) || 1,
        sleep: deps.sleep,
        f: deps.fetch,
        onRetry: (i) => certificateGate({ kubectl, log, attempt: i, retried }),
      });
    }
    log(o.dryRun ? "--dry-run: команды выше не выполнялись." : `Готово: ${o.env} развёрнут, образы ${tag}.`);
    return 0;
  } finally {
    if (closeTunnel) closeTunnel();
    // The workflow closes the access again in a step of its own; a failed API call here must not fail a done release.
    if (access?.close)
      await Promise.resolve()
        .then(() => access.close())
        .catch((e) => log(`::warning::доступ не закрыт: ${e?.message ?? e} — закроет шаг close-access`));
  }
}

/**
 * `helm upgrade --install --wait` of the platform with --atomic semantics plus diagnostics: when the release does not
 * become ready, the pods, the events and the logs of the pods that are not ready are printed first (with --atomic
 * they were gone before anyone could look — first live bootstrap, 2026-10-03), then the release goes back to its last
 * deployed revision, or is uninstalled when there is none.
 */
const LLM_CALLS_SQL = `select provider, model_id, tier, status, coalesce(error_code, '') as error_code, route_reason,
  count(*) as calls, max(created_at) as last_at
from platform.llm_calls where created_at > now() - interval '3 hours'
group by 1, 2, 3, 4, 5, 6 order by last_at desc limit 40;
-- Runs of the last 6 hours (eval and clients): kinds, outcomes and failure codes; builds one by one with the stage
-- metrics of the harness (builder.yaml#harness.metrics) and the most frequent failed checks. Codes, counts and
-- platform texts only — no prompts, files or personal data.
select kind, coalesce(mode, '') as mode, status, coalesce(failure_code, '') as failure_code, count(*) as runs
from platform.runs where created_at > now() - interval '6 hours'
group by 1, 2, 3, 4 order by runs desc limit 30;
select to_char(r.created_at at time zone 'Europe/Moscow', 'HH24:MI') as msk, coalesce(r.mode, '') as mode, r.status,
  coalesce(r.failure_code, '') as code, left(coalesce(r.failure_message_ru, ''), 120) as message,
  round(extract(epoch from (coalesce(r.finished_at, now()) - r.started_at)) / 60) as min,
  round(r.credits_used_milli / 1000.0, 1) as credits,
  (select e.payload->'stages' from platform.run_events e
     where e.run_id = r.id and e.type = 'build_metrics' order by e.seq desc limit 1)::text as stages
from platform.runs r where r.kind = 'build' and r.created_at > now() - interval '6 hours'
order by r.created_at desc limit 20;
select to_char(date_trunc('hour', created_at at time zone 'Europe/Moscow'), 'DD.MM HH24:00') as msk_hour,
  round(sum(cost_rub), 0) as rub, count(*) as calls
from platform.llm_calls where billable and created_at > now() - interval '24 hours'
group by 1 order by 1;
select to_char(e.ts at time zone 'Europe/Moscow', 'HH24:MI') as msk, e.payload->>'decisionId' as decision,
  left(e.payload->>'prompt_ru', 400) as why,
  (select s.payload->>'step' from platform.run_events s where s.run_id = e.run_id and s.type = 'step_started'
     and s.seq < e.seq order by s.seq desc limit 1) as at_step
from platform.run_events e
where e.type = 'needs_input' and e.payload->>'decisionId' = 'escalation' and e.ts > now() - interval '6 hours'
order by e.ts desc limit 15;
select fc->>'id' as failed_check, count(*) as times
from platform.run_events e cross join lateral jsonb_array_elements(coalesce(e.payload->'failedChecks', '[]'::jsonb)) fc
where e.type = 'gate_result' and e.ts > now() - interval '6 hours'
group by 1 order by 2 desc limit 20;
-- What the failed blocker checks say (G0-TS-01: the compiler's text; others: the gate's message), grouped.
select c->>'id' as check_id, left(regexp_replace(coalesce(c->>'evidence', c->>'message_ru'), '\\s+', ' ', 'g'), 220) as says,
  count(*) as times
from platform.gate_reports g join platform.runs r on r.id = g.run_id
cross join lateral jsonb_array_elements(g.report->'checks') c
where r.created_at > now() - interval '6 hours' and c->>'status' in ('fail', 'error') and c->>'severity' = 'blocker'
group by 1, 2 order by 3 desc limit 40;
-- Rejected tool calls of the builder's own phases (build_metrics.stages.rejections): phase, tool, code, issues.
select x->>'phase' as phase, x->>'tool' as tool, x->>'code' as code, x->>'issues' as issues, count(*) as times
from platform.run_events e cross join lateral jsonb_array_elements(coalesce(e.payload->'stages'->'rejections', '[]'::jsonb)) x
where e.type = 'build_metrics' and e.ts > now() - interval '6 hours'
group by 1, 2, 3, 4 order by 5 desc limit 30;
`;

/**
 * Which request shape the providers accept (D67 eval, 2026-10-05: every call answered 4xx while /models was 200):
 * a 1-word prompt without tools, with a tool and tool_choice auto | required | the named function, with the extra
 * fields packages/llm transformBody adds. Prints the status and the start of the provider's error text only.
 */
const LLM_SHAPE_PROBE = `
const targets = [
  { host: "https://api.z.ai/api/paas/v4", key: process.env.ZAI_API_KEY, model: "glm-5.3", extra: { reasoning_effort: "high" } },
  { host: "https://foundation-models.api.cloud.ru/v1", key: process.env.CLOUDRU_API_KEY, model: "moonshotai/Kimi-K2.6", extra: { chat_template_kwargs: { enable_thinking: false } } },
  { host: "https://foundation-models.api.cloud.ru/v1", key: process.env.CLOUDRU_API_KEY, model: "zai-org/GLM-5.1", extra: { chat_template_kwargs: { enable_thinking: false } } },
];
const tool = { type: "function", function: { name: "answer", description: "Ответ", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } } };
const variants = [
  ["без инструментов", {}],
  ["tool_choice auto", { tools: [tool], tool_choice: "auto" }],
  ["tool_choice required", { tools: [tool], tool_choice: "required" }],
  ["tool_choice функция", { tools: [tool], tool_choice: { type: "function", function: { name: "answer" } } }],
  ["второй ход с результатом", { tools: [tool], tool_choice: "auto", turn2: true }],
];
(async () => {
  for (const t of targets) {
    for (const [name, v] of variants) {
      const { turn2, ...vv } = v;
      const messages = [{ role: "system", content: "Отвечай кратко." }, { role: "user", content: "Скажи: да" }];
      if (turn2) messages.push({ role: "assistant", content: "", tool_calls: [{ id: "c0", type: "function", function: { name: "answer", arguments: JSON.stringify({ text: "да" }) } }] }, { role: "tool", tool_call_id: "c0", content: "ok" });
      const body = { model: t.model, messages, max_tokens: 400 + (t.host.includes("z.ai") ? 8192 : 0), temperature: 0.1, ...vv, ...(vv.tools ? t.extra : {}) };
      const t0 = Date.now();
      try {
        const r = await fetch(t.host + "/chat/completions", { method: "POST", headers: { authorization: "Bearer " + t.key, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
        const txt = await r.text();
        let note = "";
        if (r.ok) { try { const j = JSON.parse(txt); const c = j.choices?.[0]; note = "finish=" + c?.finish_reason + (c?.message?.tool_calls?.length ? " tool_calls=" + c.message.tool_calls.length : "") + " text=" + JSON.stringify(String(c?.message?.content ?? "").slice(0, 40)); } catch { note = txt.slice(0, 120); } }
        else note = txt.replace(/\\s+/g, " ").slice(0, 300);
        console.log(t.model, "|", name, "| HTTP", r.status, "|", Date.now() - t0, "мс |", note);
      } catch (e) {
        console.log(t.model, "|", name, "| ошибка", String(e?.cause?.code ?? e?.message ?? e).slice(0, 160));
      }
    }
  }
})();
`;

/** Reachability of the model providers (packages/llm/src/registry.ts default base URLs): HTTP status or the error. */
const LLM_PROBE = `
const urls = ["https://foundation-models.api.cloud.ru/v1/models", "https://api.z.ai/api/paas/v4/models", "https://llm.api.cloud.yandex.net/v1/models"];
const keys = { "foundation-models.api.cloud.ru": process.env.CLOUDRU_API_KEY, "api.z.ai": process.env.ZAI_API_KEY };
(async () => {
  for (const u of urls) {
    const host = new URL(u).host;
    const t = Date.now();
    try {
      const k = keys[host];
      const r = await fetch(u, { headers: k ? { authorization: "Bearer " + k } : {}, signal: AbortSignal.timeout(15000) });
      console.log(host, "HTTP", r.status, "за", Date.now() - t, "мс", k ? "(с ключом)" : "(без ключа)", k ? "" : "");
    } catch (e) {
      console.log(host, "ошибка:", e?.cause?.code ?? e?.name ?? "", String(e?.cause?.message ?? e?.message ?? e).slice(0, 160), "за", Date.now() - t, "мс");
    }
  }
  console.log("ключи в поде:", "CLOUDRU_API_KEY", process.env.CLOUDRU_API_KEY ? "задан" : "НЕТ", "· ZAI_API_KEY", process.env.ZAI_API_KEY ? "задан" : "НЕТ", "· WIZARD_LLM_MODE", process.env.WIZARD_LLM_MODE ?? "—");
})();
`;

// Platform mail over the Unisender Go API from the platform-api pod: system/info.json checks the key and the route on
// 443 without sending a letter. Prints the HTTP status and the API error code only.
const MAIL_PROBE = `
const host = (process.env.WIZARD_SMTP_HOST || "").trim();
const m = /^smtp\\.(go\\d+)\\.unisender\\.ru\\.?$/i.exec(host);
const base = (process.env.WIZARD_MAIL_API_BASE || "").trim().replace(/\\/+$/, "") || (m ? "https://" + m[1].toLowerCase() + ".unisender.ru" : "https://goapi.unisender.ru");
(async () => {
  console.log("транспорт:", process.env.WIZARD_MAIL_TRANSPORT || "(по хосту)", "· API:", base, "· пароль:", process.env.WIZARD_SMTP_PASSWORD ? "задан" : "НЕТ", "· отправитель:", process.env.WIZARD_SMTP_FROM ? "задан" : "НЕТ");
  const t = Date.now();
  try {
    const r = await fetch(base + "/ru/transactional/api/v1/system/info.json", { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "X-API-KEY": process.env.WIZARD_SMTP_PASSWORD || "" }, body: "{}", signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    console.log("system/info: HTTP", r.status, "за", Date.now() - t, "мс", j.status ? "status=" + j.status : "", j.code !== undefined ? "code=" + j.code : "", j.message ? "message=" + String(j.message).slice(0, 160) : "");
  } catch (e) {
    console.log("system/info: ошибка", e?.cause?.code ?? e?.name ?? "", String(e?.cause?.message ?? e?.message ?? e).slice(0, 160));
  }
  // Sender domains of the account and their checks (code 229 «tracking domain required»: is the link domain there?).
  try {
    const r = await fetch(base + "/ru/transactional/api/v1/domain/list.json", { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "X-API-KEY": process.env.WIZARD_SMTP_PASSWORD || "" }, body: "{}", signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    const flat = (o) => Object.entries(o ?? {}).filter(([, v]) => v === null || typeof v !== "object").map(([k, v]) => k + "=" + String(v).replace(/[^s@]+@[^s@]+/g, "<почта>").slice(0, 60)).join(" ");
    console.log("domain/list: HTTP", r.status, flat(j));
    for (const d of Array.isArray(j.domains) ? j.domains : []) console.log("  домен:", flat(d));
  } catch (e) {
    console.log("domain/list: ошибка", e?.cause?.code ?? e?.name ?? "", String(e?.cause?.message ?? e?.message ?? e).slice(0, 160));
  }
  // A send to a reserved .invalid address: nothing can be delivered, the provider names why it refuses the sender.
  const fromRaw = process.env.WIZARD_SMTP_FROM || "";
  const from = (/<([^>]+)>/.exec(fromRaw)?.[1] ?? fromRaw).trim();
  try {
    const r = await fetch(base + "/ru/transactional/api/v1/email/send.json", { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "X-API-KEY": process.env.WIZARD_SMTP_PASSWORD || "" }, body: JSON.stringify({ message: { recipients: [{ email: "probe@wizard-diagnose.invalid" }], subject: "probe", from_email: from, template_engine: "none", body: { plaintext: "probe" } } }), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    const mask = (v) => String(v ?? "").replace(/[^\\s@"'<>]+@[^\\s@"'<>]+/g, "<почта>").slice(0, 200);
    console.log("email/send (адрес .invalid, письмо не доставляется): HTTP", r.status, j.status ? "status=" + j.status : "", j.code !== undefined ? "code=" + j.code : "", j.message ? "message=" + mask(j.message) : "", j.failed_emails ? "failed=" + mask(JSON.stringify(j.failed_emails)) : "", "· домен отправителя:", from.split("@")[1] || "—");
  } catch (e) {
    console.log("email/send: ошибка", e?.cause?.code ?? e?.name ?? "", String(e?.cause?.message ?? e?.message ?? e).slice(0, 160));
  }
})();
`;

/**
 * Error and warning lines of a pod's JSON log, reduced to time, message and error name/code/message; addresses are
 * masked (the repository is public, the run log too).
 */
export function errorLines(stdout, limit = 40) {
  const mask = (v) =>
    String(v ?? "")
      .replace(/[^\s@"'<>]+@[^\s@"'<>]+/g, "<почта>")
      .slice(0, 240);
  const out = [];
  for (const line of String(stdout ?? "").split("\n")) {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.level !== "error" && j.level !== "warn") continue;
    const err = j.err ?? j.error ?? {};
    const e = typeof err === "object" && err ? err : { message: err };
    out.push(
      [
        j.ts,
        j.level,
        mask(j.msg),
        e.type ?? e.name,
        e.status,
        e.sqlstate,
        e.code ?? j.code,
        mask(e.message),
        e.stack?.[0],
      ]
        .filter((x) => x !== undefined && x !== null && x !== "")
        .join(" | "),
    );
  }
  return out.slice(-limit);
}

/**
 * Read-only picture of a running cluster (`diagnose`, minutes instead of a whole release): nodes, pods, the ingress,
 * certificates with their ACME orders and challenges, the DNS-01 solver and cert-manager logs, platform events.
 */
export function diagnoseCluster({ kubectl, log = console.log }) {
  const opt = { allowFail: true };
  const step = (title, args) => {
    log(`::group::${title}`);
    kubectl(args, opt);
    log("::endgroup::");
  };
  step("Узлы", ["get", "nodes", "-o", "wide"]);
  step("Поды", ["get", "pods", "-A", "-o", "wide"]);
  step("Вход (Traefik)", ["-n", "wizard-ingress", "get", "svc,pods", "-o", "wide"]);
  step("Сертификаты", ["get", "certificates,certificaterequests,orders,challenges", "-A", "-o", "wide"]);
  step("ACME-челленджи подробно", ["describe", "challenges", "-A"]);
  step("ACME-заказы подробно", ["describe", "orders", "-A"]);
  step("Решатель DNS-01", ["-n", "cert-manager", "logs", "deploy/wizard-acme-dns01", "--tail=120"]);
  step("cert-manager", ["-n", "cert-manager", "logs", "deploy/cert-manager", "--tail=120"]);
  step("События платформы", ["-n", "wizard-platform", "get", "events", "--sort-by=.lastTimestamp"]);
  step("События cert-manager", ["-n", "cert-manager", "get", "events", "--sort-by=.lastTimestamp"]);
  // Model calls (D67 eval, 2026-10-05: «Модели сейчас недоступны» on every brief): which provider and model failed with
  // which code over the last 3 hours, and whether the providers answer from the worker pod with its NetworkPolicy.
  // Counts and codes only — no prompts, orgs or users.
  log("::group::Вызовы моделей за 3 часа и прогоны за 6 часов");
  kubectl(
    [
      "-n",
      "wizard-platform",
      "exec",
      "-i",
      "wizard-postgres-0",
      "-c",
      "postgres",
      "--",
      "sh",
      "-c",
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h /var/run/postgresql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -P pager=off -f -',
    ],
    { ...opt, input: LLM_CALLS_SQL },
  );
  log("::endgroup::");
  step("Форма запроса к моделям (крошечные вызовы)", [
    "-n",
    "wizard-platform",
    "exec",
    "deploy/wizard-worker",
    "--",
    "node",
    "-e",
    LLM_SHAPE_PROBE,
  ]);
  step("Провайдеры моделей из пода worker", [
    "-n",
    "wizard-platform",
    "exec",
    "deploy/wizard-worker",
    "--",
    "node",
    "-e",
    LLM_PROBE,
  ]);
  // Login by code returned 500 after the mail moved to the HTTP API (2026-10-05): the API errors and the mail route.
  log("::group::Ошибки platform-api (последние)");
  for (const l of errorLines(
    kubectl(["-n", "wizard-platform", "logs", "deploy/wizard-platform-api", "--tail=3000"], {
      ...opt,
      capture: true,
      fake: "",
    }).stdout,
  ))
    log(l);
  log("::endgroup::");
  step("Почта платформы из пода platform-api", [
    "-n",
    "wizard-platform",
    "exec",
    "deploy/wizard-platform-api",
    "--",
    "node",
    "-e",
    MAIL_PROBE,
  ]);
  // The WAL-G archive: the same image, environment and Secret as the database, from a one-shot pod with the egress
  // rules of the PostgreSQL Jobs; plus the network probe with an unsigned listing of the backups bucket.
  const sts = kubectl(["-n", "wizard-platform", "get", "statefulset", "wizard-postgres", "-o", "json"], {
    ...opt,
    capture: true,
    fake: "{}",
  });
  let pg = null;
  try {
    pg = (JSON.parse(sts.stdout || "{}").spec?.template?.spec?.containers ?? []).find(
      (c) => c.name === "postgres",
    );
  } catch {}
  if (!pg) return;
  const env = (pg.env ?? []).filter((e) => e.value !== undefined);
  const bucket = /^s3:\/\/([^/]+)/.exec(env.find((e) => e.name === "WALG_S3_PREFIX")?.value ?? "")?.[1] ?? "";
  // WAL-G resolves its user: the postgres user of the image (uid 999), as the database container runs.
  const pods = [
    ["wizard-net-probe", ["node", "-e", NET_PROBE], [{ name: "PROBE_BUCKET", value: bucket }], [], 1000],
    [
      "wizard-walg-probe",
      ["timeout", "45", "wal-g", "backup-list"],
      [
        ...env,
        { name: "WALG_LOG_LEVEL", value: "DEVEL" },
        { name: "S3_LOG_LEVEL", value: "DEVEL" },
        { name: "GODEBUG", value: "netdns=go+2" },
      ],
      pg.envFrom ?? [],
      999,
    ],
  ];
  for (const [name, command, podEnv, envFrom, uid] of pods) {
    const ns = "wizard-platform";
    kubectl(["-n", ns, "delete", "pod", name, "--ignore-not-found", "--wait=true"], opt);
    const manifest = netProbePod({
      name,
      namespace: ns,
      image: pg.image,
      labels: { "wizard.ru/role": "pg-job" },
      pullSecret: "wizard-ghcr",
      command,
      env: podEnv,
      envFrom,
      uid,
    });
    kubectl(["apply", "-f", "-"], { ...opt, input: JSON.stringify(manifest) });
    kubectl(
      ["-n", ns, "wait", `pod/${name}`, "--for=jsonpath={.status.phase}=Succeeded", "--timeout=90s"],
      opt,
    );
    step(`Проба ${name}`, ["-n", ns, "logs", name]);
    kubectl(["-n", ns, "delete", "pod", name, "--ignore-not-found", "--wait=false"], opt);
  }
}

/** Network probe run inside a pod by releaseWizard: DNS of the S3 endpoint and one HTTPS request to it. */
export const NET_PROBE = [
  'const h = "s3.twcstorage.ru";',
  'require("node:dns").promises.lookup(h, { all: true }).then((a) => console.log("probe dns", h, a.map((x) => x.address).join(",")), (e) => console.log("probe dns error", e.code));',
  "const t0 = Date.now();",
  'fetch("https://" + h, { signal: AbortSignal.timeout(15000) }).then((r) => console.log("probe https", r.status, Date.now() - t0, "ms"), (e) => console.log("probe https error", e.cause?.code ?? e.name, Date.now() - t0, "ms"));',
  // An unsigned listing of the backups bucket: a quick 403 means S3 answers for it (a hang is then WAL-G's own).
  "const b = process.env.PROBE_BUCKET;",
  'if (b) { const t1 = Date.now(); fetch("https://" + h + "/" + b + "?list-type=2&max-keys=1&prefix=pg/", { signal: AbortSignal.timeout(20000) }).then((r) => console.log("probe bucket", b, r.status, Date.now() - t1, "ms"), (e) => console.log("probe bucket error", b, e.cause?.code ?? e.name, Date.now() - t1, "ms")); }',
].join(" ");

/**
 * One-shot pod running NET_PROBE with `image` (already on the node): in the platform namespace with the role
 * pg-job (the egress rules of PostgreSQL and its Jobs) and in `default` (no NetworkPolicy) — the difference tells a
 * policy from the network. Restricted PodSecurity fields included.
 */
export function netProbePod({
  name,
  namespace,
  image,
  labels = {},
  pullSecret = "",
  command = ["node", "-e", NET_PROBE],
  env = [],
  envFrom = [],
  uid = 1000,
}) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace, labels: { "app.kubernetes.io/name": "wizard-net-probe", ...labels } },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      ...(pullSecret ? { imagePullSecrets: [{ name: pullSecret }] } : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: uid,
        runAsGroup: uid,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "probe",
          image,
          imagePullPolicy: "IfNotPresent",
          command,
          env,
          envFrom,
          resources: { limits: { cpu: "500m", memory: "256Mi" } },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
        },
      ],
    },
  };
}

/**
 * gVisor on the node (M2-18): a one-shot pod of the sandbox image under the RuntimeClass gvisor prints the workerd
 * version. Functions of client systems run only in such pods — a broken runsc handler or a missing image shows up
 * here, not at a client's first build. Returns whether the pod ran.
 */
export function gvisorProbe({ kubectl, image, log = console.log, namespace = "wizard-sandbox" }) {
  const name = "wizard-gvisor-probe";
  const opt = { allowFail: true };
  const pod = netProbePod({
    name,
    namespace,
    image,
    command: ["/usr/local/bin/workerd", "--version"],
    uid: 65532,
  });
  pod.metadata.labels = { "app.kubernetes.io/name": "wizard-gvisor-probe" };
  pod.spec.runtimeClassName = "gvisor";
  // The sandbox namespace has a ResourceQuota: requests and limits are mandatory.
  pod.spec.containers[0].resources = {
    limits: { cpu: "500m", memory: "128Mi" },
    requests: { cpu: "50m", memory: "128Mi" },
  };
  kubectl(["-n", namespace, "delete", "pod", name, "--ignore-not-found", "--wait=true"], opt);
  kubectl(["apply", "-f", "-"], { ...opt, input: JSON.stringify(pod) });
  const ok =
    kubectl(
      ["-n", namespace, "wait", `pod/${name}`, "--for=jsonpath={.status.phase}=Succeeded", "--timeout=180s"],
      opt,
    ).status === 0;
  if (ok) {
    const out = kubectl(["-n", namespace, "logs", name], { ...opt, capture: true, fake: "workerd" });
    log(`gVisor: под песочницы запускается (${String(out.stdout ?? "").trim()})`);
  } else {
    log("::group::gVisor: под песочницы не запустился");
    kubectl(["-n", namespace, "describe", "pod", name], opt);
    log("::endgroup::");
    log(
      "::warning title=pilot::Под песочницы (gVisor) не запустился: функции систем клиентов работать не будут, см. лог выше",
    );
  }
  kubectl(["-n", namespace, "delete", "pod", name, "--ignore-not-found", "--wait=false"], opt);
  return ok;
}

export function releaseWizard({ helm, kubectl, args, log = console.log, namespace = "wizard-platform" }) {
  const history = helm(["history", "wizard", "-n", namespace, "-o", "json"], {
    capture: true,
    allowFail: true,
    fake: "[]",
  });
  let deployed = null;
  try {
    const revs = history.status === 0 ? JSON.parse(history.stdout || "[]") : [];
    deployed = revs.filter((h) => h.status === "deployed").at(-1)?.revision ?? null;
  } catch {}
  try {
    helm(args);
  } catch (e) {
    log("::group::Диагностика: релиз wizard не стал готовым");
    const opt = { allowFail: true };
    kubectl(["get", "pods", "-A", "-o", "wide"], opt);
    kubectl(["-n", namespace, "get", "events", "--sort-by=.lastTimestamp"], opt);
    const pods = kubectl(["-n", namespace, "get", "pods", "-o", "json"], {
      ...opt,
      capture: true,
      fake: "{}",
    });
    let items = [];
    try {
      items = JSON.parse(pods.stdout || "{}").items ?? [];
    } catch {}
    const notReady = items.filter(
      (p) => !(p.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True"),
    );
    let probes = 0;
    for (const p of notReady.slice(0, 8)) {
      const name = p.metadata?.name;
      if (p.status?.phase === "Succeeded" || !name) continue;
      kubectl(["-n", namespace, "describe", "pod", name], opt);
      // Container by container, init containers included (--all-containers fails while the main one waits).
      const statuses = [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])];
      for (const c of statuses) {
        if (c.state?.waiting && !c.restartCount) continue;
        kubectl(["-n", namespace, "logs", name, "-c", c.name, "--tail=80"], opt);
        if (c.restartCount)
          kubectl(["-n", namespace, "logs", name, "-c", c.name, "--previous", "--tail=40"], opt);
      }
      // A container that hangs (no log) is asked from inside: DNS and HTTPS to the S3 endpoint, 10 s each.
      const running = statuses.find((c) => c.state?.running);
      if (running && probes < 3) {
        probes++;
        kubectl(["-n", namespace, "exec", name, "-c", running.name, "--", "node", "-e", NET_PROBE], opt);
      }
    }
    const image = items
      .flatMap((p) => p.spec?.containers ?? [])
      .find((c) => /wizard-postgres|wizard-platform-api/.test(c.image ?? ""))?.image;
    if (image) {
      for (const [ns, labels, pullSecret] of [
        [namespace, { "wizard.ru/role": "pg-job" }, "wizard-ghcr"],
        ["default", {}, ""],
      ]) {
        const name = "wizard-net-probe";
        kubectl(["-n", ns, "delete", "pod", name, "--ignore-not-found", "--wait=true"], opt);
        kubectl(["apply", "-f", "-"], {
          ...opt,
          input: JSON.stringify(netProbePod({ name, namespace: ns, image, labels, pullSecret })),
        });
        kubectl(
          ["-n", ns, "wait", `pod/${name}`, "--for=jsonpath={.status.phase}=Succeeded", "--timeout=60s"],
          opt,
        );
        log(
          `проба сети из ${ns}${labels["wizard.ru/role"] ? ` (роль ${labels["wizard.ru/role"]})` : " (без NetworkPolicy)"}:`,
        );
        kubectl(["-n", ns, "logs", name], opt);
        kubectl(["-n", ns, "delete", "pod", name, "--ignore-not-found", "--wait=false"], opt);
      }
    }
    log("::endgroup::");
    if (deployed !== null)
      helm(["rollback", "wizard", String(deployed), "-n", namespace, "--wait", "--timeout", "10m"], opt);
    else helm(["uninstall", "wizard", "-n", namespace, "--wait", "--timeout", "10m"], opt);
    throw e;
  }
}

/**
 * smoke() repeated while certificates are being issued: `attempts` tries 30 s apart. `onRetry(i)` runs before each
 * wait and may throw to stop early (certificateGate: Let's Encrypt gave up, waiting cannot help).
 */
export async function smokeWithRetry(
  domains,
  {
    log = console.log,
    attempts = 1,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    f = fetch,
    onRetry = async () => {},
  } = {},
) {
  for (let i = 1; ; i++) {
    try {
      await smoke(domains, log, f);
      return;
    } catch (e) {
      if (i >= attempts) throw e;
      log(`smoke: ${e instanceof Error ? e.message : String(e)} — повтор через 30 с (${i}/${attempts})`);
      await onRetry(i);
      await sleep(30_000);
    }
  }
}

/**
 * ACME issuance as cert-manager sees it: a line per certificate and challenge; `failure` names a challenge or order
 * that ended errored/invalid (cert-manager retries it only after an hour-long backoff).
 */
export function certificateReport({ kubectl }) {
  const r = kubectl(["get", "certificates,orders,challenges", "-A", "-o", "json"], {
    capture: true,
    allowFail: true,
    fake: '{"items":[]}',
  });
  let items = [];
  try {
    items = JSON.parse(r.stdout || "{}").items ?? [];
  } catch {}
  const key = (ns, name) => `${ns}/${name}`;
  const ready = new Set();
  for (const it of items)
    if (
      it.kind === "Certificate" &&
      (it.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True")
    )
      ready.add(key(it.metadata?.namespace, it.metadata?.name));
  // The newest order of each certificate; older ones (and those of ready certificates) are history, not the state.
  const certOf = (o) => o.metadata?.annotations?.["cert-manager.io/certificate-name"];
  const newest = new Map();
  for (const it of items) {
    const c = it.kind === "Order" && certOf(it);
    if (!c) continue;
    const k = key(it.metadata?.namespace, c);
    const prev = newest.get(k);
    if (
      !prev ||
      String(it.metadata?.creationTimestamp ?? "") > String(prev.metadata?.creationTimestamp ?? "")
    )
      newest.set(k, it);
  }
  const orders = new Map(
    items.filter((it) => it.kind === "Order").map((o) => [key(o.metadata?.namespace, o.metadata?.name), o]),
  );
  const current = (order) => {
    const c = order && certOf(order);
    if (!c) return true;
    const k = key(order.metadata?.namespace, c);
    return !ready.has(k) && newest.get(k) === order;
  };
  const lines = [];
  let failure = "";
  const stuck = [];
  for (const it of items) {
    const name = `${it.metadata?.namespace}/${it.metadata?.name}`;
    const s = it.status ?? {};
    if (it.kind === "Certificate") {
      const ready = (s.conditions ?? []).find((c) => c.type === "Ready");
      lines.push(
        ready?.status === "True"
          ? `сертификат ${name}: готов`
          : `сертификат ${name}: не готов (${ready?.reason ?? "нет статуса"}${ready?.message ? `: ${ready.message}` : ""})`,
      );
    } else if (it.kind === "Challenge" || it.kind === "Order") {
      const order =
        it.kind === "Order"
          ? it
          : orders.get(key(it.metadata?.namespace, it.metadata?.ownerReferences?.[0]?.name ?? ""));
      if (!current(order)) continue;
      const what = it.kind === "Challenge" ? `челлендж ${it.spec?.dnsName ?? name}` : `заказ ${name}`;
      if (it.kind === "Challenge" || s.state !== "valid")
        lines.push(`${what}: ${s.state || "ожидает"}${s.reason ? ` — ${s.reason}` : ""}`);
      if (["errored", "invalid"].includes(s.state)) {
        if (!failure) failure = `${what}: ${s.state}${s.reason ? ` — ${s.reason}` : ""}`;
        const c = order && certOf(order);
        if (c && !stuck.some((x) => x.namespace === it.metadata?.namespace && x.name === c)) {
          const certificate = items.find(
            (x) =>
              x.kind === "Certificate" &&
              x.metadata?.namespace === it.metadata?.namespace &&
              x.metadata?.name === c,
          );
          stuck.push({
            namespace: it.metadata?.namespace,
            name: c,
            conditions: certificate?.status?.conditions ?? [],
          });
        }
      }
    }
  }
  return { lines, failure, stuck };
}

/**
 * Between smoke retries (every 4th, i.e. each 2 minutes): prints the issuance state. When the newest order of a
 * certificate has failed, a new issuance is asked for once per run (what `cmctl renew` does: the Issuing condition) —
 * cert-manager would otherwise back off for an hour after a transient DNS answer (pilot, 2026-10-04); a second failure
 * throws with the DNS-01 solver log instead of 20 minutes of waiting on a self-signed certificate (pilot, 2026-10-03).
 */
export function certificateGate({ kubectl, log = console.log, attempt = 1, retried = new Set() }) {
  if ((attempt - 1) % 4 !== 0) return;
  const { lines, failure, stuck = [] } = certificateReport({ kubectl });
  for (const l of lines) log(`  ${l}`);
  if (!failure) return;
  const fresh = stuck.filter((c) => !retried.has(`${c.namespace}/${c.name}`));
  if (fresh.length) {
    for (const c of fresh) {
      retried.add(`${c.namespace}/${c.name}`);
      const condition = {
        type: "Issuing",
        status: "True",
        reason: "ManuallyTriggered",
        message: "Certificate re-issuance manually triggered by the deploy after a failed order",
        lastTransitionTime: new Date().toISOString(),
      };
      // A failed issuance leaves its Issuing=False condition behind: a second one is a duplicate the API rejects
      // (pilot, 2026-10-04), so the existing condition is replaced.
      const at = (c.conditions ?? []).findIndex((x) => x.type === "Issuing");
      const op =
        at >= 0
          ? { op: "replace", path: `/status/conditions/${at}`, value: condition }
          : {
              op: "add",
              path: (c.conditions ?? []).length ? "/status/conditions/-" : "/status/conditions",
              value: (c.conditions ?? []).length ? condition : [condition],
            };
      const r = kubectl(
        [
          "-n",
          c.namespace,
          "patch",
          "certificate",
          c.name,
          "--subresource=status",
          "--type=json",
          "-p",
          JSON.stringify([op]),
        ],
        { allowFail: true },
      );
      log(
        r?.status === 0 || r?.status === undefined
          ? `  сертификат ${c.namespace}/${c.name}: заказ не прошёл (${failure}) — запрошен новый выпуск`
          : `::warning::сертификат ${c.namespace}/${c.name}: новый выпуск не запрошен — kubectl patch завершился с кодом ${r.status}`,
      );
    }
    return;
  }
  log("::group::Решатель DNS-01");
  kubectl(["-n", "cert-manager", "logs", "deploy/wizard-acme-dns01", "--tail=80"], { allowFail: true });
  log("::endgroup::");
  throw new Error(`сертификаты не выпускаются: ${failure}`);
}

/**
 * Addons of infra/helm/addons/addons.json for a cluster profile and its bases: `profiles` — only with one of them,
 * `exceptProfiles` — never with them (the pilot pulls from GHCR: no in-cluster registry).
 */
export function addonsFor(profile) {
  const chain = profileChain(profile);
  const all = JSON.parse(readFileSync(join(ROOT, "infra/helm/addons/addons.json"), "utf8")).addons;
  return all.filter(
    (a) =>
      (!a.profiles || a.profiles.some((p) => chain.includes(p))) &&
      !(a.exceptProfiles ?? []).some((p) => chain.includes(p)),
  );
}

/**
 * Address of the k3s server the runner talks to: the private one when the runner sits in the environment's VPC
 * (prod), the public one with WIZARD_K3S_ACCESS=public (staging in its own on-demand VPC; the firewall admits only
 * admin_cidrs to 22/6443/30500) or WIZARD_K3S_ACCESS=tunnel (pilot from a GitHub-hosted runner: only SSH is opened,
 * for the runner's address and for the duration of the job; the API server is reached through an SSH tunnel).
 */
export function k3sAddress(server, vars) {
  const ip = ["public", "tunnel"].includes(vars.WIZARD_K3S_ACCESS) ? server.public_ip : server.private_ip;
  if (!ip) throw new Error("k3s_server output has no address for WIZARD_K3S_ACCESS");
  return ip;
}

/** Local end of the SSH tunnel to the k3s API (WIZARD_K3S_ACCESS=tunnel); the k3s certificate covers 127.0.0.1. */
export const TUNNEL_PORT = 16443;

/** Options of every ssh call: the job's key, no prompts, a known_hosts file of its own. */
export function sshBaseArgs(vars, kubeDir) {
  return [
    "-i",
    vars.WIZARD_SSH_KEY_FILE ?? "<WIZARD_SSH_KEY_FILE>",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${join(kubeDir, "known_hosts")}`,
    "-o",
    "ConnectTimeout=10",
  ];
}

/**
 * SSH tunnel 127.0.0.1:TUNNEL_PORT → the k3s API on the server's loopback, as a background control master (`-f`
 * returns once the forward is up); returns the function that closes it. ssh writes its messages to a log file: a
 * backgrounded ssh must not hold the step's output pipes.
 */
export function openTunnel({ run, vars, ip, kubeDir, log = () => {} }) {
  const sock = join(kubeDir, "k3s-tunnel.sock");
  const host = `root@${ip}`;
  run(
    "ssh",
    [
      ...sshBaseArgs(vars, kubeDir),
      "-f",
      "-N",
      "-M",
      "-S",
      sock,
      "-E",
      join(kubeDir, "k3s-tunnel.log"),
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-L",
      `127.0.0.1:${TUNNEL_PORT}:127.0.0.1:6443`,
      host,
    ],
    { stdio: "ignore" },
  );
  log(`туннель к API k3s: 127.0.0.1:${TUNNEL_PORT} → ${ip}`);
  return () => run("ssh", ["-S", sock, "-O", "exit", host], { allowFail: true, stdio: "ignore" });
}

/**
 * kubeconfig of the environment: the `kubeconfig` output (managed Kubernetes) or, for k3s on VMs, fetched over SSH from
 * the server's private address (the runner sits in the same VPC) with the API address rewritten to it. Retries while
 * cloud-init is still installing k3s.
 */
export async function kubeconfigText(
  raw,
  { run, vars, log, dryRun, kubeDir, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 40 },
) {
  if (raw.kubeconfig?.value) return String(raw.kubeconfig.value);
  const server = raw.k3s_server?.value;
  if (!server?.private_ip) throw new Error("provider outputs neither kubeconfig nor k3s_server");
  const ip = k3sAddress(server, vars);
  if (!vars.WIZARD_SSH_KEY_FILE && !dryRun)
    throw new Error("WIZARD_SSH_KEY_FILE is required for k3s environments");
  const args = [...sshBaseArgs(vars, kubeDir), `root@${ip}`, "cat /etc/rancher/k3s/k3s.yaml"];
  const api = vars.WIZARD_K3S_ACCESS === "tunnel" ? `127.0.0.1:${TUNNEL_PORT}` : `${ip}:6443`;
  if (!dryRun) mkdirSync(kubeDir, { recursive: true });
  // A known, running server needs only a few tries (WIZARD_K3S_WAIT_ATTEMPTS from pilot.mjs); a fresh VM installs
  // k3s from cloud-init first. An unreachable node used to burn 16 minutes here (pilot diagnose, 2026-10-03).
  const max = Number(vars.WIZARD_K3S_WAIT_ATTEMPTS) || attempts;
  for (let i = 1; ; i++) {
    const r = run("ssh", args, {
      capture: true,
      allowFail: true,
      // stderr kept: its last line (a timeout, a refused key) goes into the retry message and the error.
      stdio: ["ignore", "pipe", "pipe"],
      fake: "server: https://127.0.0.1:6443\n",
    });
    if (r.status === 0 && r.stdout.includes("server:")) {
      return r.stdout.replace("https://127.0.0.1:6443", `https://${api}`);
    }
    const why =
      String(r.stderr ?? "")
        .trim()
        .split("\n")
        .at(-1) ?? "";
    if (i >= max) {
      const net = /timed out|No route|unreachable/i.test(why);
      throw new Error(
        `k3s on ${ip} is not ready (ssh ${r.status}${why ? `: ${why}` : ""})${
          net
            ? " — сервер не отвечает по сети: проверьте его в панели Timeweb (уведомления, консоль VNC)"
            : ""
        }`,
      );
    }
    log(`k3s на ${ip} ещё не готов (попытка ${i}/${max}${why ? `, ${why}` : ""}), жду 15 с…`);
    await sleep(15_000);
  }
}

/** HTTPS smoke through the public ingress (L3-14, L3-19). */
export async function smoke(domains, log = console.log, f = fetch) {
  const probe = `wz-smoke-${Date.now().toString(36)}`;
  const checks = [
    { url: `https://${domains.platform}/`, status: 200 },
    // platform-api behind the ingress: without a session cookie the API answers 401 (not the web app's 200/404).
    { url: `https://${domains.platform}/api/v1/me`, status: 401 },
    { url: `https://${probe}.${domains.systems}/_wizard/health`, status: 404 },
    { url: `https://${probe}.${domains.systems}/_wizard/internal/reload`, status: 404, method: "POST" },
  ];
  for (const c of checks) {
    let r;
    try {
      r = await f(c.url, {
        method: c.method ?? "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      // fetch says only "fetch failed": the cause (certificate, refused, timeout) is what tells the problem.
      const cause = e?.cause;
      const why = cause ? `${cause.code ?? cause.name ?? ""} ${cause.message ?? ""}`.trim() : (e?.name ?? "");
      throw new Error(
        `smoke ${c.url}: ${e instanceof Error ? e.message : String(e)}${why ? ` (${why})` : ""}`,
      );
    }
    const hsts = r.headers.get("strict-transport-security") ?? "";
    if (r.status !== c.status) throw new Error(`smoke ${c.url}: ${r.status} ≠ ${c.status}`);
    if (!/max-age=\d+/.test(hsts) || !/includeSubDomains/i.test(hsts)) {
      throw new Error(`smoke ${c.url}: HSTS «${hsts}»`);
    }
    log(`ok ${c.method ?? "GET"} ${c.url} → ${r.status}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`infra: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
