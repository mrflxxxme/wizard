#!/usr/bin/env node
// Local rehearsal of the pilot on the developer's machine (docs/ops/local-rehearsal.md): the same images, the same
// Helm chart and value layers, the same addons and post-release checks as tools/deploy/pilot.mjs — on a k3s node in
// Docker instead of the Timeweb VM. Needs only Docker (helm runs in a container, kubectl from Docker Desktop or PATH).
//   node tools/deploy/local.mjs up [--tag <sha>] [--observability]   build what is missing, start, release, check
//   node tools/deploy/local.mjs smoke | status
//   node tools/deploy/local.mjs down [--purge]                       stop; --purge also drops volumes and keys
// State (keys, CA, kubeconfig) lives in .data/local (git-ignored). Nothing here touches GHCR, Timeweb or real mail.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addonArgs,
  addonsFor,
  createRunner,
  gvisorProbe,
  imageNames,
  ROOT,
  releaseWizard,
  smoke,
  wizardReleaseArgs,
} from "./infra.mjs";
import { checkArchive, FOUNDER_JOB, founderStaffJob, PLATFORM_NS } from "./pilot.mjs";
import { clusterSecretFiles, ensureBundle } from "./pilot-secrets.mjs";

export const NET = {
  name: "wizard-local",
  subnet: "198.18.0.0/24",
  node: "198.18.0.2",
  s3: "198.18.0.3",
  mail: "198.18.0.4",
};
export const C = { node: "wizard-local-k3s", s3: "wizard-local-minio", mail: "wizard-local-mail" };
export const DOMAINS = { platform: "wizard.localhost", systems: "wsys.localhost" };
export const BUCKETS = { files: "wizard-files", backups: "wizard-backups" };
export const FOUNDER = "founder@wizard.localhost";
const K3S_IMAGE = "wizard-local/k3s-node:v1.34.1-k3s1";
const HELM_IMAGE = "alpine/helm:3.19.0";
const MINIO_IMAGE = "minio/minio:RELEASE.2025-04-22T22-12-26Z";
const MC_IMAGE = "minio/mc:RELEASE.2025-04-16T18-13-26Z";
const MAIL_IMAGE = "axllent/mailpit:v1.27";
const OPENSSL_IMAGE = (tag) => `wizard-local/wizard-postgres:${tag}`;
const STATE = join(ROOT, ".data", "local");
const KUBECONFIG = join(STATE, "kubeconfig");
const CA_CONFIGMAP = "wizard-local-ca";
const mcHost = (state) => `http://${state.s3.user}:${state.s3.password}@${NET.s3}:443`;

const log = (s) => console.log(s);
const run = createRunner({ log });
const quiet = (cmd, args, o = {}) => run(cmd, args, { capture: true, allowFail: true, ...o });
const docker = (args, o) => run("docker", args, o);
const kubectl = (args, o = {}) => run("kubectl", args, { ...o, env: { KUBECONFIG, ...o.env } });
const helm = (args, o = {}) =>
  docker(
    [
      "run",
      "--rm",
      ...(o.input !== undefined ? ["-i"] : []),
      "--network",
      `container:${C.node}`,
      "-v",
      `${ROOT}:/repo`,
      "-v",
      `${STATE}:/state`,
      "-v",
      "wizard-local-helm-cache:/root/.cache/helm",
      "-w",
      "/repo",
      "-e",
      "KUBECONFIG=/state/kubeconfig",
      HELM_IMAGE,
      ...args,
    ],
    o,
  );

export function parseArgs(argv) {
  const [command = "up", ...rest] = argv;
  const o = { command, tag: "", observability: false, purge: false, systemId: "" };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (command === "secrets" && !o.systemId && !a.startsWith("--")) o.systemId = a;
    else if (a === "--tag") o.tag = rest[++i] ?? "";
    else if (a === "--observability") o.observability = true;
    else if (a === "--purge") o.purge = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!["up", "down", "smoke", "status", "secrets"].includes(command))
    throw new Error("command: up | down | smoke | status | secrets <systemId>");
  return o;
}

/** tofu-shaped outputs of the rehearsal: what wizardReleaseArgs and clusterSecretFiles read on the VM. */
export function localOutputs() {
  return {
    env: {
      postgres_mode: "in-cluster",
      registry_url: "wizard-local",
      s3_endpoint: `http://${NET.s3}:443`,
      buckets: BUCKETS,
      domains: DOMAINS,
      network: { pods_cidr: "10.42.0.0/16", services_cidr: "10.43.0.0/16", nodes_cidr: NET.subnet },
    },
  };
}

const exists = (kind, name) => quiet("docker", [kind, "inspect", name]).status === 0;
const running = (name) =>
  quiet("docker", ["inspect", "-f", "{{.State.Running}}", name]).stdout?.trim() === "true";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Keys of the rehearsal: the pilot's generated bundle (env "local") plus the MinIO account. Kept in .data/local. */
function loadState() {
  mkdirSync(STATE, { recursive: true });
  const file = join(STATE, "secrets.json");
  const old = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  const { bundle } = ensureBundle(old, "local");
  bundle.s3 ??= {
    user: `wizard${Date.now().toString(36)}`,
    password: randomBytes(24).toString("hex"),
  };
  writeFileSync(file, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  return bundle;
}

/**
 * Local CA and leaf certificates (platform, systems wildcard, SMTP of Mailpit) made with openssl of the db image. The CA
 * is name-constrained to the rehearsal domains and network: even when someone trusts ca.crt in their system, ca.key
 * cannot mint certificates for other sites. Mailpit mounts only mail/ (its own pair), not the keys of .data/local.
 */
function ensureCertificates(tag) {
  if (existsSync(join(STATE, "mail", "mail.crt"))) return;
  const constraints = [
    `DNS:${DOMAINS.platform}`,
    `DNS:${DOMAINS.systems}`,
    "DNS:mail.wizard.localhost",
    "IP:198.18.0.0/255.255.255.0",
  ]
    .map((n) => `permitted;${n}`)
    .join(",");
  const leaf = (name, san) =>
    `openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ${name}.key -subj "/CN=${name}" -out ${name}.csr && ` +
    `printf "subjectAltName=${san}\\nextendedKeyUsage=serverAuth\\n" > ${name}.ext && ` +
    `openssl x509 -req -in ${name}.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 -sha256 -extfile ${name}.ext -out ${name}.crt`;
  const script = [
    "set -e; cd /w",
    `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ca.key -days 825 -subj "/CN=Wizard local rehearsal CA" -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign -addext "nameConstraints=critical,${constraints}" -out ca.crt`,
    leaf("platform", `DNS:${DOMAINS.platform},DNS:*.${DOMAINS.platform}`),
    leaf("systems", `DNS:${DOMAINS.systems},DNS:*.${DOMAINS.systems}`),
    leaf("mail", `IP:${NET.mail},DNS:mail.wizard.localhost`),
    "rm -f *.csr *.ext *.srl; mkdir -p mail; mv mail.crt mail.key mail/; chmod 600 *.key; chmod 644 *.crt mail/*",
  ].join("\n");
  docker([
    "run",
    "--rm",
    // Docker Desktop maps bind-mount owners to the host user; native Linux docker needs the caller's uid for the keys.
    "--user",
    process.platform === "win32" ? "0" : `${process.getuid?.()}:${process.getgid?.()}`,
    "-v",
    `${STATE}:/w`,
    "--entrypoint",
    "sh",
    OPENSSL_IMAGE(tag),
    "-c",
    script,
  ]);
}

/**
 * Build context = the working tree as git would commit it: a temporary index takes every tracked and untracked
 * non-ignored file (core.autocrlf normalises CRLF to LF on add), checkout-index writes it out unconverted. A Windows
 * checkout (autocrlf=true) would otherwise bake CRLF sources into the images, unlike CI — G1-RENDER-01 then fails at
 * M1+ on anchors of packages/sdk. The working tree and the real index are not touched.
 */
function lfSnapshot() {
  const dir = join(STATE, "build-context");
  const index = join(STATE, "build-context.index");
  rmSync(dir, { recursive: true, force: true });
  rmSync(index, { force: true });
  mkdirSync(STATE, { recursive: true });
  const env = { GIT_INDEX_FILE: index };
  run("git", ["add", "-A", "--", "."], { env, capture: true });
  run(
    "git",
    ["-c", "core.autocrlf=false", "checkout-index", "-a", "-f", `--prefix=${dir.replaceAll("\\", "/")}/`],
    { env, capture: true },
  );
  rmSync(index, { force: true });
  return dir;
}

function ensureImages(tag) {
  const missing = imageNames().filter((n) => !exists("image", `wizard-local/${n}:${tag}`));
  if (missing.length) {
    const ctx = lfSnapshot();
    const args = ["tools/deploy/images.mjs", "build", "--registry", "wizard-local", "--tag", tag];
    const r = spawnSync(process.execPath, [...args, "--only", missing.join(",")], {
      cwd: ctx,
      stdio: "inherit",
    });
    rmSync(ctx, { recursive: true, force: true });
    if (r.status !== 0) throw new Error(`сборка образов: код ${r.status}`);
  }
  if (!exists("image", K3S_IMAGE))
    docker(["build", "-f", "infra/local/k3s-node.Dockerfile", "-t", K3S_IMAGE, "."]);
}

/** Docker side: network, MinIO with both buckets, Mailpit, the k3s node. Idempotent. */
async function ensureContainers(state) {
  if (!exists("network", NET.name)) docker(["network", "create", "--subnet", NET.subnet, NET.name]);
  // Keys reach the containers through the environment of `docker` (`-e NAME` without a value), never through argv.
  const keys = {
    MINIO_ROOT_USER: state.s3.user,
    MINIO_ROOT_PASSWORD: state.s3.password,
    MC_HOST_l: mcHost(state),
  };
  // A container is reused only while its arguments are the same (label = their hash); otherwise it is recreated —
  // volumes keep the data, so changed ports, mounts or images take effect without `down`.
  const start = (name, args) => {
    const spec = createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16);
    const label = `wizard.local/spec=${spec}`;
    if (exists("container", name)) {
      const have = quiet("docker", ["inspect", "-f", '{{index .Config.Labels "wizard.local/spec"}}', name]);
      if (have.stdout?.trim() !== spec) docker(["rm", "-f", name]);
      else if (running(name)) return;
      else return void docker(["start", name]);
    }
    docker(
      [
        "run",
        "-d",
        "--name",
        name,
        "--label",
        label,
        "--restart",
        "unless-stopped",
        "--network",
        NET.name,
        ...args,
      ],
      { env: keys },
    );
  };
  start(C.s3, [
    "--ip",
    NET.s3,
    "-p",
    "127.0.0.1:9101:9001",
    "-v",
    "wizard-local-minio:/data",
    "-e",
    "MINIO_ROOT_USER",
    "-e",
    "MINIO_ROOT_PASSWORD",
    MINIO_IMAGE,
    "server",
    "/data",
    "--address",
    ":443",
    "--console-address",
    ":9001",
  ]);
  start(C.mail, [
    "--ip",
    NET.mail,
    "-p",
    "127.0.0.1:8025:8025",
    "-v",
    `${join(STATE, "mail")}:/certs:ro`,
    "-e",
    "MP_SMTP_TLS_CERT=/certs/mail.crt",
    "-e",
    "MP_SMTP_TLS_KEY=/certs/mail.key",
    "-e",
    "MP_SMTP_REQUIRE_STARTTLS=true",
    "-e",
    "MP_SMTP_BIND_ADDR=0.0.0.0:587",
    MAIL_IMAGE,
  ]);
  start(C.node, [
    "--ip",
    NET.node,
    "--hostname",
    C.node,
    "--privileged",
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/var/run",
    // This machine only: the rehearsal is not a LAN service (its founder login and sandbox would be reachable).
    "-p",
    "127.0.0.1:80:80",
    "-p",
    "127.0.0.1:443:443",
    "-p",
    "127.0.0.1:6443:6443",
    "-v",
    "wizard-local-k3s:/var/lib/rancher/k3s",
    K3S_IMAGE,
    "server",
    "--disable=traefik",
    "--secrets-encryption",
    "--write-kubeconfig-mode=644",
    "--cluster-cidr=10.42.0.0/16",
    "--service-cidr=10.43.0.0/16",
    "--tls-san=127.0.0.1",
    "--node-label=wizard.ru/pool=free",
    "--node-label=wizard.ru/sandbox-node=true",
  ]);
  for (let i = 0; ; i++) {
    const r = quiet(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        NET.name,
        "-e",
        "MC_HOST_l",
        MC_IMAGE,
        "mb",
        "-p",
        `l/${BUCKETS.files}`,
        `l/${BUCKETS.backups}`,
      ],
      { env: keys },
    );
    if (r.status === 0) break;
    if (i > 20) throw new Error(`MinIO: бакеты не созданы: ${r.stderr}`);
    await sleep(2000);
  }
  for (let i = 0; ; i++) {
    const r = quiet("docker", ["exec", C.node, "cat", "/etc/rancher/k3s/k3s.yaml"]);
    if (r.status === 0 && r.stdout.includes("server:")) {
      writeFileSync(KUBECONFIG, r.stdout, { mode: 0o600 });
      if (
        kubectl(["wait", "--for=condition=Ready", "node", "--all", "--timeout=10s"], {
          allowFail: true,
          capture: true,
        }).status === 0
      )
        break;
    }
    if (i > 60) throw new Error("k3s: узел не стал Ready за 3 минуты");
    await sleep(3000);
  }
}

/** Images of this tag into the node's containerd (what the VM pulls from GHCR). Only missing ones are copied. */
function importImages(tag) {
  const out = quiet("docker", ["exec", C.node, "ctr", "-n", "k8s.io", "images", "ls", "-q"]).stdout ?? "";
  // Exact refs: a commit tag is a prefix of its -wip tags, a substring match would skip a missing image.
  const have = new Set(out.split(/\r?\n/).map((l) => l.trim()));
  const refs = imageNames()
    .map((n) => `wizard-local/${n}:${tag}`)
    .filter((r) => !have.has(`docker.io/${r}`));
  if (!refs.length) return;
  const tar = join(STATE, "images.tar");
  docker(["save", "-o", tar, ...refs]);
  docker(["cp", tar, `${C.node}:/tmp/images.tar`]);
  rmSync(tar, { force: true });
  docker(["exec", C.node, "ctr", "-n", "k8s.io", "images", "import", "/tmp/images.tar"]);
  docker(["exec", C.node, "rm", "-f", "/tmp/images.tar"]);
}

function applySecret(namespace, name, from) {
  const yaml = kubectl(
    ["-n", namespace, "create", "secret", ...from, name, "--dry-run=client", "-o", "yaml"],
    {
      capture: true,
    },
  ).stdout;
  kubectl(["apply", "-f", "-"], { input: yaml });
}

/**
 * Optional founder inputs of the rehearsal: .data/local/inputs.env with the same names as the GitHub secrets of the
 * pilot (CLOUDRU_API_KEY, ZAI_API_KEY, WIZARD_TELEGRAM_BOT_TOKEN, …; pilot-secrets.mjs PLATFORM_PASSTHROUGH).
 */
export function readInputs(file = join(STATE, "inputs.env")) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m?.[2]) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/** Live models when a provider key is given (as the pilot's prod), else the golden fixture runs (pilot staging). */
export const llmModeOf = (inputs) => (inputs.CLOUDRU_API_KEY || inputs.ZAI_API_KEY ? "live" : "fixture");

/**
 * Secrets of the pilot (platform env, database, PgBouncer), built by the pilot's own code from the local keys, plus the
 * two TLS Secrets of the local CA. No DNS-01 solver Secret: the rehearsal has no ACME (values-local.yaml tls.solver).
 */
function clusterSecrets(bundle, founderInputs) {
  const inputs = {
    ...founderInputs,
    WIZARD_S3_ACCOUNT_KEY_ID: bundle.s3.user,
    WIZARD_S3_ACCOUNT_SECRET: bundle.s3.password,
    WIZARD_SMTP_HOST: NET.mail,
    WIZARD_SMTP_PORT: "587",
    WIZARD_SMTP_TLS: "starttls",
    WIZARD_SMTP_FROM: `Wizard <noreply@${DOMAINS.platform}>`,
    WIZARD_FOUNDER_EMAIL: FOUNDER,
  };
  const f = clusterSecretFiles({ bundle, outputs: localOutputs(), inputs });
  writeFileSync(join(STATE, "platform.env"), f.platformEnv, { mode: 0o600 });
  writeFileSync(join(STATE, "postgres.env"), f.postgresEnv, { mode: 0o600 });
  mkdirSync(join(STATE, "pgbouncer"), { recursive: true });
  writeFileSync(join(STATE, "pgbouncer", "userlist.txt"), f.userlist, { mode: 0o600 });
  applySecret(PLATFORM_NS, "wizard-platform-env", [
    "generic",
    `--from-env-file=${join(STATE, "platform.env")}`,
  ]);
  applySecret(PLATFORM_NS, "wizard-postgres", ["generic", `--from-env-file=${join(STATE, "postgres.env")}`]);
  applySecret(PLATFORM_NS, "wizard-pgbouncer", ["generic", `--from-file=${join(STATE, "pgbouncer")}`]);
  for (const name of ["platform", "systems"])
    applySecret(PLATFORM_NS, `wizard-${name}-tls`, [
      "tls",
      `--cert=${join(STATE, `${name}.crt`)}`,
      `--key=${join(STATE, `${name}.key`)}`,
    ]);
}

/**
 * DNS of the rehearsal domains inside the cluster, as on the VM: the platform and every <slug>.<systems> resolve to the
 * node's address (on the VM — its floating IP), so pods reach them through the ingress like a visitor. Without it
 * `*.localhost` resolves to the pod's own loopback and the post-publish smoke of the worker fails (ECONNREFUSED
 * 127.0.0.1:443). k3s CoreDNS imports `*.server` keys of the ConfigMap coredns-custom as extra server blocks.
 */
export function corednsCustom() {
  const block = (zone) =>
    `${zone}:53 {\n  template IN A ${zone} {\n    answer "{{ .Name }} 60 IN A ${NET.node}"\n  }\n  template IN AAAA ${zone} {\n    rcode NOERROR\n  }\n}\n`;
  return JSON.stringify({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "coredns-custom", namespace: "kube-system" },
    data: { "wizard-local.server": block(DOMAINS.platform) + block(DOMAINS.systems) },
  });
}

/**
 * The local CA for the Node services (Mailpit STARTTLS): ConfigMap CA_CONFIGMAP mounted read-only by the chart through
 * extraCa.configMap (values-local.yaml), NODE_EXTRA_CA_CERTS points at it. Off in every real environment.
 */
function applyCaConfigMap() {
  const yaml = kubectl(
    [
      "-n",
      PLATFORM_NS,
      "create",
      "configmap",
      CA_CONFIGMAP,
      `--from-file=ca.crt=${join(STATE, "ca.crt")}`,
      "--dry-run=client",
      "-o",
      "yaml",
    ],
    { capture: true },
  ).stdout;
  kubectl(["apply", "-f", "-"], { input: yaml });
}

/**
 * First bring-up of the database = the WAL-G archive in the backups bucket is empty (the rule of pg-ops), not the
 * Helm history: a lost node volume next to a kept MinIO must restore, not initdb beside an old archive.
 */
function archiveEmpty(state) {
  const r = quiet(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      NET.name,
      "-e",
      "MC_HOST_l",
      MC_IMAGE,
      "ls",
      "--recursive",
      `l/${BUCKETS.backups}/pg/`,
    ],
    { env: { MC_HOST_l: mcHost(state) } },
  );
  if (r.status !== 0 && !/not exist|Object does not exist/i.test(r.stderr ?? ""))
    throw new Error(`MinIO: архив не прочитан: ${r.stderr}`);
  return !String(r.stdout ?? "").trim();
}

/**
 * Image tag of the working tree: the commit (as images.yml tags it) or, with uncommitted changes, commit + a hash of
 * them — a rehearsal of work in progress rebuilds only when the sources really changed.
 */
export function workTreeTag() {
  const git = (args) => run("git", args, { capture: true }).stdout;
  const sha = git(["rev-parse", "--short=12", "HEAD"]).trim();
  const diff = git(["diff", "HEAD", "--binary"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    // tool state of agent sessions, not sources
    .filter((f) => f && !/(^|\/)\.omc\//.test(f));
  if (!diff && !untracked.length) return sha;
  const h = createHash("sha256").update(diff);
  for (const f of untracked.sort()) h.update(f).update(readFileSync(join(ROOT, f)));
  return `${sha}-wip${h.digest("hex").slice(0, 8)}`;
}

async function up(o) {
  const tag = o.tag || workTreeTag();
  ensureImages(tag);
  const bundle = loadState();
  ensureCertificates(tag);
  await ensureContainers(bundle);
  importImages(tag);
  kubectl(["apply", "-f", "infra/k8s/namespaces.yaml"]);
  const observability = new Set(["metrics", "logs", "logs-collector"]);
  for (const a of addonsFor("pilot"))
    if (o.observability || !observability.has(a.name)) helm(addonArgs(a, "pilot"));
  const inputs = readInputs();
  clusterSecrets(bundle, inputs);
  const history = helm(["history", "wizard", "-n", PLATFORM_NS, "-o", "json"], {
    capture: true,
    allowFail: true,
  });
  const firstBoot = archiveEmpty(bundle);
  if (firstBoot && history.status === 0) log("Архив WAL-G пуст: база поднимется заново (initdb)");
  applyCaConfigMap();
  kubectl(["apply", "-f", "-"], { input: corednsCustom() });
  const args = wizardReleaseArgs({
    env: "staging",
    out: localOutputs(),
    tag,
    email: FOUNDER,
    provider: {},
    profile: "pilot",
    firstBoot,
  });
  args.push("-f", "infra/local/values-local.yaml", "--set-string", `config.llmMode=${llmModeOf(inputs)}`);
  log(
    `Модели: ${llmModeOf(inputs) === "live" ? "живые ключи из .data/local/inputs.env" : "золотые фикстуры (ключей нет)"}`,
  );
  releaseWizard({ helm, kubectl, args, log });
  kubectl(["-n", PLATFORM_NS, "rollout", "status", "deployment", "--timeout=10m"]);
  const sandboxOk = gvisorProbe({ kubectl, image: `wizard-local/wizard-sandbox:${tag}`, log });
  checkArchive({ kubectl, log, bucket: BUCKETS.backups });
  const staff = kubectl(["-n", PLATFORM_NS, "get", "job", FOUNDER_JOB, "-o", "name"], {
    capture: true,
    allowFail: true,
  });
  if (staff.status !== 0) {
    const job = founderStaffJob({
      image: `wizard-local/wizard-postgres:${tag}`,
      email: FOUNDER,
      pullSecret: "",
    });
    // Images are in the node's containerd already: no pull secret (an empty name is rejected by the API).
    delete job.spec.template.spec.imagePullSecrets;
    kubectl(["apply", "-f", "-"], { input: JSON.stringify(job) });
  }
  const smokeOk = runSmoke();
  log(summary({ tag, sandboxOk, smokeOk }));
  return smokeOk && sandboxOk ? 0 : 1;
}

/**
 * Operator step the product has no screen for yet: test PROD values for every secret:// reference of a system's
 * draft spec (G2-SECRET-02 at publish). Runs inside the platform-api pod with its own config and SecretStore — what the
 * founder would have to do on the pilot server. Values are synthetic («rehearsal-<name>»), never real keys.
 */
export const SECRETS_SCRIPT = `
import { createDb, loadConfig, SecretStore } from "/app/apps/platform-api/src/index.ts";
const systemId = process.env.SYSTEM_ID;
const config = loadConfig(process.env);
const h = createDb(config.dbUrl, 1);
const [s] = await h.pg\`select s.org_id, r.spec from platform.systems s
  join platform.revisions r on r.system_id = s.id and r.version = s.draft_revision where s.id = \${systemId}\`;
if (!s) throw new Error("system not found");
const names = [...new Set(JSON.stringify(s.spec).match(/secret:\\/\\/[a-z0-9_]+/g) ?? [])].map((r) => r.slice(9));
const store = new SecretStore(config.secretsFile, config.secretsKey);
await h.db.transaction().execute(async (trx) => {
  for (const name of names)
    await store.put(trx, { orgId: s.org_id, systemId, env: "prod", name, value: "rehearsal-" + name });
});
console.log("prod secrets: " + names.join(", "));
process.exit(0);
`;

function systemSecrets(systemId) {
  if (!/^[0-9a-f-]{36}$/.test(systemId ?? "")) throw new Error("secrets <systemId>: нужен uuid системы");
  const pod = kubectl(
    [
      "-n",
      PLATFORM_NS,
      "get",
      "pods",
      "-l",
      "wizard.ru/role=platform-api",
      "-o",
      "jsonpath={.items[0].metadata.name}",
    ],
    { capture: true },
  ).stdout.trim();
  kubectl(
    [
      "-n",
      PLATFORM_NS,
      "exec",
      "-i",
      pod,
      "--",
      "sh",
      "-c",
      `cat > /tmp/secrets.mjs && SYSTEM_ID=${systemId} node --import tsx /tmp/secrets.mjs; rc=$?; rm -f /tmp/secrets.mjs; exit $rc`,
    ],
    { input: SECRETS_SCRIPT },
  );
  return 0;
}

/** smoke() of the pilot in a child process: Node reads NODE_EXTRA_CA_CERTS (the local CA) only at startup. */
function runSmoke() {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "smoke"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: join(STATE, "ca.crt") },
  });
  return r.status === 0;
}

export function summary({ tag, sandboxOk, smokeOk }) {
  return [
    "",
    `Локальная репетиция пилота: образы ${tag}`,
    `  smoke через ingress: ${smokeOk ? "ok" : "ОШИБКА"} · песочница gVisor: ${sandboxOk ? "ok" : "ОШИБКА"}`,
    `  платформа:  https://${DOMAINS.platform}/  (сертификат локального CA: .data/local/ca.crt)`,
    `  системы:    https://<slug>.${DOMAINS.systems}/`,
    "  почта:      http://127.0.0.1:8025  (Mailpit: коды входа и приглашения)",
    "  S3:         http://127.0.0.1:9101  (MinIO; ключи — .data/local/secrets.json)",
    `  вход основателя: ${FOUNDER} — код придёт в Mailpit; права staff выдаст Job ${FOUNDER_JOB}`,
    `  kubectl:    KUBECONFIG=.data/local/kubeconfig kubectl -n ${PLATFORM_NS} get pods`,
  ].join("\n");
}

function down(o) {
  for (const c of Object.values(C)) if (exists("container", c)) docker(["rm", "-f", c]);
  if (o.purge) {
    for (const v of ["wizard-local-k3s", "wizard-local-minio"]) quiet("docker", ["volume", "rm", v]);
    rmSync(STATE, { recursive: true, force: true });
  }
  if (exists("network", NET.name)) quiet("docker", ["network", "rm", NET.name]);
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.command === "up") return up(o);
  if (o.command === "down") return down(o);
  if (o.command === "secrets") return systemSecrets(o.systemId);
  if (o.command === "smoke") {
    await smoke(DOMAINS, log);
    return 0;
  }
  kubectl(["get", "nodes,pods", "-A", "-o", "wide"]);
  kubectl(["get", "certificates", "-A"], { allowFail: true });
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`local: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
