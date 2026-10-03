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
export function registrySecret(namespace, name, server, user, token) {
  const auth = Buffer.from(`${user}:${token}`).toString("base64");
  const config = JSON.stringify({ auths: { [server]: { username: user, password: token, auth } } });
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
  // encrypted bundle and a temporary SSH rule; afterKubeconfig({kubectl}); afterRelease({kubectl, outputs, tag}).
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
        if (src && v.WIZARD_GHCR_USER) {
          const registry = raw.env.value?.registry_url ?? "ghcr.io";
          kubectl(["apply", "-f", "-"], {
            input: registrySecret(s.namespace, s.name, registryHost(registry), v.WIZARD_GHCR_USER, src),
          });
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
      if (!o.dryRun && v.WIZARD_GHCR_TOKEN && !deps.skipImageWait) {
        await waitForImages({
          registry: outputs.env.registry_url,
          names: imageNames(),
          tag,
          user: v.WIZARD_GHCR_USER ?? "",
          token: v.WIZARD_GHCR_TOKEN,
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
      await smokeWithRetry(outputs.env.domains, {
        log,
        attempts: Number(v.WIZARD_SMOKE_ATTEMPTS ?? 1) || 1,
        sleep: deps.sleep,
        f: deps.fetch,
      });
    }
    log(o.dryRun ? "--dry-run: команды выше не выполнялись." : `Готово: ${o.env} развёрнут, образы ${tag}.`);
    return 0;
  } finally {
    if (closeTunnel) closeTunnel();
    if (access?.close) await access.close();
  }
}

/**
 * `helm upgrade --install --wait` of the platform with --atomic semantics plus diagnostics: when the release does not
 * become ready, the pods, the events and the logs of the pods that are not ready are printed first (with --atomic
 * they were gone before anyone could look — first live bootstrap, 2026-10-03), then the release goes back to its last
 * deployed revision, or is uninstalled when there is none.
 */
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
      [...env, { name: "WALG_LOG_LEVEL", value: "DEVEL" }, { name: "S3_LOG_LEVEL", value: "DEVEL" }],
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

/** smoke() repeated while certificates are being issued: `attempts` tries 30 s apart. */
export async function smokeWithRetry(
  domains,
  { log = console.log, attempts = 1, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), f = fetch } = {},
) {
  for (let i = 1; ; i++) {
    try {
      await smoke(domains, log, f);
      return;
    } catch (e) {
      if (i >= attempts) throw e;
      log(`smoke: ${e instanceof Error ? e.message : String(e)} — повтор через 30 с (${i}/${attempts})`);
      await sleep(30_000);
    }
  }
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
  for (let i = 1; ; i++) {
    const r = run("ssh", args, { capture: true, allowFail: true, fake: "server: https://127.0.0.1:6443\n" });
    if (r.status === 0 && r.stdout.includes("server:")) {
      return r.stdout.replace("https://127.0.0.1:6443", `https://${api}`);
    }
    if (i >= attempts) throw new Error(`k3s on ${ip} is not ready (ssh ${r.status})`);
    log(`k3s на ${ip} ещё не готов (попытка ${i}/${attempts}), жду 15 с…`);
    await sleep(15_000);
  }
}

/** HTTPS smoke through the public ingress (L3-14, L3-19). */
export async function smoke(domains, log = console.log, f = fetch) {
  const probe = `wz-smoke-${Date.now().toString(36)}`;
  const checks = [
    { url: `https://${domains.platform}/`, status: 200 },
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
