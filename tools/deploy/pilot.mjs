#!/usr/bin/env node
// Pilot on Timeweb Cloud from a GitHub-hosted runner, no self-hosted runner and no hand-made files
// (docs/ops/deploy.md «Пилот: одна кнопка», docs/reviews/impl-notes/pilot-bootstrap.md). The founder sets GitHub
// secrets/variables once (FOUNDER_INPUTS); everything else is created here, idempotently:
//   node tools/deploy/pilot.mjs check --env prod|staging                read-only preflight of the founder inputs
//        (tools/deploy/preflight.mjs): Timeweb token, balance and DNS zones, Cloud.ru, Z.ai, SMTP login, alerts, SPF
//   node tools/deploy/pilot.mjs bootstrap --env prod|staging --tag <sha>   state bucket + keys (Timeweb API) → secrets
//        bundle (generated once, encrypted with WIZARD_STATE_PASSPHRASE, kept in the state bucket) → OpenTofu →
//        temporary SSH rule for this runner's IP → k3s over an SSH tunnel → addons, Secrets, Helm → founder access;
//        after the loss of the VM the same command recreates it (PostgreSQL restores itself from WAL-G, .data is
//        restored by a Job)
//   node tools/deploy/pilot.mjs deploy --env … --tag <sha>      release of a SHA (no OpenTofu apply, no addons)
//   node tools/deploy/pilot.mjs destroy --env staging            staging on demand: everything goes
//   node tools/deploy/pilot.mjs close-access --env …             removes temporary SSH rules (workflow `always()`)
//   node tools/deploy/pilot.mjs show-secrets --env …             founder's laptop only: prints the decrypted bundle
// The heavy lifting is tools/deploy/infra.mjs (main with deps.hooks); this file only adds what the founder used to do
// by hand. Workflows: .github/workflows/bootstrap-pilot.yml, deploy-pilot.yml (owner only, pilot-reusable.yml).
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { objectUrl, putObject, sha256Hex, signRequest } from "../eval/lib/s3.mjs";
import { main as infraMain, NET_PROBE } from "./infra.mjs";
import {
  assertPassphrase,
  clusterSecretFiles,
  decryptBundle,
  encryptBundle,
  ensureBundle,
  MIN_PASSPHRASE,
  secretValues,
} from "./pilot-secrets.mjs";
import { runPreflight, SECRET_NAMES } from "./preflight.mjs";

export const COMMANDS = [
  "check",
  "bootstrap",
  "deploy",
  "destroy",
  "diagnose",
  "reboot",
  "close-access",
  "show-secrets",
];
export const ENVS = ["prod", "staging"];
export const TWC_API = "https://api.timeweb.cloud";
/** Timeweb S3 (only location ru-1): the state bucket, as the backend of infra/tofu/timeweb/envs/*. */
export const S3 = { endpoint: "https://s3.twcstorage.ru", region: "ru-1" };
export const STATE_BUCKET = "wizard-tfstate";
export const bundleKey = (env) => `wizard/${env}.secrets.enc.json`;
/** Description prefix of the temporary SSH rules: everything with it is removed at the start and the end of a job. */
export const TEMP_RULE_PREFIX = "wizard-ci-temp";
export const PLATFORM_NS = "wizard-platform";

/**
 * Shape of the pilot per environment (deploy.yaml#pilot.environments): Cloud MSK 80 for prod, MSK 50 for staging;
 * max_price caps the preset search (growth beyond it is a reviewed change of this table, ≤ 20 000 ₽/month).
 */
export const SHAPES = {
  prod: { server: { cpu: 4, ram_gb: 8, disk_gb: 80, max_price: 2000 }, buckets: { files: 10, backups: 100 } },
  staging: {
    server: { cpu: 2, ram_gb: 4, disk_gb: 50, max_price: 1100 },
    buckets: { files: 10, backups: 10 },
  },
};

/** What the founder sets in GitHub (Settings → Secrets and variables → Actions, repository or environment level). */
export const FOUNDER_INPUTS = {
  secrets: [
    ["TWC_TOKEN", "API-токен Timeweb Cloud (без подтверждения удаления через Telegram)", true],
    ["WIZARD_STATE_PASSPHRASE", `пароль из менеджера паролей, ≥ ${MIN_PASSPHRASE} символов`, true],
    ["CLOUDRU_API_KEY", "ключ Cloud.ru Foundation Models", true],
    ["ZAI_API_KEY", "ключ Z.ai (необязательно)", false],
    ["WIZARD_SMTP_HOST", "SMTP-сервер почты платформы (коды входа)", true],
    ["WIZARD_SMTP_PORT", "порт SMTP (по умолчанию 465)", false],
    ["WIZARD_SMTP_USER", "логин SMTP", false],
    ["WIZARD_SMTP_PASSWORD", "пароль SMTP", false],
    ["WIZARD_SMTP_FROM", "отправитель, например «Wizard <noreply@домен>»", true],
    ["WIZARD_OPS_ALERT_TELEGRAM_TOKEN", "токен бота для алертов (или WIZARD_OPS_ALERT_URL)", false],
    ["WIZARD_OPS_ALERT_CHAT_ID", "чат Telegram для алертов", false],
  ],
  variables: [
    ["WIZARD_PLATFORM_DOMAIN", "домен платформы (в «Доменах» Timeweb Cloud)", true],
    ["WIZARD_SYSTEMS_DOMAIN", "домен систем клиентов (в «Доменах» Timeweb Cloud)", true],
    ["WIZARD_ACME_EMAIL", "почта для Let's Encrypt (по умолчанию — почта основателя)", false],
    ["WIZARD_FOUNDER_EMAIL", "почта основателя: вход, права staff, алерты", true],
  ],
};

const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const SHA = /^[0-9a-f]{40}$/;

export function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  const o = { command, env: null, tag: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--env") o.env = rest[++i] ?? null;
    else if (a === "--tag") o.tag = rest[++i] ?? null;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!COMMANDS.includes(o.command)) throw new Error(`command: ${COMMANDS.join(" | ")}`);
  if (!ENVS.includes(o.env)) throw new Error("--env prod|staging is required");
  if (o.command === "destroy" && o.env !== "staging")
    throw new Error("destroy: only staging (prod is never destroyed)");
  if (["bootstrap", "deploy"].includes(o.command) && !SHA.test(o.tag ?? ""))
    throw new Error("--tag: full commit SHA");
  return o;
}

/**
 * Settings of the target environment. Without GitHub Pro a private repository has no environment-level variables, so
 * staging takes its domains from WIZARD_STAGING_PLATFORM_DOMAIN / WIZARD_STAGING_SYSTEMS_DOMAIN; it never falls back to
 * the prod domains (a staging apply would rewrite the prod DNS records). Problems: [[name, why]].
 */
export function envVars(env, vars) {
  if (env !== "staging") return { vars, problems: [] };
  const problems = [];
  const out = { ...vars };
  for (const [name, from] of [
    ["WIZARD_PLATFORM_DOMAIN", "WIZARD_STAGING_PLATFORM_DOMAIN"],
    ["WIZARD_SYSTEMS_DOMAIN", "WIZARD_STAGING_SYSTEMS_DOMAIN"],
  ]) {
    const v = vars[from] ?? "";
    if (!v)
      problems.push([from, "не задан: отдельный домен staging (домены prod для staging не используются)"]);
    else if (v === vars.WIZARD_PLATFORM_DOMAIN || v === vars.WIZARD_SYSTEMS_DOMAIN)
      problems.push([from, "совпадает с доменом prod"]);
    out[name] = v;
  }
  return { vars: out, problems };
}

/** Missing or malformed founder inputs for a command: [[name, why]] (names only — values are never printed). */
export function checkInputs(command, vars) {
  const problems = [];
  const need = (name, hint) => {
    if (!vars[name]) problems.push([name, `не задан: ${hint}`]);
  };
  need("TWC_TOKEN", "API-токен Timeweb Cloud");
  if (command === "close-access") return problems;
  if (!vars.WIZARD_STATE_PASSPHRASE) need("WIZARD_STATE_PASSPHRASE", "пароль шифрования состояния и ключей");
  else if (vars.WIZARD_STATE_PASSPHRASE.length < MIN_PASSPHRASE)
    problems.push(["WIZARD_STATE_PASSPHRASE", `короче ${MIN_PASSPHRASE} символов`]);
  if (command === "show-secrets") return problems;
  for (const n of ["WIZARD_PLATFORM_DOMAIN", "WIZARD_SYSTEMS_DOMAIN"]) {
    if (!vars[n]) need(n, "домен, добавленный в Timeweb Cloud");
    else if (!DOMAIN.test(vars[n]))
      problems.push([n, "не похоже на домен (только строчные буквы, цифры, точки)"]);
  }
  const p = vars.WIZARD_PLATFORM_DOMAIN ?? "";
  const s = vars.WIZARD_SYSTEMS_DOMAIN ?? "";
  if (p && s && (p === s || p.endsWith(`.${s}`) || s.endsWith(`.${p}`)))
    problems.push([
      "WIZARD_SYSTEMS_DOMAIN",
      "должен быть отдельным доменом, не совпадать с доменом платформы",
    ]);
  if (command === "destroy") return problems;
  for (const [name, hint, required] of [...FOUNDER_INPUTS.secrets, ...FOUNDER_INPUTS.variables]) {
    if (required && !problems.some(([n]) => n === name)) need(name, hint);
  }
  for (const n of ["WIZARD_FOUNDER_EMAIL", "WIZARD_ACME_EMAIL"]) {
    if (vars[n] && !EMAIL.test(vars[n])) problems.push([n, "не похоже на адрес почты"]);
  }
  if (vars.WIZARD_SMTP_PORT && !/^\d{2,5}$/.test(vars.WIZARD_SMTP_PORT))
    problems.push(["WIZARD_SMTP_PORT", "нужен номер порта"]);
  if (vars.WIZARD_OPS_ALERT_TELEGRAM_TOKEN && !vars.WIZARD_OPS_ALERT_CHAT_ID)
    problems.push(["WIZARD_OPS_ALERT_CHAT_ID", "нужен вместе с WIZARD_OPS_ALERT_TELEGRAM_TOKEN"]);
  if (!vars.WIZARD_GHCR_TOKEN && vars.WIZARD_GHCR_ANONYMOUS !== "1")
    problems.push([
      "WIZARD_GHCR_TOKEN",
      "токен GHCR read:packages (или публичные пакеты: WIZARD_GHCR_ANONYMOUS=1)",
    ]);
  return problems;
}

/** Image prefix in GHCR: ghcr.io/<owner, lower case> (WIZARD_IMAGE_REGISTRY overrides). */
export function imageRegistry(vars) {
  if (vars.WIZARD_IMAGE_REGISTRY) return vars.WIZARD_IMAGE_REGISTRY;
  const owner = (vars.GITHUB_REPOSITORY_OWNER ?? "").toLowerCase();
  if (!/^[a-z0-9-]+$/.test(owner)) throw new Error("GITHUB_REPOSITORY_OWNER: нет владельца репозитория");
  return `ghcr.io/${owner}`;
}

/**
 * tfvars of infra/tofu/timeweb/envs/<env> (JSON): the pilot shape, the founder's domains, the generated SSH key.
 * admin_cidrs stays empty — SSH is opened per job by openAdminAccess and closed again, nothing is open in between.
 */
export function tfvars(env, vars, sshPublicKey, server = null) {
  return {
    settings: {
      ...SHAPES[env],
      // A VM the founder handed over (resolvePilotServer): adopted, not created; no region search.
      ...(server ? { existing_server: { id: server.id, ip: server.ip } } : {}),
      sandbox_nodes: {},
      postgres: null,
      image_registry: imageRegistry(vars),
      ssh_public_key: sshPublicKey,
      admin_cidrs: [],
      platform_domain: vars.WIZARD_PLATFORM_DOMAIN,
      systems_domain: vars.WIZARD_SYSTEMS_DOMAIN,
      ...(vars.WIZARD_PLATFORM_MAIL_SPF ? { platform_mail_spf: vars.WIZARD_PLATFORM_MAIL_SPF } : {}),
      // Region of the VM: Moscow (ru-3) unless the GitHub variable WIZARD_TIMEWEB_LOCATION says ru-1 (St Petersburg),
      // e.g. when Moscow answers «No free node» (first live apply, 2026-10-02).
      ...(["ru-1", "ru-3"].includes(vars.WIZARD_TIMEWEB_LOCATION)
        ? { location: vars.WIZARD_TIMEWEB_LOCATION }
        : {}),
      // Zone override (spb-1…spb-5, msk-1): when a preset is refused in the default zone of its location.
      ...(/^(spb-[1-5]|msk-1)$/.test(vars.WIZARD_TIMEWEB_ZONE ?? "")
        ? { zone: vars.WIZARD_TIMEWEB_ZONE }
        : {}),
    },
  };
}

/**
 * Tidy the two zones after OpenTofu (founder, 2026-10-02): Timeweb puts a default SPF and parking A records into a
 * new zone, and the provider's DKIM was first added at the root instead of <selector>._domainkey. Only these are
 * touched, each step checked first and logged (no secrets in DNS values here):
 *   - a root SPF other than ours is deleted once ours exists (two SPF records = SPF permerror);
 *   - root / wildcard A records not pointing at the ingress IP are deleted once one that does exists;
 *   - a root DKIM (v=DKIM1) is copied to <selector>._domainkey and deleted from the root only after the copy exists.
 * DMARC of the platform domain is the founder's and is never created, moved or deleted here.
 */
export async function tidyDns(api, { zones, ingressIp, ourSpf = {}, dkimSelector = "", log = () => {} }) {
  const done = [];
  // The API may give the subdomain short ("*") or full ("*.zone"); both are normalized per zone below.
  const sub = (r, zone) => {
    const v = String(r.data?.subdomain ?? "");
    return v === zone || v === "@" ? "" : v.endsWith(`.${zone}`) ? v.slice(0, -zone.length - 1) : v;
  };
  const val = (r) => String(r.data?.value ?? "").replace(/^"|"$/g, "");
  for (const zone of zones) {
    let records;
    try {
      ({ dns_records: records = [] } = await api("GET", `/api/v1/domains/${zone}/dns-records`));
    } catch (e) {
      log(`::warning title=pilot::DNS ${zone}: список записей недоступен (${e.message})`);
      continue;
    }
    const del = async (r, why) => {
      try {
        await api("DELETE", `/api/v1/domains/${zone}/dns-records/${r.id}`);
        done.push(`${zone}: удалена ${r.type} ${r.data?.subdomain || "@"} «${val(r).slice(0, 40)}» (${why})`);
      } catch (e) {
        log(
          `::warning title=pilot::DNS ${zone}: не удалось удалить ${r.type} ${val(r).slice(0, 40)} (${e.message})`,
        );
      }
    };
    const isRoot = (r) => sub(r, zone) === "";
    const rootTxt = records.filter((r) => r.type === "TXT" && isRoot(r));
    const spf = rootTxt.filter((r) => val(r).startsWith("v=spf1"));
    const ours = ourSpf[zone];
    if (ours && spf.some((r) => val(r) === ours))
      for (const r of spf) if (val(r) !== ours) await del(r, "вторая SPF-запись");
    for (const name of ["", "*"]) {
      const group = records.filter((r) => r.type === "A" && sub(r, zone) === name);
      if (ingressIp && group.some((r) => val(r) === ingressIp))
        for (const r of group) if (val(r) !== ingressIp) await del(r, `A не на сервер ${ingressIp}`);
    }
    const dkim = rootTxt.filter((r) => val(r).startsWith("v=DKIM1"));
    const target = `${dkimSelector}._domainkey.${zone}`;
    const placed = records.find((r) => r.type === "TXT" && sub(r, zone) === `${dkimSelector}._domainkey`);
    if (dkimSelector && dkim.length === 1 && placed) {
      // Already at its name (a rerun, or added in the panel): never a second copy; the root one goes only if equal.
      if (val(placed) === val(dkim[0])) await del(dkim[0], `DKIM уже есть в ${target}`);
    } else if (dkimSelector && dkim.length === 1) {
      try {
        await api("POST", `/api/v1/domains/${zone}/dns-records`, {
          type: "TXT",
          subdomain: target,
          value: val(dkim[0]),
        });
        done.push(`${zone}: DKIM скопирован в ${target}`);
        await del(dkim[0], `DKIM перенесён в ${target}`);
      } catch (e) {
        log(
          `::warning title=pilot::DNS ${zone}: DKIM не перенесён в ${target} (${e.message}) — оставлен в корне`,
        );
      }
    }
  }
  for (const line of done) log(`DNS: ${line}`);
  return done;
}

/**
 * `check`: the VM presets Timeweb offers for the pilot shape in each RF location, and the zones of each location —
 * data for picking a region/zone when a create fails («No free node», «location_zone … is not valid»). Read-only;
 * a failure is a warning.
 */
export async function reportServerOptions(api, shape, { log = () => {} } = {}) {
  try {
    const { server_presets: presets = [] } = await api("GET", "/api/v1/presets/servers");
    const fit = presets
      .filter((p) => String(p.location).startsWith("ru-"))
      .filter((p) => p.cpu === shape.cpu && p.ram === shape.ram_gb * 1024 && p.disk >= shape.disk_gb * 1024)
      .sort((a, b) => a.location.localeCompare(b.location) || a.price - b.price);
    log(
      `Тарифы ВМ ${shape.cpu} vCPU / ${shape.ram_gb} ГБ / от ${shape.disk_gb} ГБ (потолок ${shape.max_price} ₽):`,
    );
    for (const p of fit)
      log(
        `  ${p.location} id=${p.id} ${p.price} ₽ диск ${p.disk / 1024} ГБ ${p.disk_type ?? ""} CPU ${p.cpu_frequency ?? "?"} ГГц «${p.description_short ?? p.description ?? ""}» теги=${JSON.stringify(p.tags ?? [])}`,
      );
    const { locations = [] } = await api("GET", "/api/v2/locations").catch(() => ({ locations: [] }));
    for (const l of locations)
      log(
        `  локация ${l.location ?? l.code ?? JSON.stringify(l).slice(0, 40)}: зоны ${JSON.stringify(l.availability_zones ?? [])}`,
      );
  } catch (e) {
    log(`::warning title=pilot::Тарифы ВМ недоступны (${e.message})`);
  }
  await reportExistingServers(api, { log });
}

/** IPv4 addresses of a Timeweb server (public and VPC). */
function serverIps(s) {
  return (s.networks ?? []).flatMap((n) =>
    (n.ips ?? []).filter((i) => i.type === "ipv4").map((i) => `${n.type}:${i.ip}`),
  );
}

/**
 * Load of a server over the last `hours` and its latest events, from the Timeweb API (check; read-only): tells a hung
 * or overloaded VM (no SSH, no HTTP while the API says "on") from a network problem.
 */
export async function reportServerHealth(
  api,
  server,
  { log = () => {}, now = () => new Date(), hours = 2 } = {},
) {
  const iso = (d) => encodeURIComponent(d.toISOString().slice(0, 19));
  const to = now();
  const from = new Date(to.getTime() - hours * 3600_000);
  try {
    const stats = await api(
      "GET",
      `/api/v1/servers/${server.id}/statistics?date_from=${iso(from)}&date_to=${iso(to)}`,
    );
    for (const [key, rows] of Object.entries(stats)) {
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const tail = rows.slice(-6).map((r) => {
        const at = String(r.logged_at ?? "").slice(11, 16);
        const vals = Object.entries(r)
          .filter(([k, v]) => k !== "logged_at" && typeof v === "number")
          .map(([k, v]) => `${k}=${Math.round(v * 10) / 10}`);
        return `${at} ${vals.join(" ")}`;
      });
      log(`  ${server.id} ${key}: ${tail.join(" | ")}`);
    }
  } catch (e) {
    log(`  ${server.id}: статистика недоступна (${e.message})`);
  }
  try {
    const { server_logs: logs = [] } = await api(
      "GET",
      `/api/v1/servers/${server.id}/logs?limit=8&order=desc`,
    );
    for (const l of logs)
      log(`  ${server.id} событие ${l.logged_at ?? ""} ${l.event ?? JSON.stringify(l).slice(0, 80)}`);
  } catch (e) {
    log(`  ${server.id}: журнал недоступен (${e.message})`);
  }
}

/**
 * Hard reboot of the environment's VM (bootstrap-pilot `reboot`, PROD word): the way back from a hung VM — no SSH,
 * no HTTP while the API says "on" (2026-10-03). PostgreSQL recovers from its WAL on start. Waits until "on" again.
 */
export async function rebootServer(
  api,
  server,
  {
    log = () => {},
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs = 10_000,
    waitMs = 600_000,
  } = {},
) {
  log(`сервер ${server.id} «${server.name ?? ""}»: жёсткая перезагрузка`);
  await api("POST", `/api/v1/servers/${server.id}/action`, { action: "hard_reboot" });
  let seenOff = false;
  for (let waited = 0; waited < waitMs; waited += pollMs) {
    await sleep(pollMs);
    const s = (await api("GET", `/api/v1/servers/${server.id}`)).server?.status;
    if (s !== "on") seenOff = true;
    else if (seenOff || waited >= 60_000) {
      log(`сервер ${server.id}: снова включён`);
      return;
    }
  }
  throw new Error(`сервер ${server.id} не включился за ${waitMs / 60_000} мин после перезагрузки`);
}

/**
 * ACME challenges stuck in deletion (their cleanup kept failing — the DNS-01 solver bug of 2026-10-03) block every
 * new challenge for the same name: cert-manager retries the cleanup only every ~30 minutes. Those deleted more than
 * `minutes` ago lose their finalizer; the TXT records they could have left are the solver's (TTL 120 s) and harmless.
 */
export function releaseStuckChallenges({ kubectl, log = () => {}, now = () => new Date(), minutes = 10 }) {
  const r = kubectl(["get", "challenges.acme.cert-manager.io", "-A", "-o", "json"], {
    capture: true,
    allowFail: true,
    fake: "{}",
  });
  let items = [];
  try {
    items = JSON.parse(r.stdout || "{}").items ?? [];
  } catch {}
  for (const c of items) {
    const since = Date.parse(c.metadata?.deletionTimestamp ?? "");
    if (!Number.isFinite(since) || now().getTime() - since < minutes * 60_000) continue;
    const { name, namespace } = c.metadata;
    log(`ACME: снимаю зависший челлендж ${namespace}/${name} (${c.spec?.dnsName ?? ""})`);
    kubectl(
      [
        "-n",
        namespace,
        "patch",
        "challenges.acme.cert-manager.io",
        name,
        "--type=merge",
        "-p",
        '{"metadata":{"finalizers":[]}}',
      ],
      { allowFail: true },
    );
  }
}

/** Address records of the zones as Timeweb serves them (diagnose; read-only). */
export async function reportDns(api, zones, { log = () => {} } = {}) {
  for (const zone of zones) {
    try {
      const { dns_records: records = [] } = await api("GET", `/api/v1/domains/${zone}/dns-records`);
      for (const r of records.filter((x) => ["A", "AAAA", "CNAME"].includes(x.type)))
        log(`DNS ${zone}: ${r.type} ${r.data?.subdomain || "@"} → ${r.data?.value ?? ""}`);
    } catch (e) {
      log(`::warning title=pilot::DNS ${zone}: список записей недоступен (${e.message})`);
    }
  }
}

/** Public IPv4 of a Timeweb server (its floating IP when it has one). */
export const publicIpv4 = (s) =>
  (s?.networks ?? [])
    .filter((n) => n.type === "public")
    .flatMap((n) => (n.ips ?? []).filter((i) => i.type === "ipv4").map((i) => i.ip))[0] ?? "";

/**
 * The VM the founder handed over to the environment (founder, 2026-10-03), by id or public IP: workflow input
 * `server` (WIZARD_PILOT_SERVER) on the first run, then the encrypted bundle. It must be in the RF and at least the
 * shape of the environment. null → OpenTofu creates the VM.
 */
export async function resolvePilotServer(api, want, shape) {
  if (!want) return null;
  const { servers = [] } = await api("GET", "/api/v1/servers");
  const s = servers.find(
    (x) => String(x.id) === String(want) || serverIps(x).some((i) => i.endsWith(`:${want}`)),
  );
  if (!s) throw new Error(`сервер ${want} не найден в аккаунте Timeweb`);
  const disk = (s.disks ?? []).reduce((a, d) => a + (d.size ?? 0), 0);
  const small = s.cpu < shape.cpu || s.ram < shape.ram_gb * 1024 || disk < shape.disk_gb * 1024;
  if (small)
    throw new Error(
      `сервер ${s.id} меньше нужного: ${s.cpu} vCPU / ${s.ram / 1024} ГБ / ${disk / 1024} ГБ, нужно ${shape.cpu} / ${shape.ram_gb} / ${shape.disk_gb}`,
    );
  if (!String(s.location).startsWith("ru-")) throw new Error(`сервер ${s.id} не в РФ (${s.location})`);
  const ip = publicIpv4(s);
  if (!ip) throw new Error(`у сервера ${s.id} нет публичного IPv4`);
  return { id: Number(s.id), ip, name: s.name, location: s.location };
}

/** The account's existing servers and floating IPs (read-only): candidates for reuse and leftovers of failed runs. */
export async function reportExistingServers(api, { log = () => {} } = {}) {
  try {
    const { servers = [] } = await api("GET", "/api/v1/servers");
    log(`Серверы в аккаунте: ${servers.length}`);
    for (const s of servers) {
      const disk = (s.disks ?? []).reduce((a, d) => a + (d.size ?? 0), 0) / 1024;
      log(
        `  id=${s.id} «${s.name}» ${s.status} ${s.location}/${s.availability_zone ?? "?"} ${s.cpu} vCPU / ${s.ram / 1024} ГБ / ${disk} ГБ ОС ${s.os?.name ?? "?"} ${s.os?.version ?? ""} тариф=${s.preset_id ?? "-"} IP ${serverIps(s).join(", ")}`,
      );
      // Reachability as Timeweb sees it (never the root/VNC passwords of the same object).
      log(
        `    загрузка=${s.boot_mode ?? "?"} старт=${s.start_at ?? "?"} ddos=${s.is_ddos_guard ?? "?"} qemu-agent=${s.is_qemu_agent ?? "?"}`,
      );
      for (const n of s.networks ?? [])
        log(
          `    сеть ${n.type} nat=${n.nat_mode ?? "-"} полоса=${n.bandwidth ?? "?"} ddos=${n.is_ddos_guard ?? "-"} закрытые порты=${JSON.stringify(n.blocked_ports ?? [])}`,
        );
    }
    const { groups = [] } = await api("GET", "/api/v1/firewall/groups?limit=100").catch(() => ({
      groups: [],
    }));
    for (const g of groups) {
      const { rules = [] } = await api("GET", `/api/v1/firewall/groups/${g.id}/rules?limit=100`).catch(
        () => ({
          rules: [],
        }),
      );
      const { resources = [] } = await api(
        "GET",
        `/api/v1/firewall/groups/${g.id}/resources?limit=100`,
      ).catch(() => ({ resources: [] }));
      log(
        `  firewall «${g.name}» политика=${g.policy ?? "?"} ресурсы=${resources.map((r) => `${r.type}:${r.id}`).join(",") || "—"}`,
      );
      for (const r of rules)
        log(`    ${r.direction} ${r.protocol} ${r.port ?? "*"} ${r.cidr ?? ""} «${r.description ?? ""}»`);
    }
    const { ips = [] } = await api("GET", "/api/v1/floating-ips").catch(() => ({ ips: [] }));
    for (const f of ips)
      log(
        `  плавающий IP ${f.ip} ${f.availability_zone ?? ""} привязан к ${f.resource_type ?? "—"} ${f.resource_id ?? ""}`,
      );
  } catch (e) {
    log(`::warning title=pilot::Список серверов недоступен (${e.message})`);
  }
}

/** Timeweb out of capacity for this place (or the preset not offered there): try the next one (founder, 2026-10-02). */
export const CAPACITY_ERROR = /No free node|no available free IPs|location_zone: \S+ is not valid/i;

/**
 * Places for the pilot VM, all in the RF and with the same preset price ceiling: Moscow, then St Petersburg zones.
 * The run starts with the requested one (WIZARD_TIMEWEB_LOCATION / _ZONE), then goes down this list.
 */
export const PLACES = [
  { location: "ru-3", zone: "" },
  { location: "ru-1", zone: "spb-1" },
  { location: "ru-1", zone: "spb-4" },
  { location: "ru-1", zone: "spb-2" },
  { location: "ru-1", zone: "spb-5" },
];

export function placesFrom(vars) {
  const location = vars.WIZARD_TIMEWEB_LOCATION || "ru-3";
  // An empty zone means the module's default for a preset VM: spb-1 in St Petersburg, msk-1 (empty here) in Moscow.
  const first = { location, zone: vars.WIZARD_TIMEWEB_ZONE || (location === "ru-1" ? "spb-1" : "") };
  const rest = PLACES.filter((p) => !(p.location === first.location && p.zone === first.zone));
  return [first, ...rest];
}

export const DMARC_REJECT = "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s";

/**
 * The systems domain never sends mail: DMARC p=reject at _dmarc.<domain>, through the DNS records API (the OpenTofu
 * provider cannot create an underscore name). Best effort: a failure is a warning, never a stopped deploy.
 */
export async function ensureDmarc(api, domain, { log = () => {} } = {}) {
  try {
    const { dns_records: records = [] } = await api("GET", `/api/v1/domains/${domain}/dns-records`);
    if (JSON.stringify(records).includes("v=DMARC1")) return "exists";
    await api("POST", `/api/v1/domains/${domain}/dns-records`, {
      type: "TXT",
      subdomain: `_dmarc.${domain}`,
      value: DMARC_REJECT,
    });
    log(`DNS: _dmarc.${domain} TXT p=reject добавлена`);
    return "created";
  } catch (e) {
    log(
      `::warning title=pilot::DNS: не удалось добавить _dmarc.${domain} (${e.message}) — добавьте TXT «${DMARC_REJECT}» в панели Timeweb`,
    );
    return "failed";
  }
}

/** Timeweb Cloud API client: JSON in/out, bearer token; errors carry the method, path and status, never the token. */
export function twcClient({ token, fetch: f = fetch, base = TWC_API }) {
  return async function api(method, path, body) {
    const r = await f(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (r.status === 204) return {};
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 200);
      try {
        const j = JSON.parse(text);
        msg = [j.error_code, j.message].flat().filter(Boolean).join(": ") || msg;
      } catch {}
      throw new Error(`Timeweb API ${method} ${path.split("?")[0]}: HTTP ${r.status} ${msg}`);
    }
    return text ? JSON.parse(text) : {};
  };
}

/** A bucket's full name carries a random prefix: "1a2b3c4d-wizard-tfstate" (twc_s3_bucket.full_name). */
export const bucketMatches = (full, name) =>
  full === name || new RegExp(`^[0-9a-z]+-${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(full);

/**
 * The state bucket and its S3 keys, created when missing (private, the cheapest hot preset of ru-1). Idempotent: a
 * second run finds it by name. Returns {bucket (full name), accessKeyId, secretAccessKey, created} or null when it is
 * missing and `create` is false.
 */
export async function ensureStateBucket(
  api,
  {
    name = STATE_BUCKET,
    create = true,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    attempts = 20,
    log = () => {},
  } = {},
) {
  const { buckets = [] } = await api("GET", "/api/v1/storages/buckets");
  const found = buckets.filter((b) => bucketMatches(b.name, name));
  if (found.length > 1)
    throw new Error(`несколько бакетов ${name}: оставьте один (${found.map((b) => b.name)})`);
  let b = found[0];
  let created = false;
  if (!b) {
    if (!create) return null;
    const { storages_presets: presets = [] } = await api("GET", "/api/v1/presets/storages");
    const preset = presets
      .filter((p) => p.location === "ru-1" && (p.storage_class ?? "hot") === "hot")
      .sort((x, y) => x.price - y.price || x.disk - y.disk)[0];
    if (!preset) throw new Error("Timeweb API: нет тарифа S3 в ru-1");
    log(`создаю бакет состояния ${name} (тариф ${preset.id})`);
    b = (
      await api("POST", "/api/v1/storages/buckets", {
        name,
        type: "private",
        preset_id: preset.id,
        description: "Wizard: состояние OpenTofu и зашифрованные ключи пилота",
      })
    ).bucket;
    created = true;
  }
  for (let i = 1; b.status !== "created"; i++) {
    if (b.status === "no_paid") throw new Error("бакет состояния не оплачен: пополните баланс Timeweb Cloud");
    if (i > attempts) throw new Error(`бакет ${b.name} не готов (статус ${b.status})`);
    await sleep(15_000);
    b = (await api("GET", `/api/v1/storages/buckets/${b.id}`)).bucket;
  }
  if (!b.access_key || !b.secret_key) throw new Error(`Timeweb API: у бакета ${b.name} нет ключей S3`);
  return {
    bucket: b.name,
    accessKeyId: b.access_key,
    secretAccessKey: b.secret_key,
    created,
    // Timeweb answers GET of a missing key with 403 (S3 semantics without list rights), so an empty bucket — per the
    // API's own count — is what tells "no bundle yet" apart from a real access problem.
    empty: created || b.object_amount === 0,
  };
}

export const stateS3 = (state) => ({
  ...S3,
  bucket: state.bucket,
  accessKeyId: state.accessKeyId,
  secretAccessKey: state.secretAccessKey,
  empty: Boolean(state.empty),
});

/** S3 ListBuckets with a key pair: {names} or {code} (the S3 error code, or HTTP status) — never throws on 4xx. */
export async function listBuckets(cfg, { fetch: f = fetch, now = () => new Date() } = {}) {
  const url = new URL(`${cfg.endpoint}/`);
  const { host: _host, ...headers } = signRequest({
    method: "GET",
    url,
    payloadHash: sha256Hex(""),
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    date: now(),
  });
  const r = await f(url, { method: "GET", headers });
  const text = await r.text();
  if (!r.ok) return { code: s3ErrorCode(text).slice(2, -1) || `HTTP ${r.status}` };
  return { names: [...text.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1]) };
}

/**
 * The state bucket as S3 sees it. The first apply showed that the bucket's own key pair in the Timeweb API is refused
 * by S3 (SignatureDoesNotMatch) and that the API name may lack the random prefix of the real bucket. So: try the
 * bucket's keys, then each storage user's (GET /api/v1/storages/users), and take the first pair whose ListBuckets
 * shows the bucket (the exact name or "<prefix>-<name>"). Errors name each attempt's S3 code, never a key.
 */
export async function resolveStateS3(api, state, { fetch: f = fetch, now, log = () => {}, vars = {} } = {}) {
  const pairs = [
    [
      "ключ S3 аккаунта (секреты AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)",
      vars.WIZARD_S3_ACCOUNT_KEY_ID,
      vars.WIZARD_S3_ACCOUNT_SECRET,
    ],
    ["ключи бакета", state.accessKeyId, state.secretAccessKey],
  ];
  try {
    const { users = [] } = await api("GET", "/api/v1/storages/users");
    for (const u of users) pairs.push([`пользователь хранилища ${u.id}`, u.access_key, u.secret_key]);
  } catch (e) {
    log(`::warning::Timeweb API: пользователи хранилища недоступны (${e.message})`);
  }
  const tried = [];
  for (const [label, rawId, rawSecret] of pairs) {
    const accessKeyId = String(rawId ?? "").trim();
    const secretAccessKey = String(rawSecret ?? "").trim();
    if (!accessKeyId || !secretAccessKey) continue;
    if (tried.some(([, id, sec]) => id === accessKeyId && sec === secretAccessKey)) continue;
    const res = await listBuckets({ ...S3, accessKeyId, secretAccessKey }, { fetch: f, now });
    const bucket = res.names?.find((n) => bucketMatches(n, state.bucket) || bucketMatches(n, STATE_BUCKET));
    tried.push([label, accessKeyId, secretAccessKey, res.code ?? (bucket ? "ok" : "нет бакета в списке")]);
    if (bucket) {
      if (label !== "ключи бакета" || bucket !== state.bucket)
        log(`S3: бакет ${bucket}, доступ через ${label}`);
      return { ...state, bucket, accessKeyId, secretAccessKey };
    }
  }
  const err = new Error(
    `S3 не пускает к бакету ${state.bucket}: ${tried.map(([l, , , c]) => `${l} — ${c}`).join("; ") || "нет ключей"}`,
  );
  err.status = 403; // a just created bucket may need a moment: untilS3Ready retries
  throw err;
}

/** GET of an object, null when it does not exist (404). */
export async function getObjectOrNull(cfg, key, { fetch: f = fetch, now = () => new Date() } = {}) {
  const url = objectUrl(cfg, key);
  const { host: _host, ...headers } = signRequest({
    method: "GET",
    url,
    payloadHash: sha256Hex(""),
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    date: now(),
  });
  const r = await f(url, { method: "GET", headers });
  if (r.status === 404) return null;
  if (r.status === 403 && cfg.empty) return null;
  if (!r.ok) {
    const err = new Error(`S3 GET ${cfg.bucket}/${key}: HTTP ${r.status}${s3ErrorCode(await r.text())}`);
    err.status = r.status;
    throw err;
  }
  return Buffer.from(await r.arrayBuffer()).toString("utf8");
}

/** " (<Code>)" of an S3 XML error body — codes carry no secrets (messages may echo the key id, so they are dropped). */
export function s3ErrorCode(body) {
  const m = /<Code>([A-Za-z]{1,64})<\/Code>/.exec(String(body ?? ""));
  return m ? ` (${m[1]})` : "";
}

/**
 * A just created bucket's S3 keys start working with a delay (the first bootstrap got 403): retry 403 for up to
 * `attempts` × 15 s, then rethrow. Other errors are not retried.
 */
export async function untilS3Ready(
  fn,
  { attempts = 12, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {},
) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e.status !== 403 || i >= attempts) throw e;
      if (i === 1) log("ключи S3 нового бакета ещё не действуют — жду (до 3 мин)");
      await sleep(15_000);
    }
  }
}

/**
 * The environment's bundle: read and decrypted when it exists (a wrong passphrase stops everything — nothing is
 * regenerated or overwritten), otherwise generated when `create`; missing values are added and the result written
 * back and read again. Returns {bundle, existed, added}.
 */
export async function loadBundle({ s3, env, passphrase, create, fetch: f, now, rand, kdf, log = () => {} }) {
  assertPassphrase(passphrase);
  const key = bundleKey(env);
  const text = await getObjectOrNull(s3, key, { fetch: f, now });
  const existing = text ? decryptBundle(text, passphrase, env) : null;
  if (!existing && !create) throw new Error(`нет ключей ${env} (${key}): сначала запустите bootstrap-pilot`);
  const { bundle, added } = ensureBundle(existing, env, { rand, now });
  if (added.length > 0) {
    await saveBundle({ s3, bundle, passphrase, fetch: f, now, rand, kdf });
    log(
      `ключи ${env}: ${existing ? "дополнены" : "созданы"} (${added.join(", ")}), сохранены зашифрованными`,
    );
  }
  return { bundle, existed: Boolean(existing), added };
}

export async function saveBundle({ s3, bundle, passphrase, fetch: f, now, rand, kdf }) {
  const key = bundleKey(bundle.env);
  const text = encryptBundle(bundle, passphrase, { rand, ...(kdf ? { kdf } : {}) });
  await putObject(s3, key, text, { contentType: "application/json", fetch: f, now });
  // Read back as a non-empty bucket: a 403 now is a real access problem, never "missing".
  const back = await getObjectOrNull({ ...s3, empty: false }, key, { fetch: f, now });
  if (!back || JSON.stringify(decryptBundle(back, passphrase, bundle.env)) !== JSON.stringify(bundle))
    throw new Error(`ключи ${bundle.env}: записанный файл не совпал с прочитанным`);
}

/** Public IPv4 of this runner (the temporary SSH rule admits only it). */
export async function runnerIp(f = fetch) {
  for (const url of ["https://api.ipify.org", "https://ipv4.icanhazip.com"]) {
    try {
      const r = await f(url);
      const ip = (await r.text()).trim();
      if (r.ok && /^(\d{1,3})(\.\d{1,3}){3}$/.test(ip) && ip.split(".").every((x) => Number(x) <= 255))
        return ip;
    } catch {}
  }
  throw new Error("не удалось узнать внешний IPv4 раннера");
}

/** Firewall group of the environment's VM (infra/tofu/timeweb/modules/env: "<name_prefix>-nodes"). */
export async function findFirewall(api, env) {
  const { groups = [] } = await api("GET", "/api/v1/firewall/groups?limit=100");
  return groups.find((g) => g.name === `wizard-${env}-nodes`) ?? null;
}

/** Removes every temporary SSH rule of the environment; returns how many. */
export async function closeAdminAccess(api, env, { log = () => {} } = {}) {
  const g = await findFirewall(api, env);
  if (!g) return 0;
  const { rules = [] } = await api("GET", `/api/v1/firewall/groups/${g.id}/rules?limit=100`);
  const temp = rules.filter((r) => String(r.description ?? "").startsWith(TEMP_RULE_PREFIX));
  for (const r of temp) await api("DELETE", `/api/v1/firewall/groups/${g.id}/rules/${r.id}`);
  if (temp.length) log(`SSH закрыт: удалено временных правил — ${temp.length}`);
  return temp.length;
}

/**
 * SSH (tcp/22) to the VM from `ip`/32 only, for this job. Stale temporary rules (a killed job) go first; the k3s API
 * and the registry port are never opened — the API is reached through the SSH tunnel.
 */
export async function openAdminAccess(api, env, ip, { runId = "local", log = () => {} } = {}) {
  const g = await findFirewall(api, env);
  if (!g) throw new Error(`нет firewall wizard-${env}-nodes: OpenTofu его не создал`);
  if (g.policy && g.policy !== "DROP")
    log(
      `::warning::firewall wizard-${env}-nodes: политика ${g.policy}, а не DROP — проверьте в панели Timeweb`,
    );
  await closeAdminAccess(api, env);
  const { rule } = await api("POST", `/api/v1/firewall/groups/${g.id}/rules`, {
    direction: "ingress",
    protocol: "tcp",
    port: "22",
    cidr: `${ip}/32`,
    description: `${TEMP_RULE_PREFIX} ssh run ${runId}`,
  });
  log(`SSH открыт для ${ip}/32 на время задания`);
  return rule?.id ?? null;
}

/**
 * SQL of the founder access (psql variables only, fully qualified names): one founder invitation while the address has
 * no account (beta_readiness gates invitations of partners, not the operator's own account), then is_staff once the
 * founder has signed in. Prints the user id when staff is granted — the Job's exit condition.
 */
/** S3 client debug output without credentials (the Authorization header carries the access key id). */
export const redactS3Log = (text) =>
  String(text ?? "")
    .split("\n")
    .filter((l) => !/^\s*(Authorization|X-Amz-Security-Token):/i.test(l))
    .join("\n");

/**
 * `wal-g backup-list` from inside the running database container. On failure prints what WAL-G did (its stderr, the S3
 * requests it sent — the SDK logs them to stdout, which used to be dropped — and the Go resolver trace), then the
 * same network probe as diagnose from that pod's own network namespace. Returns whether the archive answered.
 */
export function checkArchive({ kubectl, log = console.log, bucket = "" }) {
  const exec = (cmd) =>
    kubectl(["-n", PLATFORM_NS, "exec", "wizard-postgres-0", "-c", "postgres", "--", ...cmd], {
      capture: true,
      allowFail: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const walg = exec([
    "env",
    "WALG_LOG_LEVEL=DEVEL",
    "S3_LOG_LEVEL=DEVEL",
    "GODEBUG=netdns=go+2",
    "timeout",
    "60",
    "wal-g",
    "backup-list",
  ]);
  if (walg.status === 0) {
    log("WAL-G: архив резервных копий доступен");
    return true;
  }
  log("::group::WAL-G backup-list: журнал и запросы S3");
  log(String(walg.stderr ?? "").slice(-4000));
  log(redactS3Log(walg.stdout).slice(-4000));
  log("::endgroup::");
  const probe = exec(["env", `PROBE_BUCKET=${bucket}`, "timeout", "40", "node", "-e", NET_PROBE]);
  log(
    `проба сети из пода postgres: ${`${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim() || `код ${probe.status}`}`,
  );
  log(
    `::warning title=pilot::WAL-G не получил список копий из архива (код ${walg.status}): архивирование WAL не работает, см. лог выше`,
  );
  return false;
}

export const FOUNDER_STAFF_SQL = `
UPDATE platform.pilot_invites SET revoked_at = now()
 WHERE email = lower(:'email') AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now();
INSERT INTO platform.pilot_invites (email, org_name, credits, expires_at)
SELECT lower(:'email'), 'Wizard', 0, now() + interval '30 days'
 WHERE NOT EXISTS (SELECT 1 FROM platform.users u WHERE u.email = lower(:'email') AND u.deleted_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM platform.pilot_invites i
                    WHERE i.email = lower(:'email') AND i.accepted_at IS NULL AND i.revoked_at IS NULL);
UPDATE platform.users SET is_staff = true
 WHERE email = lower(:'email') AND deleted_at IS NULL
RETURNING id;
`;

const FOUNDER_STAFF_LOOP = [
  "while :; do",
  '  out="$(printf "%s" "$FOUNDER_SQL" | psql -X -q -A -t -v ON_ERROR_STOP=1 -1 -v email="$FOUNDER_EMAIL" -f -)" && [ -n "$out" ] && {',
  '    echo \'{"level":"info","svc":"pilot","msg":"founder_staff_granted"}\'; exit 0; }',
  "  sleep 30",
  "done",
].join("\n");

export const FOUNDER_JOB = "wizard-founder-staff";

/**
 * One-off Job that waits for the founder's first sign-in and makes the account staff (MFA is enrolled on the first
 * visit of /admin). Runs as a pg-job pod (NetworkPolicy wizard-pg-job: only the database), image wizard-postgres.
 */
export function founderStaffJob({ image, email, pullSecret = "wizard-ghcr" }) {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: FOUNDER_JOB,
      namespace: PLATFORM_NS,
      labels: { "app.kubernetes.io/part-of": "wizard" },
    },
    spec: {
      backoffLimit: 30,
      activeDeadlineSeconds: 30 * 24 * 3600,
      template: {
        metadata: { labels: { "wizard.ru/role": "pg-job", "app.kubernetes.io/part-of": "wizard" } },
        spec: {
          restartPolicy: "OnFailure",
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          imagePullSecrets: [{ name: pullSecret }],
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 999,
            runAsGroup: 999,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "grant",
              image,
              imagePullPolicy: "IfNotPresent",
              command: ["sh", "-c", FOUNDER_STAFF_LOOP],
              env: [
                { name: "PGHOST", value: `wizard-postgres.${PLATFORM_NS}.svc` },
                { name: "PGPORT", value: "5432" },
                { name: "PGUSER", value: "wizard" },
                { name: "PGDATABASE", value: "wizard" },
                {
                  name: "PGPASSWORD",
                  valueFrom: { secretKeyRef: { name: "wizard-postgres", key: "POSTGRES_PASSWORD" } },
                },
                { name: "FOUNDER_EMAIL", value: email },
                { name: "FOUNDER_SQL", value: FOUNDER_STAFF_SQL },
              ],
              resources: {
                requests: { cpu: "10m", memory: "16Mi" },
                limits: { cpu: "200m", memory: "64Mi" },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
            },
          ],
        },
      },
    },
  };
}

const emailMark = (email) =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);

/** Non-secret next steps for the job summary (Russian, no addresses, no values). */
export function summaryText({ env, command, domains, tag, state }) {
  const url = `https://${domains.platform}`;
  const lines = [`## Пилот ${env}: ${command === "destroy" ? "удалён" : "готово"}`, ""];
  if (command === "destroy")
    return [...lines, "Окружение и его бакеты удалены. Ключи остаются в бакете состояния."].join("\n");
  lines.push(`- Платформа: ${url}/`, `- Версия: \`${tag}\``, "");
  if (state.restored)
    lines.push(
      "**ВМ была пересоздана.** PostgreSQL поднят из архива WAL-G, том `.data` восстановлен из копии. Проверьте последние изменения клиентов.",
      "",
    );
  if (state.bundleCreated)
    lines.push(
      "- Ключи окружения созданы и зашифрованы паролем `WIZARD_STATE_PASSPHRASE`. Держите его в менеджере паролей: без него архив базы не расшифровать.",
    );
  if (state.staff === "pending")
    lines.push(
      `- Откройте ${url}/login и войдите с почтой из \`WIZARD_FOUNDER_EMAIL\`: код придёт письмом.`,
      `- Через минуту после первого входа учётка получит права staff. Откройте ${url}/admin и включите MFA (приложение-аутентификатор), коды восстановления сохраните.`,
    );
  else if (state.staff === "done") lines.push(`- Консоль модерации: ${url}/admin (вход с MFA).`);
  else lines.push("- `WIZARD_FOUNDER_EMAIL` не задан: права staff не выдавались.");
  if (env === "staging")
    lines.push("- Staging оплачивается по часам: удалите его через bootstrap-pilot → destroy.");
  return lines.join("\n");
}

function mask(values, vars, log) {
  if (vars.GITHUB_ACTIONS !== "true") return;
  for (const v of values) if (v && String(v).length >= 6) log(`::add-mask::${v}`);
}

/**
 * Read-only state probe of `check`: the state bucket (never created, never waited for) and, when the environment's keys
 * exist, whether WIZARD_STATE_PASSPHRASE decrypts them. Returns {status, detail}.
 */
export async function checkState(api, env, vars, { fetch: f = fetch, now, log = () => {} } = {}) {
  const state = await ensureStateBucket(api, { create: false, attempts: 0 });
  if (!state)
    return { status: "skipped", detail: `бакета ${STATE_BUCKET} ещё нет: его создаст первый apply` };
  mask([state.accessKeyId, state.secretAccessKey], vars, log);
  const resolved = await resolveStateS3(api, state, { fetch: f, now, log, vars });
  mask([resolved.accessKeyId, resolved.secretAccessKey], vars, log);
  const text = await getObjectOrNull(stateS3(resolved), bundleKey(env), { fetch: f, now });
  if (!text) return { status: "ok", detail: `бакет есть, ключей ${env} ещё нет: их создаст первый apply` };
  decryptBundle(text, vars.WIZARD_STATE_PASSPHRASE, env);
  return { status: "ok", detail: `пароль подходит к ключам ${env}` };
}

/**
 * Entry: returns the exit code. deps (tests): fetch, now, rand, sleep, log, run/has/exists (passed to infra.mjs),
 * infraMain, skipSmoke, kdf.
 */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const o = parseArgs(argv);
  const target = o.command === "close-access" ? { vars: env, problems: [] } : envVars(o.env, env);
  const vars = target.vars;
  const log = deps.log ?? ((s) => console.log(s));
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const rand = deps.rand ?? randomBytes;
  if (o.command === "check") {
    mask(
      SECRET_NAMES.map((n) => vars[n]),
      vars,
      log,
    );
    const api = twcClient({ token: vars.TWC_TOKEN, fetch: f });
    await reportServerOptions(api, SHAPES[o.env].server, { log });
    const { servers = [] } = await api("GET", "/api/v1/servers").catch(() => ({ servers: [] }));
    for (const s of servers) await reportServerHealth(api, s, { log, now });
    return runPreflight({
      env: o.env,
      vars,
      inputProblems: checkInputs("bootstrap", vars),
      stagingProblems: target.problems,
      stateProbe: () => checkState(api, o.env, vars, { fetch: f, now, log }),
      fetch: f,
      smtp: deps.smtp,
      log,
      summary: (text) => vars.GITHUB_STEP_SUMMARY && appendFileSync(vars.GITHUB_STEP_SUMMARY, text),
    });
  }
  const problems = [...target.problems, ...checkInputs(o.command, vars)];
  if (problems.length > 0) {
    const text = problems.map(([n, why]) => `  - ${n}: ${why}`).join("\n");
    log(
      `::error title=pilot::Не хватает настроек GitHub (docs/ops/deploy.md «Что нужно от основателя»):\n${text}`,
    );
    if (vars.GITHUB_STEP_SUMMARY)
      appendFileSync(vars.GITHUB_STEP_SUMMARY, `## Пилот: не хватает настроек\n\n${text}\n`);
    return 2;
  }
  const api = twcClient({ token: vars.TWC_TOKEN, fetch: f });
  if (o.command === "close-access") {
    await closeAdminAccess(api, o.env, { log });
    return 0;
  }

  const state = await ensureStateBucket(api, { create: o.command === "bootstrap", sleep: deps.sleep, log });
  if (!state) {
    log(`::error title=pilot::Нет бакета ${STATE_BUCKET}: сначала запустите bootstrap-pilot для ${o.env}.`);
    return 3;
  }
  mask([state.accessKeyId, state.secretAccessKey], vars, log);
  const resolved = await untilS3Ready(() => resolveStateS3(api, state, { fetch: f, now, log, vars }), {
    sleep: deps.sleep,
    log,
  });
  mask([resolved.accessKeyId, resolved.secretAccessKey], vars, log);
  const s3 = stateS3(resolved);
  const passphrase = vars.WIZARD_STATE_PASSPHRASE;
  log(`бакет состояния: ${resolved.bucket}${state.created ? " (создан сейчас)" : ""}`);
  const { bundle, existed } = await untilS3Ready(
    () =>
      loadBundle({
        s3,
        env: o.env,
        passphrase,
        create: o.command === "bootstrap",
        fetch: f,
        now,
        rand,
        kdf: deps.kdf,
        log,
      }),
    { sleep: deps.sleep, log },
  );
  mask(secretValues(bundle), vars, log);
  if (o.command === "show-secrets") {
    if (vars.GITHUB_ACTIONS === "true")
      throw new Error("show-secrets: только на компьютере основателя, не в CI");
    process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
    return 0;
  }

  const work = join(vars.RUNNER_TEMP || deps.tmpRoot || tmpdir(), `wizard-pilot-${o.env}`);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const file = (name, text) => {
    const p = join(work, name);
    writeFileSync(p, text, { mode: 0o600 });
    chmodSync(p, 0o600);
    return p;
  };
  const server = await resolvePilotServer(
    api,
    vars.WIZARD_PILOT_SERVER || bundle.server?.id,
    SHAPES[o.env].server,
  );
  if (server) {
    log(
      `сервер окружения: ${server.id} «${server.name}» ${server.location}, ${server.ip} (передан основателем)`,
    );
    if (bundle.server?.id !== server.id || bundle.server?.ip !== server.ip) {
      bundle.server = { id: server.id, ip: server.ip };
      await saveBundle({ s3, bundle, passphrase, fetch: f, now, rand, kdf: deps.kdf });
    }
  }
  if (o.command === "reboot") {
    if (!server)
      throw new Error("reboot: у окружения нет переданного сервера (WIZARD_PILOT_SERVER или bootstrap)");
    await rebootServer(api, server, { log, sleep: deps.sleep });
    return 0;
  }
  const sshKey = file("id_ed25519", bundle.secrets.SSH_PRIVATE_KEY);
  const varFile = file(
    "pilot.tfvars.json",
    JSON.stringify(tfvars(o.env, vars, bundle.secrets.SSH_PUBLIC_KEY, server), null, 2),
  );
  const ivars = {
    ...vars,
    WIZARD_PROVIDER: "timeweb",
    WIZARD_TF_STATE_BUCKET: resolved.bucket,
    WIZARD_TF_STATE_ACCESS_KEY_ID: resolved.accessKeyId,
    WIZARD_TF_STATE_SECRET_ACCESS_KEY: resolved.secretAccessKey,
    WIZARD_TF_STATE_PASSPHRASE: passphrase,
    WIZARD_TFVARS_FILE: varFile,
    WIZARD_SSH_KEY_FILE: sshKey,
    WIZARD_K3S_ACCESS: "tunnel",
    WIZARD_ACME_EMAIL: vars.WIZARD_ACME_EMAIL || vars.WIZARD_FOUNDER_EMAIL || "",
    // First certificates over DNS-01 (TXT propagation + Let's Encrypt) may take more than 10 minutes: 40 × 30 s.
    WIZARD_SMOKE_ATTEMPTS: vars.WIZARD_SMOKE_ATTEMPTS || "40",
    // Never released yet → the database starts empty without asking the archive (it cannot hold anything).
    WIZARD_PG_FIRST_BOOT: bundle.deployedAt ? "" : "1",
    // SSH waits: a fresh VM installs k3s from cloud-init (40 × ~25 s); a server that has run a release only needs to
    // answer; diagnose looks at a running cluster.
    WIZARD_K3S_WAIT_ATTEMPTS: o.command === "diagnose" ? "4" : bundle.deployedAt ? "12" : "40",
    RUNNER_TEMP: work,
  };

  const st = { bundleCreated: !existed, fresh: false, restored: false, staff: "none", outputs: null };
  const founder = (vars.WIZARD_FOUNDER_EMAIL ?? "").trim().toLowerCase();
  const hooks = {
    beforeCluster: async (outputs) => {
      st.outputs = outputs;
      mask(
        Object.values(outputs.s3_keys ?? {}).flatMap((k) => [k?.access_key, k?.secret_key]),
        vars,
        log,
      );
      const files = clusterSecretFiles({ bundle, outputs, inputs: vars });
      mkdirSync(join(work, "pgbouncer"), { recursive: true, mode: 0o700 });
      const extra = {
        WIZARD_PLATFORM_ENV_FILE: file("platform.env", files.platformEnv),
        WIZARD_POSTGRES_ENV_FILE: file("postgres.env", files.postgresEnv),
        WIZARD_DNS_SOLVER_ENV_FILE: file("dns-solver.env", files.dnsSolverEnv),
        WIZARD_PGBOUNCER_SECRET_DIR: join(work, "pgbouncer"),
      };
      file(join("pgbouncer", "userlist.txt"), files.userlist);
      const ip = await runnerIp(f);
      await openAdminAccess(api, o.env, ip, { runId: vars.GITHUB_RUN_ID, log });
      return { vars: extra, close: () => closeAdminAccess(api, o.env, { log }) };
    },
    afterKubeconfig: async ({ kubectl }) => {
      // A listing, not a `get` of one namespace: an unreachable API must fail here, never read as "fresh cluster"
      // (that would restore .data over live files).
      const names = String(kubectl(["get", "namespaces", "-o", "name"], { capture: true }).stdout ?? "");
      if (!names.includes("namespace/")) throw new Error("kubectl: пустой список пространств имён");
      st.fresh = !names.split(/\s+/).includes(`namespace/${PLATFORM_NS}`);
      if (st.fresh)
        log(st.bundleCreated ? "кластер новый: первый выкат" : "кластер пустой при существующих ключах");
      if (!st.fresh) releaseStuckChallenges({ kubectl, log, now });
    },
    afterRelease: async ({ kubectl, outputs, tag }) => {
      let changed = false;
      // DNS before the smoke: records that are not ours (a parked A on the root, a duplicate SPF) would send part of
      // the checks elsewhere (6th live bootstrap, 2026-10-03: the root still had the founder's other VM).
      if (o.command === "bootstrap") {
        await ensureDmarc(api, vars.WIZARD_SYSTEMS_DOMAIN, { log });
        await tidyDns(api, {
          zones: [vars.WIZARD_PLATFORM_DOMAIN, vars.WIZARD_SYSTEMS_DOMAIN],
          ingressIp: outputs.env?.ingress_ip,
          ourSpf: {
            [vars.WIZARD_SYSTEMS_DOMAIN]: "v=spf1 -all",
            ...(vars.WIZARD_PLATFORM_MAIL_SPF
              ? { [vars.WIZARD_PLATFORM_DOMAIN]: `v=spf1 ${vars.WIZARD_PLATFORM_MAIL_SPF} -all` }
              : {}),
          },
          dkimSelector: vars.WIZARD_PLATFORM_DKIM_SELECTOR || "",
          log,
        });
      }
      // WAL-G against the archive from the running database (not fatal: archiving lag is alerted by pg-ops anyway).
      checkArchive({ kubectl, log, bucket: outputs.env?.buckets?.backups ?? "" });
      // Lost VM: PostgreSQL has restored itself from WAL-G (init container); bring .data back from its copy.
      if (st.fresh && bundle.deployedAt) {
        const job = `wizard-data-restore-${Math.floor(now().getTime() / 1000)}`;
        log("ВМ пересоздана: восстанавливаю .data из копии в бакете backups");
        kubectl(["-n", PLATFORM_NS, "create", "job", `--from=cronjob/wizard-data-restore`, job]);
        kubectl(["-n", PLATFORM_NS, "wait", "--for=condition=complete", `job/${job}`, "--timeout=30m"]);
        kubectl(["-n", PLATFORM_NS, "rollout", "restart", "deployment"]);
        st.restored = true;
      }
      if (founder) {
        const mark = emailMark(founder);
        if (bundle.founderStaff === mark) st.staff = "done";
        else {
          const r = kubectl(
            ["-n", PLATFORM_NS, "get", "job", FOUNDER_JOB, "-o", "jsonpath={.status.succeeded}"],
            { capture: true, allowFail: true },
          );
          if (r.status === 0 && String(r.stdout).trim() === "1") {
            bundle.founderStaff = mark;
            changed = true;
            st.staff = "done";
          } else {
            kubectl(["-n", PLATFORM_NS, "delete", "job", FOUNDER_JOB, "--ignore-not-found"]);
            const image = `${outputs.env.registry_url}/wizard-postgres:${tag}`;
            kubectl(["apply", "-f", "-"], {
              input: JSON.stringify(founderStaffJob({ image, email: founder })),
            });
            st.staff = "pending";
          }
        }
      }
      if (!bundle.deployedAt) {
        bundle.deployedAt = now().toISOString();
        changed = true;
      }
      if (changed) await saveBundle({ s3, bundle, passphrase, fetch: f, now, rand, kdf: deps.kdf });
    },
  };

  const command = { bootstrap: "apply", deploy: "deploy", destroy: "destroy", diagnose: "diagnose" }[
    o.command
  ];
  if (o.command === "diagnose")
    await reportDns(api, [vars.WIZARD_PLATFORM_DOMAIN, vars.WIZARD_SYSTEMS_DOMAIN], { log });
  const args = [command, "--env", o.env, "--yes", ...(o.tag ? ["--tag", o.tag] : [])];
  const runInfra = () =>
    (deps.infraMain ?? infraMain)(args, ivars, {
      log,
      hooks,
      run: deps.run,
      has: deps.has,
      exists: deps.exists,
      sleep: deps.sleep,
      fetch: deps.fetch,
      skipSmoke: deps.skipSmoke,
      skipImageWait: deps.skipImageWait,
    });
  // Bootstrap only: when Timeweb has no capacity at the requested place, the next RF place is tried with the same
  // preset ceiling (OpenTofu replaces the floating IP and the VPC; nothing is paid twice).
  const places = o.command === "bootstrap" && !server ? placesFrom(vars) : [null];
  let code;
  for (let i = 0; ; i++) {
    try {
      code = await runInfra();
      break;
    } catch (e) {
      const next = places[i + 1];
      if (!next || !CAPACITY_ERROR.test(e?.output ?? "")) throw e;
      log(
        `::warning title=pilot::Timeweb: нет мощностей в ${places[i].location}${places[i].zone ? `/${places[i].zone}` : ""} — пробую ${next.location}${next.zone ? `/${next.zone}` : ""}`,
      );
      file(
        "pilot.tfvars.json",
        JSON.stringify(
          tfvars(
            o.env,
            { ...vars, WIZARD_TIMEWEB_LOCATION: next.location, WIZARD_TIMEWEB_ZONE: next.zone },
            bundle.secrets.SSH_PUBLIC_KEY,
          ),
          null,
          2,
        ),
      );
    }
  }
  if (code === 0) {
    const text = summaryText({
      env: o.env,
      command: o.command,
      domains: { platform: vars.WIZARD_PLATFORM_DOMAIN },
      tag: o.tag,
      state: st,
    });
    log(text);
    if (vars.GITHUB_STEP_SUMMARY) appendFileSync(vars.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`::error title=pilot::${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
