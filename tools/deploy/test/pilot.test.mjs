// Pilot from a GitHub-hosted runner (tools/deploy/pilot.mjs, pilot-secrets.mjs): founder inputs, the secrets bundle
// (generated once, encrypted, reused), the state bucket and the temporary SSH rule through a fake Timeweb API and a
// fake S3, the whole bootstrap/deploy/DR flow with a fake tofu/ssh/kubectl/helm. No cloud calls.
import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fakePlatform } from "../../eval/test/fake-platform.mjs";
import {
  bucketMatches,
  checkInputs,
  closeAdminAccess,
  ensureDmarc,
  ensureDnsRecords,
  ensureStateBucket,
  ensureUnisenderDomain,
  envVars,
  FOUNDER_STAFF_SQL,
  FOUNDER_START_CREDITS,
  founderStaffJob,
  getObjectOrNull,
  main,
  PROBE_IN_POD,
  parseArgs,
  placesFrom,
  platformDnsRecords,
  resolveStateS3,
  runCounted,
  SERVER_STOCK_PROBE,
  SHAPES,
  s3ErrorCode,
  serverStockLine,
  serverStockProbe,
  stockKeysOfRelease,
  stockLibraryOutputs,
  summaryText,
  tfvars,
  tidyDns,
  twcClient,
  untilS3Ready,
  v3OrgsOfServer,
} from "../pilot.mjs";
import {
  alertSettings,
  clusterSecretFiles,
  decryptBundle,
  encryptBundle,
  ensureBundle,
  envFile,
  GENERATED,
  pilotMailDomain,
  pilotPipelineEnv,
  pilotStockEnv,
  pilotStockMode,
  STOCK_EGRESS_HOSTS,
  STOCK_KEY_ENV,
  secretValues,
  sshKeyPair,
} from "../pilot-secrets.mjs";

const FAST = { name: "scrypt", N: 1024, r: 8, p: 1 };
const PASS = "correct horse battery staple 42";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const tmp = mkdtempSync(join(tmpdir(), "wizard-pilot-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const FOUNDER = {
  TWC_TOKEN: "twc-very-secret-token",
  WIZARD_STATE_PASSPHRASE: PASS,
  CLOUDRU_API_KEY: "cloudru-secret-key",
  ZAI_API_KEY: "",
  WIZARD_SMTP_HOST: "smtp.example.ru",
  WIZARD_SMTP_PORT: "465",
  WIZARD_SMTP_USER: "noreply@codename.ru",
  WIZARD_SMTP_PASSWORD: "smtp-secret-password",
  WIZARD_SMTP_FROM: "Wizard <noreply@codename.ru>",
  WIZARD_OPS_ALERT_TELEGRAM_TOKEN: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc",
  WIZARD_OPS_ALERT_CHAT_ID: "-100123",
  WIZARD_PLATFORM_DOMAIN: "codename.ru",
  WIZARD_SYSTEMS_DOMAIN: "neutral.ru",
  WIZARD_ACME_EMAIL: "",
  WIZARD_FOUNDER_EMAIL: "Founder@Example.ru",
  WIZARD_GHCR_USER: "founder",
  WIZARD_GHCR_TOKEN: "ghs_job_token_value",
  GITHUB_REPOSITORY_OWNER: "Owner",
  GITHUB_ACTIONS: "true",
  GITHUB_RUN_ID: "777",
};

describe("pilot: founder inputs", () => {
  it("arguments: command, env, full SHA; destroy only for staging", () => {
    expect(parseArgs(["bootstrap", "--env", "prod", "--tag", SHA])).toMatchObject({ command: "bootstrap" });
    expect(() => parseArgs(["deploy", "--env", "prod", "--tag", "abc"])).toThrow(/SHA/);
    expect(() => parseArgs(["destroy", "--env", "prod"])).toThrow(/staging/);
    expect(() => parseArgs(["bootstrap", "--env", "qa", "--tag", SHA])).toThrow(/--env/);
    expect(parseArgs(["close-access", "--env", "staging"]).command).toBe("close-access");
    expect(parseArgs(["check", "--env", "prod"])).toMatchObject({ command: "check", tag: null });
  });

  it("names every missing or malformed input, never a value", () => {
    expect(checkInputs("bootstrap", FOUNDER)).toEqual([]);
    const names = checkInputs("bootstrap", {}).map(([n]) => n);
    for (const n of [
      "TWC_TOKEN",
      "WIZARD_STATE_PASSPHRASE",
      "CLOUDRU_API_KEY",
      "WIZARD_SMTP_HOST",
      "WIZARD_SMTP_FROM",
      "WIZARD_PLATFORM_DOMAIN",
      "WIZARD_SYSTEMS_DOMAIN",
      "WIZARD_FOUNDER_EMAIL",
      "WIZARD_GHCR_TOKEN",
    ])
      expect(names).toContain(n);
    expect(names).not.toContain("ZAI_API_KEY");
    expect(names).not.toContain("WIZARD_ACME_EMAIL");
    const bad = checkInputs("bootstrap", {
      ...FOUNDER,
      WIZARD_STATE_PASSPHRASE: "short",
      WIZARD_SYSTEMS_DOMAIN: "sys.codename.ru",
      WIZARD_FOUNDER_EMAIL: "nobody",
      WIZARD_OPS_ALERT_CHAT_ID: "",
    });
    expect(bad.map(([n]) => n).sort()).toEqual([
      "WIZARD_FOUNDER_EMAIL",
      "WIZARD_OPS_ALERT_CHAT_ID",
      "WIZARD_STATE_PASSPHRASE",
      "WIZARD_SYSTEMS_DOMAIN",
    ]);
    expect(JSON.stringify(bad)).not.toContain("short");
    // close-access needs only the API token; destroy no mail or models.
    expect(checkInputs("close-access", { TWC_TOKEN: "t" })).toEqual([]);
    expect(
      checkInputs("destroy", {
        TWC_TOKEN: "t",
        WIZARD_STATE_PASSPHRASE: PASS,
        WIZARD_PLATFORM_DOMAIN: "a.ru",
        WIZARD_SYSTEMS_DOMAIN: "b.ru",
      }),
    ).toEqual([]);
  });

  it("staging never reuses the prod domains (no environment-level variables without GitHub Pro)", () => {
    expect(envVars("prod", FOUNDER)).toEqual({ vars: FOUNDER, problems: [] });
    const none = envVars("staging", FOUNDER);
    expect(none.problems.map(([n]) => n)).toEqual([
      "WIZARD_STAGING_PLATFORM_DOMAIN",
      "WIZARD_STAGING_SYSTEMS_DOMAIN",
    ]);
    expect(none.vars.WIZARD_PLATFORM_DOMAIN).toBe("");
    const same = envVars("staging", {
      ...FOUNDER,
      WIZARD_STAGING_PLATFORM_DOMAIN: FOUNDER.WIZARD_PLATFORM_DOMAIN,
      WIZARD_STAGING_SYSTEMS_DOMAIN: "stage-s.ru",
    });
    expect(same.problems).toEqual([["WIZARD_STAGING_PLATFORM_DOMAIN", "совпадает с доменом prod"]]);
    const ok = envVars("staging", {
      ...FOUNDER,
      WIZARD_STAGING_PLATFORM_DOMAIN: "stage-p.ru",
      WIZARD_STAGING_SYSTEMS_DOMAIN: "stage-s.ru",
    });
    expect(ok.problems).toEqual([]);
    expect([ok.vars.WIZARD_PLATFORM_DOMAIN, ok.vars.WIZARD_SYSTEMS_DOMAIN]).toEqual([
      "stage-p.ru",
      "stage-s.ru",
    ]);
  });

  it("tfvars: the pilot shape, generated SSH key, GHCR of the owner, no admin CIDRs", () => {
    const t = tfvars("prod", FOUNDER, "ssh-ed25519 AAAA test");
    expect(t.settings).toEqual({
      server: SHAPES.prod.server,
      buckets: { files: 10, backups: 100 },
      sandbox_nodes: {},
      postgres: null,
      image_registry: "ghcr.io/owner",
      ssh_public_key: "ssh-ed25519 AAAA test",
      admin_cidrs: [],
      platform_domain: "codename.ru",
      systems_domain: "neutral.ru",
    });
    expect(tfvars("staging", FOUNDER, "k").settings.server).toEqual({
      cpu: 2,
      ram_gb: 4,
      disk_gb: 50,
      max_price: 1100,
    });
  });
});

describe("pilot: secrets bundle", () => {
  it("generated once: a second ensure keeps every value, only missing ones are added", () => {
    const { bundle, added } = ensureBundle(null, "prod");
    expect(added).toEqual([...Object.keys(GENERATED), "SSH_PRIVATE_KEY", "SSH_PUBLIC_KEY"]);
    expect(bundle.secrets.WALG_LIBSODIUM_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.secrets.WIZARD_SECRETS_KEY.length).toBeGreaterThanOrEqual(32);
    expect(bundle.secrets.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
    const again = ensureBundle(bundle, "prod");
    expect(again.added).toEqual([]);
    expect(again.bundle).toEqual(bundle);
    const partial = structuredClone(bundle);
    delete partial.secrets.WIZARD_DATA_BACKUP_KEY;
    const fixed = ensureBundle(partial, "prod");
    expect(fixed.added).toEqual(["WIZARD_DATA_BACKUP_KEY"]);
    expect(fixed.bundle.secrets.WALG_LIBSODIUM_KEY).toBe(bundle.secrets.WALG_LIBSODIUM_KEY);
    expect(() => ensureBundle(bundle, "staging")).toThrow(/bundle of prod/);
  });

  it("encrypted with the passphrase and bound to the environment; a wrong passphrase or tampering is an error", () => {
    const { bundle } = ensureBundle(null, "staging");
    const text = encryptBundle(bundle, PASS, { kdf: FAST });
    for (const v of secretValues(bundle)) expect(text).not.toContain(v);
    expect(JSON.parse(text)).toMatchObject({
      format: "wizard-secrets-v1",
      env: "staging",
      cipher: "aes-256-gcm",
    });
    expect(decryptBundle(text, PASS, "staging")).toEqual(bundle);
    expect(() => decryptBundle(text, `${PASS}!`, "staging")).toThrow(/WIZARD_STATE_PASSPHRASE не тот/);
    expect(() => decryptBundle(text, PASS, "prod")).toThrow(/окружения staging/);
    // Relabelled envelope: the environment is authenticated data.
    const relabelled = JSON.stringify({ ...JSON.parse(text), env: "prod" });
    expect(() => decryptBundle(relabelled, PASS, "prod")).toThrow(/не тот/);
    const e = JSON.parse(text);
    const data = Buffer.from(e.data, "base64");
    data[0] ^= 1;
    expect(() =>
      decryptBundle(JSON.stringify({ ...e, data: data.toString("base64") }), PASS, "staging"),
    ).toThrow();
    expect(() => encryptBundle(bundle, "short")).toThrow(/не короче 16/);
    // The default cost is the real one (128 MiB scrypt).
    expect(JSON.parse(encryptBundle(bundle, PASS)).kdf).toMatchObject({ N: 131072, r: 8, p: 1 });
  });

  it("SSH key: OpenSSH format whose public half matches the private seed", () => {
    const k = sshKeyPair("wizard-pilot-prod");
    expect(k.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ wizard-pilot-prod$/);
    const b64 = k.privateKey.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    const body = Buffer.from(b64, "base64");
    let at = 0;
    const magic = body.subarray(0, 15).toString("latin1");
    at = 15;
    const str = () => {
      const n = body.readUInt32BE(at);
      const s = body.subarray(at + 4, at + 4 + n);
      at += 4 + n;
      return s;
    };
    expect(magic).toBe("openssh-key-v1\0");
    expect([str().toString(), str().toString(), str().length]).toEqual(["none", "none", 0]);
    expect(body.readUInt32BE(at)).toBe(1);
    at += 4;
    const pubBlob = str();
    expect(pubBlob.toString("base64")).toBe(k.publicKey.split(" ")[1]);
    const priv = str();
    expect(at).toBe(body.length);
    expect(priv.length % 8).toBe(0);
    expect(priv.readUInt32BE(0)).toBe(priv.readUInt32BE(4));
    let p = 8;
    const pstr = () => {
      const n = priv.readUInt32BE(p);
      const s = priv.subarray(p + 4, p + 4 + n);
      p += 4 + n;
      return s;
    };
    expect(pstr().toString()).toBe("ssh-ed25519");
    const pub = pstr();
    const secret = pstr();
    expect(pstr().toString()).toBe("wizard-pilot-prod");
    expect(secret.subarray(32)).toEqual(pub);
    const key = createPrivateKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        d: secret.subarray(0, 32).toString("base64url"),
        x: pub.toString("base64url"),
      },
      format: "jwk",
    });
    const sig = sign(null, Buffer.from("probe"), key);
    const pk = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: pub.toString("base64url") },
      format: "jwk",
    });
    expect(verify(null, Buffer.from("probe"), pk, sig)).toBe(true);
  });

  const hasKeygen = spawnSync("sh", ["-c", "command -v ssh-keygen"]).status === 0;
  it.skipIf(!hasKeygen)("SSH key: ssh-keygen reads the private key and derives the same public key", () => {
    const k = sshKeyPair("wizard-pilot-staging");
    const f = join(tmp, "id_test");
    writeFileSync(f, k.privateKey, { mode: 0o600 });
    const r = spawnSync("ssh-keygen", ["-y", "-f", f], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split(" ").slice(0, 2)).toEqual(k.publicKey.split(" ").slice(0, 2));
  });

  it("cluster Secrets from the bundle, tofu outputs and the founder's inputs", () => {
    const { bundle } = ensureBundle(null, "prod");
    const s = bundle.secrets;
    const outputs = {
      env: { buckets: { files: "ab12-wizard-prod-files", backups: "ab12-wizard-prod-backups" } },
      s3_keys: {
        files: { access_key: "fk", secret_key: "files-secret" },
        backups: { access_key: "bk", secret_key: "backups-secret" },
      },
    };
    const f = clusterSecretFiles({ bundle, outputs, inputs: FOUNDER });
    expect(f.platformEnv).toContain(
      `WIZARD_DB_URL=postgres://wizard:${s.POSTGRES_PASSWORD}@wizard-pgbouncer:6432/wizard\n`,
    );
    expect(f.platformEnv).toContain("WIZARD_S3_BUCKET=ab12-wizard-prod-files\n");
    // No OpenBao on the pilot: key windows and BYOK keys are sealed by the stand's local KEK.
    expect(f.platformEnv).toContain("WIZARD_BYOK_KMS=local\n");
    expect(f.platformEnv).toContain("WIZARD_S3_SECRET_ACCESS_KEY=files-secret\n");
    expect(f.platformEnv).toContain("WIZARD_SMTP_FROM=Wizard <noreply@codename.ru>\n");
    expect(f.platformEnv).toContain("CLOUDRU_API_KEY=cloudru-secret-key\n");
    expect(f.platformEnv).not.toContain("ZAI_API_KEY");
    // Models (D26, M2-32): base URLs, Yandex and the default build tier reach the pods when set.
    const models = clusterSecretFiles({
      bundle,
      outputs,
      inputs: {
        ...FOUNDER,
        ZAI_API_KEY: "zai-key",
        CLOUDRU_BASE_URL: "https://foundation-models.api.cloud.ru/v1",
        ZAI_BASE_URL: "https://api.z.ai/api/paas/v4",
        YANDEX_API_KEY: "yandex-key",
        YANDEX_FOLDER_ID: "b1gfolder",
        YANDEX_BASE_URL: "https://llm.api.cloud.yandex.net/v1",
        WIZARD_BUILD_DEFAULT_TIER: "T1",
        WIZARD_LLM_DAILY_CAP_RUB: "1100",
      },
    }).platformEnv;
    for (const line of [
      "ZAI_API_KEY=zai-key",
      "CLOUDRU_BASE_URL=https://foundation-models.api.cloud.ru/v1",
      "ZAI_BASE_URL=https://api.z.ai/api/paas/v4",
      "YANDEX_API_KEY=yandex-key",
      "YANDEX_FOLDER_ID=b1gfolder",
      "YANDEX_BASE_URL=https://llm.api.cloud.yandex.net/v1",
      "WIZARD_BUILD_DEFAULT_TIER=T1",
      "WIZARD_LLM_DAILY_CAP_RUB=1100",
    ])
      expect(models).toContain(`${line}\n`);
    expect(f.platformEnv).not.toContain("WALG");
    // D78: new systems on v3 (the only supported configuration), G1 in the worker's Chromium, the systems' mail from
    // the pilot's mail domain (the domain of WIZARD_SMTP_FROM), stock photos off (B2-38: no keys yet).
    for (const line of [
      "WIZARD_BUILD_PIPELINE=v3",
      "WIZARD_G1_BROWSER=chromium",
      "WIZARD_MAIL_DOMAIN=codename.ru",
      "WIZARD_STOCK_MODE=off",
    ])
      expect(f.platformEnv).toContain(`${line}\n`);
    expect(f.platformEnv).not.toContain("WIZARD_G1_BROWSER_SLOTS");
    const back = clusterSecretFiles({
      bundle,
      outputs,
      inputs: {
        ...FOUNDER,
        WIZARD_BUILD_PIPELINE: "legacy",
        WIZARD_G1_BROWSER_SLOTS: "1",
        WIZARD_MAIL_DOMAIN: "Mail.Codename.ru",
        WIZARD_STOCK_MODE: "live",
      },
    }).platformEnv;
    for (const line of [
      "WIZARD_BUILD_PIPELINE=legacy",
      "WIZARD_G1_BROWSER_SLOTS=1",
      "WIZARD_MAIL_DOMAIN=mail.codename.ru",
      "WIZARD_STOCK_MODE=live",
    ])
      expect(back).toContain(`${line}\n`);
    expect(f.postgresEnv).toContain(`WALG_LIBSODIUM_KEY=${s.WALG_LIBSODIUM_KEY}\n`);
    expect(f.postgresEnv).toContain("AWS_SECRET_ACCESS_KEY=backups-secret\n");
    expect(f.postgresEnv).toContain(
      "WIZARD_OPS_ALERT_URL=https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc/sendMessage\n",
    );
    expect(f.postgresEnv).toContain("WIZARD_OPS_ALERT_CHAT_ID=-100123\n");
    expect(f.postgresEnv).toContain("WIZARD_OPS_ALERT_EMAIL=Founder@Example.ru\n");
    expect(f.userlist).toBe(`"wizard" "${s.POSTGRES_PASSWORD}"\n`);
    expect(f.dnsSolverEnv).toBe("TWC_TOKEN=twc-very-secret-token\n");
    expect(() => clusterSecretFiles({ bundle, outputs: { env: {} }, inputs: FOUNDER })).toThrow(
      /бакета files/,
    );
    // The founder's S3 account key (secrets AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) wins over per-bucket API keys.
    const acc = clusterSecretFiles({
      bundle,
      outputs,
      inputs: {
        ...FOUNDER,
        WIZARD_S3_ACCOUNT_KEY_ID: " ACCKEY ",
        WIZARD_S3_ACCOUNT_SECRET: "account-secret\n",
      },
    });
    expect(acc.platformEnv).toContain(
      "WIZARD_S3_ACCESS_KEY_ID=ACCKEY\nWIZARD_S3_SECRET_ACCESS_KEY=account-secret\n",
    );
    expect(acc.postgresEnv).toContain("AWS_ACCESS_KEY_ID=ACCKEY\nAWS_SECRET_ACCESS_KEY=account-secret\n");
    expect(() => envFile({ A: "x\ny" })).toThrow(/перевод строки/);
    expect(
      alertSettings({ WIZARD_OPS_ALERT_URL: "https://hook.example/x", WIZARD_OPS_ALERT_CHAT_ID: "1" }),
    ).toEqual({
      WIZARD_OPS_ALERT_URL: "https://hook.example/x",
      WIZARD_OPS_ALERT_CHAT_ID: "1",
      WIZARD_OPS_ALERT_EMAIL: "",
    });
    expect(() => alertSettings({ WIZARD_OPS_ALERT_TELEGRAM_TOKEN: "nope" })).toThrow(/токен бота/);
  });
});

/** Fake Timeweb API + S3 + IP echo; S3 requests must be SigV4-signed with the state bucket's key. */
function fakeCloud({ buckets = [], status = "created" } = {}) {
  const st = {
    buckets: [...buckets],
    objects: new Map(),
    groups: [
      { id: "fw-prod", name: "wizard-prod-nodes", policy: "DROP" },
      { id: "fw-staging", name: "wizard-staging-nodes", policy: "DROP" },
    ],
    rules: new Map([["fw-prod", [{ id: "keep", description: "https", port: "443", cidr: "0.0.0.0/0" }]]]),
    calls: [],
    nextRule: 1,
  };
  const json = (body, code = 200) => new Response(JSON.stringify(body), { status: code });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    st.calls.push(`${method} ${u.host}${u.pathname}`);
    if (u.host === "api.ipify.org") return new Response("198.51.100.7\n");
    if (u.host === "api.timeweb.cloud") {
      expect(init.headers.authorization).toBe("Bearer twc-very-secret-token");
      const p = u.pathname;
      if (p === "/api/v1/storages/buckets" && method === "GET") return json({ buckets: st.buckets });
      if (p === "/api/v1/storages/users" && method === "GET") return json({ users: st.users ?? [] });
      if (p === "/api/v1/presets/storages")
        return json({
          storages_presets: [
            { id: 3, location: "ru-1", storage_class: "hot", price: 79, disk: 10240 },
            { id: 1, location: "ru-1", storage_class: "hot", price: 19, disk: 1024 },
            { id: 9, location: "ru-1", storage_class: "cold", price: 5, disk: 1024 },
          ],
        });
      if (p === "/api/v1/storages/buckets" && method === "POST") {
        const body = JSON.parse(init.body);
        const b = {
          id: 41,
          name: `1a2b3c4d-${body.name}`,
          status,
          preset_id: body.preset_id,
          type: body.type,
          access_key: "STATEKEY",
          secret_key: "state-bucket-secret",
        };
        st.buckets.push(b);
        return json({ bucket: b }, 201);
      }
      const byId = /^\/api\/v1\/storages\/buckets\/(\d+)$/.exec(p);
      if (byId) return json({ bucket: st.buckets.find((b) => String(b.id) === byId[1]) });
      if (p === "/api/v1/firewall/groups") return json({ groups: st.groups });
      const rules = /^\/api\/v1\/firewall\/groups\/([^/]+)\/rules(?:\/([^/]+))?$/.exec(p);
      if (rules) {
        const list = st.rules.get(rules[1]) ?? [];
        st.rules.set(rules[1], list);
        if (method === "GET") return json({ rules: list });
        if (method === "POST") {
          const r = { id: `r${st.nextRule++}`, ...JSON.parse(init.body) };
          list.push(r);
          return json({ rule: r }, 201);
        }
        if (method === "DELETE") {
          st.rules.set(
            rules[1],
            list.filter((r) => r.id !== rules[2]),
          );
          return new Response(null, { status: 204 });
        }
      }
      return json({ message: "not found" }, 404);
    }
    if (u.host === "s3.twcstorage.ru") {
      expect(init.headers.authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=STATEKEY\/\d{8}\/ru-1\/s3\/aws4_request/,
      );
      if (u.pathname === "/" && method === "GET")
        return new Response(
          `<ListAllMyBucketsResult><Buckets>${st.buckets.map((b) => `<Bucket><Name>${b.name}</Name></Bucket>`).join("")}</Buckets></ListAllMyBucketsResult>`,
        );
      const key = decodeURIComponent(u.pathname);
      if (method === "PUT") {
        st.objects.set(key, String(init.body));
        return new Response("", { status: 200 });
      }
      if (st.objects.has(key)) return new Response(st.objects.get(key));
      return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { st, fetch };
}

const OUTPUTS = (env = "prod") => ({
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
      buckets: { files: `ab12-wizard-${env}-files`, backups: `ab12-wizard-${env}-backups` },
    },
  },
  postgres: { value: { main: { in_cluster: true } } },
  k3s_server: { value: { private_ip: "192.168.10.10", public_ip: "203.0.113.10" } },
  s3_keys: {
    value: {
      files: { access_key: "FILESKEY", secret_key: "files-bucket-secret" },
      backups: { access_key: "BACKUPSKEY", secret_key: "backups-bucket-secret" },
    },
  },
});

/** Fake tofu / ssh / kubectl / helm: records commands and stdin; the cluster answers from `cluster`. */
function fakeTools(cluster = { namespaces: ["default", "kube-system"], founderJob: "" }, onCmd = () => {}) {
  const lines = [];
  const inputs = [];
  const files = {};
  const run = (cmd, args, o = {}) => {
    lines.push(`$ ${cmd} ${args.join(" ")}`);
    if (o.input) inputs.push(o.input);
    onCmd(cmd, args);
    for (const a of args) {
      const m = /^--from-(?:env-)?file=(.+)$/.exec(a);
      if (m)
        files[m[1]] = m[1].endsWith("pgbouncer")
          ? readFileSync(join(m[1], "userlist.txt"), "utf8")
          : readFileSync(m[1], "utf8");
      if (a.startsWith("-var-file=")) files.tfvars = JSON.parse(readFileSync(a.slice(10), "utf8"));
    }
    if (cmd === "tofu" && args[1] === "output") return { status: 0, stdout: JSON.stringify(OUTPUTS()) };
    if (cmd === "ssh" && args.at(-1) === "cat /etc/rancher/k3s/k3s.yaml")
      return { status: 0, stdout: "server: https://127.0.0.1:6443\n" };
    if (cmd === "kubectl" && args[0] === "get" && args[1] === "namespaces")
      return { status: 0, stdout: cluster.namespaces.map((n) => `namespace/${n}`).join("\n") };
    if (cmd === "kubectl" && args.includes("job") && args.includes("jsonpath={.status.succeeded}"))
      return cluster.founderJob ? { status: 0, stdout: cluster.founderJob } : { status: 1, stdout: "" };
    return { status: 0, stdout: "" };
  };
  return { run, lines, inputs, files };
}

async function bootstrap(cloud, tools, { argv, vars = {}, summary } = {}) {
  const logs = [];
  const code = await main(
    argv ?? ["bootstrap", "--env", "prod", "--tag", SHA],
    { ...FOUNDER, ...vars, ...(summary ? { GITHUB_STEP_SUMMARY: summary } : {}) },
    {
      fetch: cloud.fetch,
      run: tools.run,
      has: () => true,
      exists: () => true,
      skipSmoke: true,
      skipImageWait: true,
      sleep: async () => {},
      kdf: FAST,
      tmpRoot: tmp,
      log: (s) => logs.push(s),
    },
  );
  return { code, logs };
}

const visible = (logs) => logs.filter((l) => !l.startsWith("::add-mask::")).join("\n");
const SECRETS = [
  "twc-very-secret-token",
  PASS,
  "cloudru-secret-key",
  "smtp-secret-password",
  "state-bucket-secret",
  "files-bucket-secret",
  "backups-bucket-secret",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc",
  "ghs_job_token_value",
];

describe("pilot: one button", () => {
  it("first bootstrap: state bucket, bundle, OpenTofu, SSH for this runner only, Secrets, release, founder access", async () => {
    const cloud = fakeCloud();
    const tools = fakeTools();
    const summary = join(tmp, "summary-1.md");
    const { code, logs } = await bootstrap(cloud, tools, { summary });
    expect(code).toBe(0);
    // State bucket created on the cheapest hot preset of ru-1, then found again by its full name.
    expect(cloud.st.buckets).toHaveLength(1);
    expect(cloud.st.buckets[0]).toMatchObject({
      name: "1a2b3c4d-wizard-tfstate",
      preset_id: 1,
      type: "private",
    });
    // The bundle lives encrypted next to the state; nothing in it is readable.
    const enc = cloud.st.objects.get("/1a2b3c4d-wizard-tfstate/wizard/prod.secrets.enc.json");
    const bundle = decryptBundle(enc, PASS, "prod");
    for (const v of secretValues(bundle)) expect(enc).not.toContain(v);
    expect(bundle.deployedAt).toBeTruthy();
    const text = tools.lines.join("\n");
    const order = [
      "tofu -chdir=infra/tofu/timeweb/envs/prod init -input=false -backend-config=bucket=1a2b3c4d-wizard-tfstate",
      "tofu -chdir=infra/tofu/timeweb/envs/prod apply",
      "output -json",
      "root@203.0.113.10 cat /etc/rancher/k3s/k3s.yaml",
      "-L 127.0.0.1:16443:127.0.0.1:6443 root@203.0.113.10",
      "kubectl get namespaces -o name",
      "kubectl apply -f infra/k8s/namespaces.yaml",
      "helm upgrade --install cert-manager",
      "--from-env-file=",
      "helm upgrade --install wizard infra/helm/wizard",
      "kubectl -n wizard-platform delete job wizard-founder-staff --ignore-not-found",
      "ssh -S",
    ];
    let at = -1;
    for (const step of order) {
      const i = text.indexOf(step, at + 1);
      expect(i, step).toBeGreaterThan(at);
      at = i;
    }
    expect(text).toContain(`images.tag=${SHA}`);
    expect(text).not.toContain("wizard-data-restore");
    // SSH: one rule for 198.51.100.7/32 during the job, gone afterwards; the permanent rules are untouched.
    const posts = cloud.st.calls.filter((c) => c.startsWith("POST api.timeweb.cloud/api/v1/firewall"));
    expect(posts).toHaveLength(1);
    expect(cloud.st.rules.get("fw-prod")).toEqual([
      { id: "keep", description: "https", port: "443", cidr: "0.0.0.0/0" },
    ]);
    expect(visible(logs)).toContain("SSH открыт для 198.51.100.7/32");
    // tfvars: generated key, no admin CIDRs, pilot shape.
    expect(tools.files.tfvars.settings).toMatchObject({
      admin_cidrs: [],
      postgres: null,
      ssh_public_key: bundle.secrets.SSH_PUBLIC_KEY,
      image_registry: "ghcr.io/owner",
    });
    // Secrets were created from files written by the job (and read here before the job's directory is reused).
    const all = Object.values(tools.files)
      .filter((x) => typeof x === "string")
      .join("\n");
    expect(all).toContain(`POSTGRES_PASSWORD=${bundle.secrets.POSTGRES_PASSWORD}`);
    expect(all).toContain("WIZARD_S3_ACCESS_KEY_ID=FILESKEY");
    expect(all).toContain(`"wizard" "${bundle.secrets.POSTGRES_PASSWORD}"`);
    // The pull secret is the job token, through stdin.
    const pull = tools.inputs.map((i) => JSON.parse(i)).find((x) => x.metadata?.name === "wizard-ghcr");
    expect(Buffer.from(pull.data[".dockerconfigjson"], "base64").toString()).toContain("ghs_job_token_value");
    const job = tools.inputs.map((i) => JSON.parse(i)).find((x) => x.kind === "Job");
    expect(job.spec.template.spec.containers[0].image).toBe(`ghcr.io/owner/wizard-postgres:${SHA}`);
    expect(job.spec.template.spec.containers[0].env).toContainEqual({
      name: "FOUNDER_EMAIL",
      value: "founder@example.ru",
    });
    // Nothing secret in the log or in the summary; the summary says what to do next.
    const shown = visible(logs);
    const sum = readFileSync(summary, "utf8");
    for (const s of [...SECRETS, ...secretValues(bundle)]) {
      expect(shown).not.toContain(s);
      expect(sum).not.toContain(s);
    }
    expect(logs).toContain("::add-mask::state-bucket-secret");
    expect(logs).toContain(`::add-mask::${bundle.secrets.WALG_LIBSODIUM_KEY}`);
    expect(sum).toContain("https://codename.ru/login");
    expect(sum).toContain("https://codename.ru/admin и включите MFA");
    expect(sum).toContain("WIZARD_STATE_PASSPHRASE");
    expect(sum).not.toContain("founder@example.ru");
    expect(sum).not.toContain("Founder@Example.ru");
  });

  it("later runs reuse the bucket and every generated value; staff is recorded once the Job succeeded", async () => {
    const cloud = fakeCloud();
    await bootstrap(cloud, fakeTools());
    const key = "/1a2b3c4d-wizard-tfstate/wizard/prod.secrets.enc.json";
    const first = decryptBundle(cloud.st.objects.get(key), PASS, "prod");
    const tools = fakeTools({ namespaces: ["default", "wizard-platform"], founderJob: "1" });
    const summary = join(tmp, "summary-2.md");
    const { code } = await bootstrap(cloud, tools, {
      argv: ["deploy", "--env", "prod", "--tag", SHA],
      summary,
    });
    expect(code).toBe(0);
    expect(cloud.st.buckets).toHaveLength(1);
    expect(cloud.st.calls.filter((c) => c === "POST api.timeweb.cloud/api/v1/storages/buckets")).toHaveLength(
      1,
    );
    const second = decryptBundle(cloud.st.objects.get(key), PASS, "prod");
    expect(second.secrets).toEqual(first.secrets);
    expect(second.deployedAt).toBe(first.deployedAt);
    expect(second.founderStaff).toMatch(/^[0-9a-f]{16}$/);
    const text = tools.lines.join("\n");
    // deploy: no OpenTofu apply, no addons, no new founder Job.
    expect(text).not.toContain(" apply -input=false");
    expect(text).not.toContain("--install cert-manager");
    expect(tools.inputs.some((i) => i.includes('"kind":"Job"'))).toBe(false);
    expect(readFileSync(summary, "utf8")).toContain("Консоль модерации: https://codename.ru/admin");
    // Third run: the marker in the bundle is enough — no kubectl lookup of the Job at all.
    const third = fakeTools({ namespaces: ["wizard-platform"], founderJob: "" });
    await bootstrap(cloud, third, { argv: ["deploy", "--env", "prod", "--tag", SHA] });
    expect(third.lines.join("\n")).not.toContain("wizard-founder-staff");
  });

  it("a wrong passphrase stops before OpenTofu and leaves the bundle untouched", async () => {
    const cloud = fakeCloud();
    await bootstrap(cloud, fakeTools());
    const key = "/1a2b3c4d-wizard-tfstate/wizard/prod.secrets.enc.json";
    const before = cloud.st.objects.get(key);
    const tools = fakeTools();
    await expect(
      bootstrap(cloud, tools, { vars: { WIZARD_STATE_PASSPHRASE: "another long passphrase!!" } }),
    ).rejects.toThrow(/WIZARD_STATE_PASSPHRASE не тот/);
    expect(cloud.st.objects.get(key)).toBe(before);
    expect(tools.lines).toEqual([]);
  });

  it("lost VM: an empty cluster with existing keys restores .data and restarts the services", async () => {
    const cloud = fakeCloud();
    await bootstrap(cloud, fakeTools());
    const tools = fakeTools({ namespaces: ["default", "kube-system"], founderJob: "" });
    const summary = join(tmp, "summary-dr.md");
    expect((await bootstrap(cloud, tools, { summary })).code).toBe(0);
    const text = tools.lines.join("\n");
    const restore = text.indexOf("create job --from=cronjob/wizard-data-restore");
    expect(restore).toBeGreaterThan(text.indexOf("helm upgrade --install wizard"));
    expect(text.indexOf("wait --for=condition=complete")).toBeGreaterThan(restore);
    expect(text).toContain("kubectl -n wizard-platform rollout restart deployment");
    expect(readFileSync(summary, "utf8")).toContain("ВМ была пересоздана");
  });

  it("an unreachable cluster is an error, never a «fresh cluster» restore", async () => {
    const cloud = fakeCloud();
    await bootstrap(cloud, fakeTools());
    const tools = fakeTools({ namespaces: [], founderJob: "" });
    await expect(bootstrap(cloud, tools)).rejects.toThrow(/пустой список/);
    expect(tools.lines.join("\n")).not.toContain("wizard-data-restore");
    expect(cloud.st.rules.get("fw-prod").map((r) => r.id)).toEqual(["keep"]);
  });

  it("a failure after SSH was opened still closes it", async () => {
    const cloud = fakeCloud();
    const tools = fakeTools(undefined, (cmd, args) => {
      if (cmd === "helm" && args.includes("wizard")) throw new Error("helm upgrade failed with 1");
    });
    await expect(bootstrap(cloud, tools)).rejects.toThrow(/helm upgrade/);
    expect(cloud.st.calls.filter((c) => c.startsWith("POST api.timeweb.cloud/api/v1/firewall"))).toHaveLength(
      1,
    );
    expect(cloud.st.rules.get("fw-prod").map((r) => r.id)).toEqual(["keep"]);
    expect(tools.lines.at(-1)).toContain("ssh -S");
  });

  it("missing settings: exit 2 with the names only; deploy before bootstrap: exit 3", async () => {
    const cloud = fakeCloud();
    const summary = join(tmp, "summary-missing.md");
    const { code, logs } = await bootstrap(cloud, fakeTools(), {
      vars: { CLOUDRU_API_KEY: "", WIZARD_PLATFORM_DOMAIN: "" },
      summary,
    });
    expect(code).toBe(2);
    expect(logs.join("\n")).toContain("CLOUDRU_API_KEY");
    expect(readFileSync(summary, "utf8")).toContain("WIZARD_PLATFORM_DOMAIN");
    expect(cloud.st.calls).toEqual([]);
    const d = await bootstrap(cloud, fakeTools(), { argv: ["deploy", "--env", "prod", "--tag", SHA] });
    expect(d.code).toBe(3);
    expect(cloud.st.buckets).toEqual([]);
  });

  it("Timeweb API: an idempotent call is sent again after a dropped socket, a POST is not", async () => {
    const cloud = fakeCloud();
    cloud.st.rules.set("fw-staging", [{ id: "a", description: "wizard-ci-temp ssh run 1" }]);
    let drops = 1;
    const flaky = (url, init) => {
      if (drops > 0) {
        drops -= 1;
        return Promise.reject(new TypeError("fetch failed"));
      }
      return cloud.fetch(url, init);
    };
    const api = twcClient({ token: "twc-very-secret-token", fetch: flaky, sleep: async () => {} });
    expect(await closeAdminAccess(api, "staging")).toBe(1);
    drops = 1;
    await expect(api("POST", "/api/v1/firewall/groups/x/rules", {})).rejects.toThrow("fetch failed");
  });

  it("close-access removes only the temporary rules; staging destroy keeps prod's keys", async () => {
    const cloud = fakeCloud();
    cloud.st.rules.set("fw-staging", [
      { id: "a", description: "wizard-ci-temp ssh run 1" },
      { id: "b", description: "https" },
    ]);
    const api = twcClient({ token: "twc-very-secret-token", fetch: cloud.fetch });
    expect(await closeAdminAccess(api, "staging")).toBe(1);
    expect(cloud.st.rules.get("fw-staging").map((r) => r.id)).toEqual(["b"]);
    expect((await bootstrap(cloud, fakeTools(), { argv: ["close-access", "--env", "staging"] })).code).toBe(
      0,
    );

    const STAGING = {
      WIZARD_STAGING_PLATFORM_DOMAIN: "stage-p.ru",
      WIZARD_STAGING_SYSTEMS_DOMAIN: "stage-s.ru",
    };
    await bootstrap(cloud, fakeTools(), {
      argv: ["bootstrap", "--env", "staging", "--tag", SHA],
      vars: STAGING,
    });
    const tools = fakeTools();
    expect(
      (await bootstrap(cloud, tools, { argv: ["destroy", "--env", "staging"], vars: STAGING })).code,
    ).toBe(0);
    expect(tools.lines.join("\n")).toContain("tofu -chdir=infra/tofu/timeweb/envs/staging destroy");
    expect(tools.lines.join("\n")).not.toContain("kubectl");
  });

  it("state bucket: matched by its prefixed full name, never twice, unpaid is a clear error", async () => {
    expect(bucketMatches("1a2b3c4d-wizard-tfstate", "wizard-tfstate")).toBe(true);
    expect(bucketMatches("wizard-tfstate", "wizard-tfstate")).toBe(true);
    expect(bucketMatches("1a2b-old-wizard-tfstate", "wizard-tfstate")).toBe(false);
    expect(bucketMatches("1a2b3c4d-wizard-prod-files", "wizard-tfstate")).toBe(false);
    const existing = {
      id: 5,
      name: "ffff0000-wizard-tfstate",
      status: "created",
      access_key: "STATEKEY",
      secret_key: "state-bucket-secret",
    };
    const cloud = fakeCloud({ buckets: [existing] });
    const api = twcClient({ token: "twc-very-secret-token", fetch: cloud.fetch });
    expect(await ensureStateBucket(api)).toEqual({
      bucket: "ffff0000-wizard-tfstate",
      accessKeyId: "STATEKEY",
      secretAccessKey: "state-bucket-secret",
      created: false,
      empty: false,
    });
    // The API's object count marks an empty bucket (Timeweb answers 403 for a missing key).
    const emptyCloud = fakeCloud({ buckets: [{ ...existing, object_amount: 0 }] });
    expect(
      (await ensureStateBucket(twcClient({ token: "twc-very-secret-token", fetch: emptyCloud.fetch }))).empty,
    ).toBe(true);
    const unpaid = fakeCloud({ status: "no_paid" });
    await expect(
      ensureStateBucket(twcClient({ token: "twc-very-secret-token", fetch: unpaid.fetch }), {
        sleep: async () => {},
      }),
    ).rejects.toThrow(/пополните баланс/);
    expect(
      await ensureStateBucket(twcClient({ token: "twc-very-secret-token", fetch: fakeCloud().fetch }), {
        create: false,
      }),
    ).toBeNull();
    const err = twcClient({
      token: "twc-very-secret-token",
      fetch: async () => new Response('{"message":"bad"}', { status: 400 }),
    });
    await expect(err("GET", "/api/v1/x?limit=1")).rejects.toThrow("Timeweb API GET /api/v1/x: HTTP 400 bad");
  });

  it("founder access Job: database only, restricted pod, the address only as a psql variable", () => {
    const job = founderStaffJob({ image: "ghcr.io/owner/wizard-postgres:abc", email: "f@example.ru" });
    const pod = job.spec.template.spec;
    expect(job.spec.template.metadata.labels["wizard.ru/role"]).toBe("pg-job");
    expect(pod.securityContext).toMatchObject({
      runAsNonRoot: true,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(pod.containers[0].securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.containers[0].command.join(" ")).toContain('-v email="$FOUNDER_EMAIL"');
    expect(FOUNDER_STAFF_SQL).not.toContain("f@example.ru");
    for (const m of FOUNDER_STAFF_SQL.matchAll(/\b(?:FROM|INTO|UPDATE)\s+([a-z_.]+)/gi))
      expect(m[1]).toMatch(/^platform\./);
    expect(
      summaryText({ env: "staging", command: "destroy", domains: { platform: "x.ru" }, tag: SHA, state: {} }),
    ).toContain("удалён");
  });
});

// FOUNDER_STAFF_SQL against a real PostgreSQL 16: a throwaway database with the two tables it touches (columns of
// migrations 0001 / 0012 that matter here), the address passed exactly as the Job passes it (psql variable, -1, -f -).
const PG = process.env.WIZARD_DB_URL ?? "postgres://wizard@localhost:5433/wizard";
const pgUp = spawnSync("psql", [PG, "-Atc", "select 1"], { encoding: "utf8" }).stdout?.trim() === "1";

describe.skipIf(!pgUp)("pilot: founder access SQL (PostgreSQL)", () => {
  const db = `wz_founder_${Date.now().toString(36)}`;
  const url = PG.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);
  const psql = (target, args, input) =>
    spawnSync("psql", [target, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", ...args], {
      input,
      encoding: "utf8",
    });
  afterAll(() => psql(PG, ["-c", `DROP DATABASE IF EXISTS ${db}`]));

  it("one invitation while there is no account (expired ones replaced), staff after sign-in, injection-safe", () => {
    expect(psql(PG, ["-c", `CREATE DATABASE ${db}`]).status).toBe(0);
    const ddl = `
      CREATE SCHEMA platform;
      CREATE TABLE platform.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL,
        is_staff boolean NOT NULL DEFAULT false, deleted_at timestamptz);
      CREATE TABLE platform.pilot_invites (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL CHECK (email = lower(email)), org_name text,
        credits integer NOT NULL DEFAULT 0 CHECK (credits >= 0), expires_at timestamptz NOT NULL,
        accepted_at timestamptz, accepted_user_id uuid, org_id uuid, revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX pilot_invites_active_idx ON platform.pilot_invites (email)
        WHERE accepted_at IS NULL AND revoked_at IS NULL;
      CREATE TABLE platform.orgs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
        kind text NOT NULL DEFAULT 'client');
      CREATE TABLE platform.memberships (org_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL);`;
    expect(psql(url, ["-f", "-"], ddl).status).toBe(0);
    const email = "Founder@Example.ru'; DROP TABLE platform.users; --";
    const step = () => {
      const r = psql(url, ["-1", "-v", `email=${email}`, "-f", "-"], FOUNDER_STAFF_SQL);
      expect(r.status, r.stderr).toBe(0);
      return r.stdout.trim();
    };
    const q = (sql) => psql(url, ["-c", sql]).stdout.trim();
    expect(step()).toBe("");
    expect(step()).toBe("");
    expect(q("SELECT count(*) || '/' || min(email) FROM platform.pilot_invites")).toBe(
      `1/${email.toLowerCase()}`,
    );
    // The founder can try builds at once: payments are off on the pilot.
    expect(q("SELECT credits FROM platform.pilot_invites")).toBe(String(FOUNDER_START_CREDITS));
    q("UPDATE platform.pilot_invites SET expires_at = now() - interval '1 day'");
    expect(step()).toBe("");
    expect(
      q("SELECT count(*) || '/' || count(*) FILTER (WHERE revoked_at IS NULL) FROM platform.pilot_invites"),
    ).toBe("2/1");
    const user = psql(
      url,
      ["-v", `email=${email.toLowerCase()}`, "-f", "-"],
      "INSERT INTO platform.users (email) VALUES (:'email');",
    );
    expect(user.status).toBe(0);
    // B2-01: the org the founder owns becomes a staff org; another user's org and an eval org stay as they are.
    q(`INSERT INTO platform.orgs (name) VALUES ('Wizard'), ('Чужая');
       INSERT INTO platform.orgs (name, kind) VALUES ('Замер', 'eval');
       INSERT INTO platform.memberships (org_id, user_id, role)
         SELECT o.id, u.id, 'owner' FROM platform.orgs o, platform.users u WHERE o.name IN ('Wizard', 'Замер');`);
    const id = step();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(q("SELECT is_staff FROM platform.users")).toBe("t");
    expect(q("SELECT string_agg(name || '=' || kind, ',' ORDER BY name) FROM platform.orgs")).toBe(
      "Wizard=staff,Замер=eval,Чужая=client",
    );
    expect(step()).toBe(id);
  });
});

describe("S3 of a just created state bucket", () => {
  it("error codes are kept, messages (which may echo the key id) are dropped", () => {
    expect(s3ErrorCode("<Error><Code>AccessDenied</Code><Message>key AKIAEXAMPLE</Message></Error>")).toBe(
      " (AccessDenied)",
    );
    expect(s3ErrorCode("")).toBe("");
  });

  it("403 is retried until the keys work; other errors and the last 403 are not swallowed", async () => {
    const forbidden = Object.assign(new Error("S3 GET: HTTP 403"), { status: 403 });
    let n = 0;
    const logs = [];
    const ok = await untilS3Ready(
      async () => {
        if (++n < 3) throw forbidden;
        return "bundle";
      },
      { sleep: async () => {}, log: (l) => logs.push(l) },
    );
    expect([ok, n, logs.length]).toEqual(["bundle", 3, 1]);
    await expect(
      untilS3Ready(async () => Promise.reject(forbidden), { attempts: 2, sleep: async () => {} }),
    ).rejects.toBe(forbidden);
    let calls = 0;
    const other = Object.assign(new Error("HTTP 500"), { status: 500 });
    await expect(
      untilS3Ready(
        async () => {
          calls++;
          throw other;
        },
        { sleep: async () => {} },
      ),
    ).rejects.toBe(other);
    expect(calls).toBe(1);
  });
});

describe("GET of the bundle when Timeweb answers 403 for a missing key", () => {
  const cfg = {
    endpoint: "https://s3.twcstorage.ru",
    region: "ru-1",
    bucket: "1a2b-wizard-tfstate",
    accessKeyId: "AK",
    secretAccessKey: "SK",
  };
  const forbidden = async () =>
    new Response("<Error><Code>AccessDenied</Code><Message>no</Message></Error>", { status: 403 });
  it("an empty bucket (per the Timeweb API) means no bundle yet", async () => {
    expect(
      await getObjectOrNull({ ...cfg, empty: true }, "wizard/prod.secrets.enc.json", { fetch: forbidden }),
    ).toBeNull();
  });
  it("otherwise 403 stops with the bucket and the S3 code, no secret", async () => {
    const e = await getObjectOrNull(cfg, "wizard/prod.secrets.enc.json", { fetch: forbidden }).catch(
      (x) => x,
    );
    expect(e.message).toBe(
      "S3 GET 1a2b-wizard-tfstate/wizard/prod.secrets.enc.json: HTTP 403 (AccessDenied)",
    );
    expect(e.status).toBe(403);
  });
});

describe("state bucket keys as S3 sees them (first live apply: SignatureDoesNotMatch with the bucket's keys)", () => {
  const state = {
    bucket: "wizard-tfstate",
    accessKeyId: "BUCKETKEY",
    secretAccessKey: "bucket-secret-value",
    created: false,
    empty: true,
  };
  const twc = (users) => async (method, path) => {
    expect([method, path]).toEqual(["GET", "/api/v1/storages/users"]);
    return { users };
  };
  const s3 = (good) => async (_url, init) => {
    const id = /Credential=([^/]+)\//.exec(init.headers.authorization)[1];
    if (id !== good)
      return new Response("<Error><Code>SignatureDoesNotMatch</Code><Message>m</Message></Error>", {
        status: 403,
      });
    return new Response(
      "<ListAllMyBucketsResult><Buckets><Bucket><Name>9f8e7d6c-wizard-tfstate</Name></Bucket><Bucket><Name>other</Name></Bucket></Buckets></ListAllMyBucketsResult>",
    );
  };
  it("falls back to the storage user's keys and the prefixed S3 name", async () => {
    const logs = [];
    const r = await resolveStateS3(
      twc([{ id: 7, access_key: " USERKEY ", secret_key: "user-secret-value\n" }]),
      state,
      {
        fetch: s3("USERKEY"),
        log: (l) => logs.push(l),
      },
    );
    expect(r).toMatchObject({
      bucket: "9f8e7d6c-wizard-tfstate",
      accessKeyId: "USERKEY",
      secretAccessKey: "user-secret-value",
      empty: true,
    });
    expect(logs.join("\n")).toContain("пользователь хранилища 7");
    expect(logs.join("\n")).not.toContain("user-secret-value");
  });
  it("the founder's S3 account key is tried first", async () => {
    const r = await resolveStateS3(twc([]), state, {
      fetch: s3("ACCKEY"),
      vars: { WIZARD_S3_ACCOUNT_KEY_ID: "ACCKEY", WIZARD_S3_ACCOUNT_SECRET: "account-secret" },
    });
    expect(r).toMatchObject({
      bucket: "9f8e7d6c-wizard-tfstate",
      accessKeyId: "ACCKEY",
      secretAccessKey: "account-secret",
    });
  });
  it("nothing works: 403 with each attempt's S3 code and no key", async () => {
    const e = await resolveStateS3(
      twc([{ id: 7, access_key: "USERKEY", secret_key: "user-secret-value" }]),
      state,
      {
        fetch: s3("NOBODY"),
      },
    ).catch((x) => x);
    expect(e.status).toBe(403);
    expect(e.message).toBe(
      "S3 не пускает к бакету wizard-tfstate: ключи бакета — SignatureDoesNotMatch; пользователь хранилища 7 — SignatureDoesNotMatch",
    );
  });
});

describe("DMARC of the systems domain through the DNS records API", () => {
  it("added once, skipped when present, a warning (not a failure) when Timeweb refuses", async () => {
    const calls = [];
    const api = (records, fail) => async (method, path, body) => {
      calls.push([method, path, body]);
      if (method === "GET") return { dns_records: records };
      if (fail) throw new Error("Timeweb API POST: HTTP 400 Bad subdomain name");
      return {};
    };
    expect(await ensureDmarc(api([]), "neutral.ru")).toBe("created");
    expect(calls[1]).toEqual([
      "POST",
      "/api/v1/domains/neutral.ru/dns-records",
      {
        type: "TXT",
        subdomain: "_dmarc.neutral.ru",
        value: "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s",
      },
    ]);
    expect(
      await ensureDmarc(api([{ type: "TXT", data: { value: "v=DMARC1; p=reject" } }]), "neutral.ru"),
    ).toBe("exists");
    const logs = [];
    expect(await ensureDmarc(api([], true), "neutral.ru", { log: (l) => logs.push(l) })).toBe("failed");
    expect(logs[0]).toMatch(/^::warning/);
  });

  it("provider records of the platform domain: missing ones added, present skipped, a foreign CNAME reported", async () => {
    const calls = [];
    const api = (records) => async (method, path, body) => {
      calls.push([method, path, body]);
      if (method === "GET") return { dns_records: records };
      return {};
    };
    const want = [
      { subdomain: "link", type: "CNAME", value: "track.example.net" },
      { subdomain: "us._domainkey", type: "TXT", value: "k=rsa; p=AAA" },
    ];
    const existing = [
      { type: "TXT", data: { subdomain: "us._domainkey.borntobuild.ru", value: '"k=rsa; p=AAA"' } },
    ];
    expect(await ensureDnsRecords(api(existing), "borntobuild.ru", want)).toEqual([
      "link CNAME: добавлена",
      "us._domainkey TXT: есть",
    ]);
    expect(calls.filter(([m]) => m === "POST")).toEqual([
      [
        "POST",
        "/api/v1/domains/borntobuild.ru/dns-records",
        { type: "CNAME", subdomain: "link.borntobuild.ru", value: "track.example.net" },
      ],
    ]);
    const logs = [];
    const other = [{ type: "CNAME", data: { subdomain: "link", value: "elsewhere.example.org." } }];
    expect(
      await ensureDnsRecords(api(other), "borntobuild.ru", want.slice(0, 1), { log: (l) => logs.push(l) }),
    ).toEqual(["link CNAME: другое значение"]);
    expect(logs[0]).toMatch(/^::warning/);
    expect(await ensureDnsRecords(api([]), "borntobuild.ru", [])).toEqual([]);
    // The committed file parses; a malformed record is refused before any API call.
    expect(Array.isArray(platformDnsRecords())).toBe(true);
    const bad = join(mkdtempSync(join(tmpdir(), "dns-")), "r.json");
    writeFileSync(bad, JSON.stringify({ records: [{ subdomain: "a b", type: "A", value: "1.2.3.4" }] }));
    expect(() => platformDnsRecords(bad)).toThrow(/CNAME\|TXT/);
  });

  it("the sender domain at Unisender: DKIM TXT from get-dns-records at us._domainkey, then both re-checked", async () => {
    const calls = [];
    const api = async (method, path, body) => {
      calls.push([method, path, body]);
      if (method === "GET")
        return {
          dns_records: [{ type: "TXT", data: { subdomain: "", value: '"unisender-go-validate-hash=abc"' } }],
        };
      return {};
    };
    const sent = [];
    const fetch = async (url, init) => {
      sent.push([url, JSON.parse(init.body), init.headers["X-API-KEY"]]);
      const method = url.split("/v1/")[1];
      const body =
        method === "domain/get-dns-records.json"
          ? { status: "success", "verification-record": "unisender-go-validate-hash=abc", dkim: "KEY" }
          : method === "domain/validate-dkim.json"
            ? { status: "error", code: 1, message: "DKIM not found" }
            : { status: "success" };
      return { ok: body.status === "success", json: async () => body };
    };
    const logs = [];
    const vars = {
      WIZARD_SMTP_HOST: "smtp.go2.unisender.ru",
      WIZARD_SMTP_PASSWORD: "k",
      WIZARD_SMTP_FROM: "Wizard <noreply@borntobuild.ru>",
    };
    const r = await ensureUnisenderDomain(api, { vars, fetch, log: (l) => logs.push(l) });
    expect(sent.map(([u]) => u)).toEqual([
      "https://go2.unisender.ru/ru/transactional/api/v1/domain/get-dns-records.json",
      "https://go2.unisender.ru/ru/transactional/api/v1/domain/validate-verification-record.json",
      "https://go2.unisender.ru/ru/transactional/api/v1/domain/validate-dkim.json",
    ]);
    expect(sent.every(([, b, k]) => b.domain === "borntobuild.ru" && k === "k")).toBe(true);
    expect(calls.filter(([m]) => m === "POST")).toEqual([
      [
        "POST",
        "/api/v1/domains/borntobuild.ru/dns-records",
        { type: "TXT", subdomain: "us._domainkey.borntobuild.ru", value: "k=rsa; p=KEY" },
      ],
    ]);
    expect(r?.checks).toEqual({
      "domain/validate-verification-record": "подтверждено",
      "domain/validate-dkim": "не подтверждено (код 1 DKIM not found)",
    });
    // The ownership TXT is at the root: no warning about it.
    expect(logs.some((l) => l.includes("подтверждения владения"))).toBe(false);
    // Not Unisender, no key or no sender — nothing is called.
    expect(
      await ensureUnisenderDomain(api, { vars: { ...vars, WIZARD_SMTP_HOST: "smtp.example.org" }, fetch }),
    ).toBeNull();
    expect(
      await ensureUnisenderDomain(api, { vars: { ...vars, WIZARD_SMTP_PASSWORD: "" }, fetch }),
    ).toBeNull();
    expect(sent).toHaveLength(3);
  });

  it("the VM region follows WIZARD_TIMEWEB_LOCATION (ru-1 | ru-3), anything else is ignored", () => {
    expect(tfvars("prod", { ...FOUNDER, WIZARD_TIMEWEB_LOCATION: "ru-1" }, "k").settings.location).toBe(
      "ru-1",
    );
    expect(
      tfvars("prod", { ...FOUNDER, WIZARD_TIMEWEB_LOCATION: "eu-1" }, "k").settings.location,
    ).toBeUndefined();
    expect(tfvars("prod", FOUNDER, "k").settings.location).toBeUndefined();
    expect(tfvars("prod", { ...FOUNDER, WIZARD_TIMEWEB_ZONE: "spb-4" }, "k").settings.zone).toBe("spb-4");
    expect(tfvars("prod", { ...FOUNDER, WIZARD_TIMEWEB_ZONE: "fra-1" }, "k").settings.zone).toBeUndefined();
  });
});

describe("DNS tidy after OpenTofu (Timeweb defaults, the founder's DKIM in the root)", () => {
  const zoneApi = (zones) => {
    const calls = [];
    const api = async (method, path, body) => {
      calls.push([method, path, body]);
      const [, zone, id] = /^\/api\/v1\/domains\/([^/]+)\/dns-records(?:\/(\d+))?$/.exec(path);
      if (method === "GET") return { dns_records: zones[zone] };
      if (method === "DELETE") {
        zones[zone] = zones[zone].filter((r) => String(r.id) !== id);
        return {};
      }
      zones[zone].push({ id: 999, type: body.type, data: { subdomain: body.subdomain, value: body.value } });
      return {};
    };
    return { api, calls };
  };
  const rec = (id, type, value, subdomain = null) => ({ id, type, data: { value, subdomain } });

  it("drops only the default SPF and parking A records, moves DKIM, never touches DMARC", async () => {
    const zones = {
      "codename.ru": [
        rec(1, "TXT", "v=spf1 include:_spf.timeweb.ru ~all"),
        rec(2, "TXT", "v=spf1 include:spf.unisender.ru -all"),
        rec(3, "TXT", "v=DKIM1; k=rsa; p=AAAA"),
        rec(4, "TXT", "unisender-go-validate-hash=abc"),
        rec(5, "TXT", "v=DMARC1; p=none; adkim=s; aspf=s", "_dmarc"),
        rec(6, "A", "194.87.187.207"),
        rec(7, "A", "203.0.113.10"),
      ],
      "neutral.ru": [
        rec(11, "TXT", "v=spf1 include:_spf.timeweb.ru ~all"),
        rec(12, "TXT", "v=spf1 -all"),
        rec(13, "A", "194.87.187.207"),
        rec(14, "A", "203.0.113.10"),
        rec(15, "A", "203.0.113.10", "*.neutral.ru"),
        rec(16, "A", "147.45.99.196", "*"),
      ],
    };
    const { api } = zoneApi(zones);
    const logs = [];
    await tidyDns(api, {
      zones: ["codename.ru", "neutral.ru"],
      ingressIp: "203.0.113.10",
      ourSpf: { "codename.ru": "v=spf1 include:spf.unisender.ru -all", "neutral.ru": "v=spf1 -all" },
      dkimSelector: "gokey",
      log: (l) => logs.push(l),
    });
    expect(zones["codename.ru"].map((r) => [r.type, r.data.subdomain, r.data.value])).toEqual([
      ["TXT", null, "v=spf1 include:spf.unisender.ru -all"],
      ["TXT", null, "unisender-go-validate-hash=abc"],
      ["TXT", "_dmarc", "v=DMARC1; p=none; adkim=s; aspf=s"],
      ["A", null, "203.0.113.10"],
      ["TXT", "gokey._domainkey.codename.ru", "v=DKIM1; k=rsa; p=AAAA"],
    ]);
    expect(zones["neutral.ru"].map((r) => r.id)).toEqual([12, 14, 15]);
    expect(logs.join("\n")).toContain("DKIM скопирован в gokey._domainkey.codename.ru");
  });

  it("DKIM already at its name: no second copy, the equal root one is removed", async () => {
    const zones = {
      "codename.ru": [
        rec(3, "TXT", "v=DKIM1; p=AAAA"),
        rec(8, "TXT", "v=DKIM1; p=AAAA", "gokey._domainkey.codename.ru"),
      ],
    };
    const { api, calls } = zoneApi(zones);
    await tidyDns(api, { zones: ["codename.ru"], dkimSelector: "gokey" });
    expect(calls.some(([m]) => m === "POST")).toBe(false);
    expect(zones["codename.ru"].map((r) => r.id)).toEqual([8]);
  });

  it("nothing is deleted while ours is missing; a refused DKIM copy leaves the root DKIM", async () => {
    const zones = {
      "codename.ru": [
        rec(1, "TXT", "v=spf1 include:_spf.timeweb.ru ~all"),
        rec(3, "TXT", "v=DKIM1; p=AAAA"),
        rec(6, "A", "194.87.187.207"),
      ],
    };
    const { api: base } = zoneApi(zones);
    const api = async (m, p, b) => {
      if (m === "POST") throw new Error("HTTP 400 Bad subdomain name");
      return base(m, p, b);
    };
    const logs = [];
    await tidyDns(api, {
      zones: ["codename.ru"],
      ingressIp: "203.0.113.10",
      ourSpf: { "codename.ru": "v=spf1 include:spf.unisender.ru -all" },
      dkimSelector: "gokey",
      log: (l) => logs.push(l),
    });
    expect(zones["codename.ru"].map((r) => r.id)).toEqual([1, 3, 6]);
    expect(logs.join("\n")).toMatch(/DKIM не перенесён/);
  });
});

describe("Timeweb capacity: the next RF place with the same preset ceiling", () => {
  it("starts with the requested place, then Moscow and the St Petersburg zones, without repeats", () => {
    expect(placesFrom({ WIZARD_TIMEWEB_LOCATION: "ru-1" }).map((p) => `${p.location}/${p.zone}`)).toEqual([
      "ru-1/spb-1",
      "ru-3/",
      "ru-1/spb-4",
      "ru-1/spb-2",
      "ru-1/spb-5",
    ]);
    expect(placesFrom({}).map((p) => `${p.location}/${p.zone}`)).toEqual([
      "ru-3/",
      "ru-1/spb-1",
      "ru-1/spb-4",
      "ru-1/spb-2",
      "ru-1/spb-5",
    ]);
    expect(
      placesFrom({ WIZARD_TIMEWEB_LOCATION: "ru-1", WIZARD_TIMEWEB_ZONE: "spb-4" }).map(
        (p) => `${p.location}/${p.zone}`,
      ),
    ).toEqual(["ru-1/spb-4", "ru-3/", "ru-1/spb-1", "ru-1/spb-2", "ru-1/spb-5"]);
  });
});

describe("pilot: beta v2 settings of the release (B2-41)", () => {
  it("pipeline, browser, mail domain and stock photos: defaults, overrides, refusals", () => {
    expect(pilotPipelineEnv({})).toEqual({
      WIZARD_BUILD_PIPELINE: "v3",
      WIZARD_BUILD_PIPELINE_ORGS: "",
      WIZARD_G1_BROWSER: "chromium",
      WIZARD_G1_BROWSER_SLOTS: "",
      WIZARD_MAIL_DOMAIN: "",
      WIZARD_STOCK_MODE: "off",
    });
    expect(pilotPipelineEnv({ WIZARD_BUILD_PIPELINE: " Legacy ", WIZARD_G1_BROWSER: "off" })).toMatchObject({
      WIZARD_BUILD_PIPELINE: "legacy",
      WIZARD_G1_BROWSER: "off",
    });
    // D78: v3 by default; modules (beta v2) and legacy only as an emergency way back; anything else is refused.
    expect(pilotPipelineEnv({ WIZARD_BUILD_PIPELINE: "Modules" })).toMatchObject({
      WIZARD_BUILD_PIPELINE: "modules",
    });
    expect(() => pilotPipelineEnv({ WIZARD_BUILD_PIPELINE: "v2" })).toThrow(/v3 или modules или legacy/);
    // V3-18: v3 per org — the measurement orgs and the founder's, by kind or id; a typo is refused at the release.
    expect(
      pilotPipelineEnv({
        WIZARD_BUILD_PIPELINE_ORGS: " Eval, staff,eval,6F1C2A4E-1B2C-4D5E-8F90-0A1B2C3D4E5F ",
      }),
    ).toMatchObject({
      WIZARD_BUILD_PIPELINE: "v3",
      WIZARD_BUILD_PIPELINE_ORGS: "eval,staff,6f1c2a4e-1b2c-4d5e-8f90-0a1b2c3d4e5f",
    });
    expect(() => pilotPipelineEnv({ WIZARD_BUILD_PIPELINE_ORGS: "eval,clients" })).toThrow(
      /WIZARD_BUILD_PIPELINE_ORGS: .*не подходит: clients/,
    );
    expect(() => pilotPipelineEnv({ WIZARD_G1_BROWSER: "firefox" })).toThrow(/chromium или off/);
    expect(() => pilotPipelineEnv({ WIZARD_G1_BROWSER_SLOTS: "20" })).toThrow(/от 1 до 8/);
    expect(() => pilotPipelineEnv({ WIZARD_STOCK_MODE: "unsplash" })).toThrow(/WIZARD_STOCK_MODE/);
    expect(pilotMailDomain({ WIZARD_SMTP_FROM: "noreply@Borntobuild.ru" })).toBe("borntobuild.ru");
    expect(pilotMailDomain({ WIZARD_SMTP_FROM: "Wizard <noreply@codename.ru>" })).toBe("codename.ru");
    expect(pilotMailDomain({ WIZARD_SMTP_FROM: "Wizard" })).toBe("");
    expect(() => pilotMailDomain({ WIZARD_MAIL_DOMAIN: "not a domain" })).toThrow(/WIZARD_MAIL_DOMAIN/);
    // Live stock photos need these hosts (the platform requests them only in live/record, B2-38).
    expect(STOCK_EGRESS_HOSTS).toEqual([
      "api.pexels.com",
      "images.pexels.com",
      "pixabay.com",
      "cdn.pixabay.com",
    ]);
  });
});

describe("pilot: stock photo keys of the release (B2-38)", () => {
  const PEXELS = "pexels-secret-key-001";
  const PIXABAY = "12345-pixabaysecretkey";
  const KEYS = { PEXELS_API_KEY: PEXELS, PIXABAY_API_KEY: PIXABAY };

  it("the platform Secret gets the keys only with live (record), only the given ones, never the turned-off ones", () => {
    expect(pilotStockEnv(KEYS)).toEqual({});
    expect(pilotStockEnv({ ...KEYS, WIZARD_STOCK_MODE: "off" })).toEqual({});
    expect(pilotStockEnv({ ...KEYS, WIZARD_STOCK_MODE: "fixture" })).toEqual({});
    expect(pilotStockEnv({ ...KEYS, WIZARD_STOCK_MODE: " Live " })).toEqual({
      WIZARD_STOCK_PEXELS_KEY: PEXELS,
      WIZARD_STOCK_PIXABAY_KEY: PIXABAY,
    });
    expect(pilotStockEnv({ ...KEYS, WIZARD_STOCK_MODE: "record" }, { off: ["pixabay"] })).toEqual({
      WIZARD_STOCK_PEXELS_KEY: PEXELS,
    });
    expect(pilotStockEnv({ PIXABAY_API_KEY: "  ", WIZARD_STOCK_MODE: "live" })).toEqual({});
    expect(pilotStockMode({})).toBe("off");
    expect(() => pilotStockMode({ WIZARD_STOCK_MODE: "unsplash" })).toThrow(/WIZARD_STOCK_MODE/);
    // The whole platform env file: no key line with off, no line for a missing key.
    const bundle = ensureBundle(null, "prod").bundle;
    const outputs = { env: OUTPUTS().env.value, s3_keys: OUTPUTS().s3_keys.value };
    const off = clusterSecretFiles({ bundle, outputs, inputs: { ...FOUNDER, ...KEYS } }).platformEnv;
    expect(off).not.toContain("WIZARD_STOCK_PEXELS_KEY");
    expect(off).not.toContain(PEXELS);
    expect(off).not.toContain(PIXABAY);
    const live = clusterSecretFiles({
      bundle,
      outputs,
      inputs: { ...FOUNDER, PEXELS_API_KEY: PEXELS, WIZARD_STOCK_MODE: "live" },
    }).platformEnv;
    expect(live).toContain(`WIZARD_STOCK_PEXELS_KEY=${PEXELS}\n`);
    expect(live).toContain("WIZARD_STOCK_MODE=live\n");
    expect(live).not.toContain("WIZARD_STOCK_PIXABAY_KEY");
    const turnedOff = clusterSecretFiles({
      bundle,
      outputs,
      inputs: { ...FOUNDER, ...KEYS, WIZARD_STOCK_MODE: "live" },
      stockOff: ["pexels"],
    }).platformEnv;
    expect(turnedOff).not.toContain(PEXELS);
    expect(turnedOff).toContain(`WIZARD_STOCK_PIXABAY_KEY=${PIXABAY}\n`);
  });

  it("the egress hosts are the hosts of the stock client (packages/agents STOCK_HOSTS)", () => {
    const client = readFileSync(
      join(import.meta.dirname, "../../../packages/agents/src/stock/client.ts"),
      "utf8",
    );
    const block = /export const STOCK_HOSTS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(client)?.[1] ?? "";
    const hosts = new Set([...block.matchAll(/"([a-z0-9.-]+\.[a-z]+)"/g)].map((m) => m[1]));
    expect([...hosts].sort()).toEqual([...STOCK_EGRESS_HOSTS].sort());
    // The env names the release writes are the ones platform-api and the worker read (stock.ts STOCK_KEY_ENV).
    const platform = readFileSync(
      join(import.meta.dirname, "../../../apps/platform-api/src/agents/stock.ts"),
      "utf8",
    );
    for (const [provider, [, name]] of Object.entries(STOCK_KEY_ENV))
      expect(platform).toContain(`${provider}: "${name}"`);
  });

  const stockFetch = (pexels, pixabay, calls = []) => ({
    calls,
    fetch: async (url) => {
      const u = new URL(url);
      if (u.host === "api.pexels.com") {
        calls.push(`pexels ${u.pathname}`);
        return pexels();
      }
      calls.push(`pixabay ${u.pathname}`);
      return pixabay();
    },
  });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

  it("off: no request, one line; live: verdicts, refused and missing keys turned off with warnings", async () => {
    const s = stockFetch(
      () => json({ photos: [] }),
      () => new Response("[ERROR 400] Invalid or missing API key", { status: 400 }),
    );
    const logs = [];
    const off = await stockKeysOfRelease({ ...KEYS }, { fetch: s.fetch, log: (l) => logs.push(l) });
    expect(off).toMatchObject({ mode: "off", off: [] });
    expect(off.lines).toEqual([
      "Фото со стоков выключены (stock_mode=off): ключи в платформу не передаются.",
    ]);
    expect(s.calls).toEqual([]);
    expect(logs).toContain("::notice title=Фото со стоков::выключены (stock_mode=off): ключи не проверялись");
    const live = await stockKeysOfRelease(
      { ...KEYS, WIZARD_STOCK_MODE: "live" },
      { fetch: s.fetch, log: (l) => logs.push(l) },
    );
    expect(s.calls).toEqual(["pexels /v1/search", "pixabay /api/"]);
    expect(live.off).toEqual(["pixabay"]);
    expect(live.lines).toEqual([
      "Фото со стоков (stock_mode=live), проверка ключей:",
      "- Pexels: действителен (HTTP 200)",
      "- Pixabay: недействителен (HTTP 400) — сток выключен в этом выкате",
    ]);
    expect(logs).toContain(
      "::warning title=pilot::Pixabay: недействителен (HTTP 400): замените PIXABAY_API_KEY в секретах GitHub, фото этого стока выключены",
    );
    // B2-41: both verdicts in one annotation.
    expect(logs).toContain(
      "::warning title=Фото со стоков::Pexels — действителен (HTTP 200); Pixabay — недействителен (HTTP 400)",
    );
    // No answer keeps the key; no key turns the provider off; none working — the theme graphics are announced.
    const down = stockFetch(
      () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
      },
      () => json({}, 401),
    );
    const lines2 = [];
    const r = await stockKeysOfRelease(
      { PEXELS_API_KEY: PEXELS, WIZARD_STOCK_MODE: "live" },
      { fetch: down.fetch, log: (l) => lines2.push(l) },
    );
    expect(r.off).toEqual(["pixabay"]);
    expect(r.lines).toContain("- Pexels: не проверен (нет ответа: ETIMEDOUT) — ключ передан без проверки");
    expect(r.lines).toContain("- Pixabay: нет ключа — сток выключен в этом выкате");
    expect(lines2).toContain("::warning title=pilot::PIXABAY_API_KEY не задан: фото этого стока выключены");
    expect(lines2).toContain(
      "::notice title=Фото со стоков::Pexels — не проверен (нет ответа: ETIMEDOUT); Pixabay — нет ключа",
    );
    const none = await stockKeysOfRelease(
      { PEXELS_API_KEY: PEXELS, PIXABAY_API_KEY: PIXABAY, WIZARD_STOCK_MODE: "live" },
      {
        fetch: stockFetch(
          () => json({}, 401),
          () => json({}, 403),
        ).fetch,
      },
    );
    expect(none.off).toEqual(["pexels", "pixabay"]);
    expect(none.lines.at(-1)).toBe(
      "- Ни одного рабочего ключа: на сайтах систем будет графика темы вместо фото.",
    );
    for (const t of [...logs, ...lines2, ...live.lines, ...r.lines, ...none.lines]) {
      expect(t).not.toContain(PEXELS);
      expect(t).not.toContain(PIXABAY);
      expect(t).not.toContain("pixabay.com/api");
    }
  });

  it("deploy with stock_mode=live: keys masked, checked before the Secret, the refused one left out, the release goes on", async () => {
    const cloud = fakeCloud();
    await bootstrap(cloud, fakeTools());
    const s = stockFetch(
      () => json({ photos: [{ id: 1 }] }),
      () => new Response("[ERROR 400] Invalid or missing API key", { status: 400 }),
    );
    const routed = {
      ...cloud,
      fetch: (url, init) =>
        /^https:\/\/(api\.pexels\.com|pixabay\.com)\//.test(url)
          ? s.fetch(url, init)
          : cloud.fetch(url, init),
    };
    const tools = fakeTools({ namespaces: ["default", "wizard-platform"], founderJob: "1" });
    const summary = join(tmp, "summary-stock.md");
    const { code, logs } = await bootstrap(routed, tools, {
      argv: ["deploy", "--env", "prod", "--tag", SHA],
      vars: { ...KEYS, WIZARD_STOCK_MODE: "live" },
      summary,
    });
    expect(code).toBe(0);
    expect(s.calls).toEqual(["pexels /v1/search", "pixabay /api/"]);
    expect(logs.slice(0, 2)).toEqual([`::add-mask::${PEXELS}`, `::add-mask::${PIXABAY}`]);
    const env = Object.values(tools.files).find((x) => typeof x === "string" && x.includes("WIZARD_DB_URL="));
    expect(env).toContain(`WIZARD_STOCK_PEXELS_KEY=${PEXELS}\n`);
    expect(env).toContain("WIZARD_STOCK_MODE=live\n");
    expect(env).not.toContain("WIZARD_STOCK_PIXABAY_KEY");
    expect(env).not.toContain(PIXABAY);
    const sum = readFileSync(summary, "utf8");
    expect(sum).toContain("## Пилот prod: фото со стоков");
    expect(sum).toContain("- Pexels: действителен (HTTP 200)");
    expect(sum).toContain("- Pixabay: недействителен (HTTP 400) — сток выключен в этом выкате");
    expect(logs.some((l) => l.startsWith("::warning title=pilot::Pixabay: недействителен"))).toBe(true);
    for (const k of [PEXELS, PIXABAY]) {
      expect(visible(logs)).not.toContain(k);
      expect(sum).not.toContain(k);
    }
  });
});

describe("pilot: the photo library of stock_mode=library (B2-43)", () => {
  const PEXELS = "pexels-secret-key-002";
  const PIXABAY = "12345-pixabaysecretkey2";
  const KEYS = { PEXELS_API_KEY: PEXELS, PIXABAY_API_KEY: PIXABAY };
  const ACCOUNT = { WIZARD_S3_ACCOUNT_KEY_ID: "ACCKEY", WIZARD_S3_ACCOUNT_SECRET: "account-secret" };
  const LIB = { ...KEYS, WIZARD_STOCK_MODE: "library" };

  it("the pods get WIZARD_STOCK_MODE=library and no stock key; the release asks no stock", async () => {
    expect(pilotStockMode({ WIZARD_STOCK_MODE: " Library " })).toBe("library");
    expect(pilotStockEnv(LIB)).toEqual({});
    expect(pilotPipelineEnv(LIB).WIZARD_STOCK_MODE).toBe("library");
    const bundle = ensureBundle(null, "prod").bundle;
    const outputs = { env: OUTPUTS().env.value, s3_keys: OUTPUTS().s3_keys.value };
    const env = clusterSecretFiles({ bundle, outputs, inputs: { ...FOUNDER, ...LIB } }).platformEnv;
    expect(env).toContain("WIZARD_STOCK_MODE=library\n");
    for (const s of [PEXELS, PIXABAY, "WIZARD_STOCK_PEXELS_KEY", "WIZARD_STOCK_PIXABAY_KEY"])
      expect(env).not.toContain(s);
    const calls = [];
    const logs = [];
    const r = await stockKeysOfRelease(LIB, {
      fetch: async (u) => {
        calls.push(u);
        return new Response("{}");
      },
      log: (l) => logs.push(l),
    });
    expect(calls).toEqual([]);
    expect(r).toMatchObject({ mode: "library", off: [] });
    expect(r.lines[0]).toContain("из библиотеки фото платформы");
    expect(logs).toContain(
      "::notice title=Фото со стоков::библиотека фото (stock_mode=library): ключи в платформу не передаются",
    );
  });

  it("the seeding job gets the files bucket, endpoint and region of the pods — only with the S3 account key", () => {
    const outputs = { env: OUTPUTS().env.value };
    const logs = [];
    const log = (l) => logs.push(l);
    expect(stockLibraryOutputs({ vars: { ...LIB, ...ACCOUNT }, outputs, log })).toEqual({
      files_bucket: "ab12-wizard-prod-files",
      s3_endpoint: "https://s3.twcstorage.ru",
      s3_region: "ru-1",
    });
    expect(
      stockLibraryOutputs({ vars: { ...KEYS, ...ACCOUNT, WIZARD_STOCK_MODE: "live" }, outputs, log }),
    ).toBeNull();
    expect(stockLibraryOutputs({ vars: { ...ACCOUNT }, outputs, log })).toBeNull();
    expect(logs).toEqual([]);
    expect(stockLibraryOutputs({ vars: LIB, outputs, log })).toBeNull();
    expect(logs[0]).toContain("::warning title=Библиотека фото::нет ключа S3-аккаунта");
    expect(stockLibraryOutputs({ vars: { ...LIB, ...ACCOUNT }, outputs: { env: {} }, log })).toBeNull();
    expect(logs[1]).toContain("нет бакета files");
  });

  it("deploy with stock_mode=library writes the step outputs of the seeding job, never a key", async () => {
    const cloud = fakeCloud();
    await bootstrap(cloud, fakeTools());
    const out = join(tmp, "github-output-library");
    writeFileSync(out, "");
    const tools = fakeTools({ namespaces: ["default", "wizard-platform"], founderJob: "1" });
    const { code, logs } = await bootstrap(cloud, tools, {
      argv: ["deploy", "--env", "prod", "--tag", SHA],
      // The account key also opens the state bucket of the fake cloud (it checks the key id there).
      vars: {
        ...LIB,
        WIZARD_S3_ACCOUNT_KEY_ID: "STATEKEY",
        WIZARD_S3_ACCOUNT_SECRET: "state-bucket-secret",
        GITHUB_OUTPUT: out,
      },
    });
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(
      "files_bucket=ab12-wizard-prod-files\ns3_endpoint=https://s3.twcstorage.ru\ns3_region=ru-1\n",
    );
    const env = Object.values(tools.files).find((x) => typeof x === "string" && x.includes("WIZARD_DB_URL="));
    expect(env).toContain("WIZARD_STOCK_MODE=library\n");
    expect(env).not.toContain(PEXELS);
    // No stock probe from the server pod: it never calls a stock in this mode.
    expect(tools.lines.join("\n")).not.toContain("api.pexels.com");
    expect(visible(logs)).not.toContain(PEXELS);
  });
});

/** V3-01: the pre-registration of an eval run in the spend journal (the cap is the budget of the measurement). */
const reg = (cap = "300", over = {}) => {
  const r = {
    "--wave": "A",
    "--purpose": "Проба сборки",
    "--hypothesis": "Брифы собираются",
    "--expect-rub": "100",
    "--cap-rub": cap,
    ...over,
  };
  return Object.entries(r).flat();
};
/** A spend journal of its own for each eval run of these tests (the repository's one grows with real runs). */
const spendJournal = (entries = []) => {
  const file = join(mkdtempSync(join(tmp, "spend-")), "v3-spend.json");
  writeFileSync(
    file,
    JSON.stringify({
      budgetRub: 12000,
      since: "2026-10-08",
      plan: { A: 2400, B: 1300, C: 500, checkpoint: 2000, final: 3600, retry: 1500, competitors: 1000 },
      entries,
    }),
  );
  return file;
};

describe("pilot: eval — the D67 measurement on the server (M2-88 mvp_scope)", () => {
  it("arguments: briefs, threshold and the pre-registration only for eval, validated; defaults all and d76", () => {
    expect(parseArgs(["eval", "--env", "prod", ...reg()])).toMatchObject({
      command: "eval",
      briefs: "all",
      threshold: "d76",
      maxCostRub: 300,
      spend: {
        wave: "A",
        purpose: "Проба сборки",
        hypothesis: "Брифы собираются",
        expectRub: 100,
        capRub: 300,
      },
    });
    expect(
      parseArgs(["eval", "--env", "prod", "--threshold", "d67", ...reg("2000", { "--founder-ok": "yes" })]),
    ).toMatchObject({
      threshold: "d67",
      maxCostRub: 2000,
      spend: { founderOk: true },
    });
    expect(() => parseArgs(["eval", "--env", "prod", "--threshold", "d99", ...reg()])).toThrow(/--threshold/);
    expect(parseArgs(["eval", "--env", "prod", "--briefs", "mvp-03,mvp-10", ...reg("700")])).toMatchObject({
      briefs: "mvp-03,mvp-10",
      maxCostRub: 700,
    });
    // The pre-V3 name of the cap still works.
    expect(
      parseArgs(["eval", "--env", "prod", "--briefs", "", ...reg("", { "--max-cost-rub": "250" })]),
    ).toMatchObject({ briefs: "all", maxCostRub: 250 });
    expect(() => parseArgs(["eval", "--env", "prod", "--briefs", "mvp-01;rm -rf", ...reg()])).toThrow(
      /--briefs/,
    );
    expect(() => parseArgs(["eval", "--env", "prod", ...reg("16000", { "--founder-ok": "yes" })])).toThrow(
      /15/,
    );
    expect(() => parseArgs(["eval", "--env", "prod", ...reg("1.5")])).toThrow(/целое/);
    expect(() => parseArgs(["deploy", "--env", "prod", "--tag", SHA, "--briefs", "all"])).toThrow(/unknown/);
    expect(() => parseArgs(["deploy", "--env", "prod", "--tag", SHA, "--cap-rub", "5"])).toThrow(/unknown/);
  });

  it("V3-01: without its record in the spend journal a paid run does not start — nothing is touched", async () => {
    const calls = [];
    const deps = {
      fetch: (url) => {
        calls.push(url);
        throw new Error("no network in this test");
      },
      run: (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        return { status: 0, stdout: "" };
      },
      log: () => {},
    };
    // No pre-registration at all, then each gap alone; the old way (only a budget) too.
    await expect(main(["eval", "--env", "prod"], FOUNDER, deps)).rejects.toThrow(
      /^Платный прогон не начат — нужна запись в журнале трат v3: не указана цель \(purpose\); не указана гипотеза \(hypothesis\); не выбрана волна/,
    );
    for (const [flag, why] of [
      ["--purpose", /цель \(purpose\)/],
      ["--hypothesis", /гипотеза \(hypothesis\)/],
      ["--expect-rub", /ожидаемые ₽ \(expect_rub\)/],
      ["--cap-rub", /потолок \(cap_rub\)/],
      ["--wave", /волна \(wave/],
    ])
      await expect(
        main(["eval", "--env", "prod", ...reg("300", { [flag]: "" })], FOUNDER, deps),
        flag,
      ).rejects.toThrow(why);
    await expect(main(["eval", "--env", "prod", "--max-cost-rub", "300"], FOUNDER, deps)).rejects.toThrow(
      /Платный прогон не начат/,
    );
    // > 1 000 ₽ at once and over the wave plan of the journal: only with the founder's «да».
    await expect(
      main(["eval", "--env", "prod", ...reg("1500")], FOUNDER, { ...deps, spendJournal: spendJournal() }),
    ).rejects.toThrow(/больше 1\s000 ₽ за раз — нужно «да» основателя/);
    const full = spendJournal([
      {
        id: "v3-001",
        date: "2026-10-09",
        wave: "A",
        purpose: "п",
        hypothesis: "г",
        expectRub: 0,
        capRub: 2300,
        actualRub: 2250,
      },
    ]);
    await expect(
      main(["eval", "--env", "prod", ...reg("300")], FOUNDER, { ...deps, spendJournal: full }),
    ).rejects.toThrow(/волна A может выйти за план: занято 2\s250 ₽ из 2\s400 ₽/);
    await expect(
      main(["eval", "--env", "prod", ...reg("300")], FOUNDER, {
        ...deps,
        spendJournal: join(tmp, "no-journal.json"),
      }),
    ).rejects.toThrow(/журнал трат v3 не прочитан/);
    expect(calls).toEqual([]);
  });

  it("account in the database over the tunnel, briefs over HTTPS, session closed, report in the summary; no secrets in the log", async () => {
    const cloud = fakeCloud();
    await bootstrap(cloud, fakeTools());
    const db = { tokenHash: "", csrfHash: "", orgId: "11111111-1111-4111-8111-111111111111" };
    const platform = fakePlatform({
      hashes: () => db,
      origin: "https://codename.ru",
      cookieNames: { session: "__Host-wizard_session", csrf: "__Host-wizard_csrf" },
    });
    const base = fakeTools({ namespaces: ["default", "wizard-platform"], founderJob: "1" });
    const sqls = [];
    const run = (cmd, args, o = {}) => {
      const r = base.run(cmd, args, o);
      if (cmd !== "kubectl" || !args.includes("exec")) return r;
      sqls.push(o.input);
      if (o.input.includes("INSERT INTO platform.users")) {
        db.tokenHash = /\\set token_hash '([0-9a-f]{64})'/.exec(o.input)[1];
        db.csrfHash = /\\set csrf_hash '([0-9a-f]{64})'/.exec(o.input)[1];
        const email = /\\set email '([^']+)'/.exec(o.input)[1];
        return {
          status: 0,
          stdout: `${JSON.stringify({ userId: "22222222-2222-4222-8222-222222222222", orgId: db.orgId, sessionId: "33333333-3333-4333-8333-333333333333", email })}\n`,
        };
      }
      if (o.input.includes("'costs='")) {
        const ids = [...platform.st.systems.keys()];
        return {
          status: 0,
          stdout: `costs=${JSON.stringify(ids.map((id) => ({ system_id: id, rub: 123.45, credits_milli: 25000, calls: 9 })))}\ngaps=null\n`,
        };
      }
      return { status: 0, stdout: "revoked=33333333-3333-4333-8333-333333333333\n" };
    };
    const summary = join(tmp, "summary-eval.md");
    const logs = [];
    const code = await main(
      ["eval", "--env", "prod", "--briefs", "mvp-02,mvp-10", "--threshold", "d67", ...reg("1000")],
      { ...FOUNDER, GITHUB_STEP_SUMMARY: summary },
      {
        fetch: (url, init = {}) =>
          new URL(url).host === "codename.ru"
            ? platform.handler(new Request(url, init))
            : cloud.fetch(url, init),
        run,
        has: () => true,
        exists: () => true,
        sleep: async () => {},
        evalPollMs: 1,
        // The fake builds cost ≈ 200 ₽; the D75 per-brief cap is tested in the driver.
        evalMaxBriefRub: 10_000,
        kdf: FAST,
        tmpRoot: tmp,
        log: (s) => logs.push(s),
        spendJournal: spendJournal(),
      },
    );
    expect(code).toBe(0);
    // V3-01: the pre-registration is announced; the spend line goes to an annotation and the summary.
    expect(logs).toContain(
      "::notice title=Журнал трат v3::волна A, ожидаем 100 ₽, потолок 1000 ₽ — цель: Проба сборки; гипотеза: Брифы собираются",
    );
    expect(logs).toContainEqual(
      expect.stringMatching(
        /^::notice title=Траты v3::потрачено 247 ₽ из плана 2\s400 ₽ волны A; всего по v3 — 247 ₽ из 12\s000 ₽$/,
      ),
    );
    // Database work only inside the postgres container, values through stdin: seed, then collect and revoke.
    const text = base.lines.join("\n");
    expect(text).toContain(
      'kubectl -n wizard-platform exec -i wizard-postgres-0 -c postgres -- sh -c PGPASSWORD="$POSTGRES_PASSWORD" exec psql',
    );
    expect(
      sqls.map((x) =>
        x.includes("INSERT INTO platform.users")
          ? "seed"
          : x.includes("'costs='")
            ? "collect"
            : x.includes("UPDATE platform.sessions")
              ? "revoke"
              : "?",
      ),
    ).toEqual(["seed", "collect", "revoke"]);
    expect(sqls[0]).toContain("\\set email 'eval+");
    expect(sqls[0]).toContain("@codename.ru'");
    // No release in eval: diagnose access only (no helm, no OpenTofu apply), SSH closed after each cluster visit.
    expect(text).not.toContain("helm upgrade");
    expect(text).not.toContain(" apply -input=false");
    expect(cloud.st.rules.get("fw-prod").map((r) => r.id)).toEqual(["keep"]);
    // The briefs went through the public HTTPS with the seeded session; logout at the end.
    expect(platform.st.systems.size).toBe(2);
    expect(platform.st.logout).toBe(1);
    const [token, csrf] = [...platform.st.tokens];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(logs).toContain(`::add-mask::${token}`);
    expect(logs).toContain(`::add-mask::${csrf}`);
    // Nothing secret in the visible log, the summary, the artifact or the SQL.
    const shown = visible(logs);
    const sum = readFileSync(summary, "utf8");
    const dir = join(tmp, "wizard-eval-prod");
    const files = readdirSync(dir);
    expect(files.filter((f) => /^d67-\d{8}-[0-9a-f]{6}\.(md|json)$/.test(f))).toHaveLength(2);
    const artifact = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    for (const s of [...SECRETS, token, csrf]) {
      expect(shown).not.toContain(s);
      expect(sum).not.toContain(s);
      expect(artifact).not.toContain(s);
      expect(sqls.join("\n")).not.toContain(s);
    }
    expect(sum).not.toContain("founder@example.ru");
    expect(sum).toContain("Замер D67 на сервере пилота");
    expect(sum).toContain("**Итог: 2 из 2 дошли до готовности к публикации");
    expect(sum).toContain("247 ₽ (точно, по журналу вызовов моделей)");
    expect(sum).toContain("Лимит D70 учётке замера поднят");
    // V3-01 (acceptance 3): the report has the spend section and the entry for the journal next to it.
    expect(sum).toMatch(
      /## Траты v3\n\n- Итого: потрачено 247 ₽ из плана 2\s400 ₽ волны A; всего по v3 — 247 ₽ из 12\s000 ₽\./,
    );
    expect(sum).toMatch(
      /цель — Проба сборки; гипотеза — Брифы собираются\. Ожидали 100 ₽, потолок 1\s000 ₽, факт 247 ₽ \(точно/,
    );
    expect(sum).toContain("spend.mjs register --entry spend-entry.json");
    expect(sqls[1]).toContain("\\set b2_since '2026-10-08'");
    const entry = JSON.parse(readFileSync(join(dir, "spend-entry.json"), "utf8"));
    expect(entry).toMatchObject({
      wave: "A",
      purpose: "Проба сборки",
      hypothesis: "Брифы собираются",
      expectRub: 100,
      capRub: 1000,
      actualRub: 246.9,
      result: "засчитано 2 из 2, порог пройден",
    });
    expect(entry.runId).toMatch(/^\d{8}-[0-9a-f]{6}$/);
    expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("V3-01: the cap stops the run under any threshold — the running brief is cancelled, the exact spend is still read", async () => {
    const cloud = fakeCloud();
    await bootstrap(cloud, fakeTools());
    const db = { tokenHash: "", csrfHash: "", orgId: "11111111-1111-4111-8111-111111111111" };
    const platform = fakePlatform({
      hashes: () => db,
      origin: "https://codename.ru",
      cookieNames: { session: "__Host-wizard_session", csrf: "__Host-wizard_csrf" },
    });
    const base = fakeTools({ namespaces: ["default", "wizard-platform"], founderJob: "1" });
    const sqls = [];
    const run = (cmd, args, o = {}) => {
      const r = base.run(cmd, args, o);
      if (cmd !== "kubectl" || !args.includes("exec")) return r;
      sqls.push(o.input);
      if (o.input.includes("INSERT INTO platform.users")) {
        db.tokenHash = /\\set token_hash '([0-9a-f]{64})'/.exec(o.input)[1];
        db.csrfHash = /\\set csrf_hash '([0-9a-f]{64})'/.exec(o.input)[1];
        const email = /\\set email '([^']+)'/.exec(o.input)[1];
        return {
          status: 0,
          stdout: `${JSON.stringify({ userId: "22222222-2222-4222-8222-222222222222", orgId: db.orgId, sessionId: "33333333-3333-4333-8333-333333333333", email })}\n`,
        };
      }
      if (o.input.includes("'costs='")) {
        const ids = [...platform.st.systems.keys()];
        return {
          status: 0,
          stdout: `costs=${JSON.stringify(ids.map((id) => ({ system_id: id, rub: 180, credits_milli: 36000, calls: 9 })))}\ngaps=null\nb2={"rub": 512.5, "since": "2026-10-08"}\n`,
        };
      }
      return { status: 0, stdout: "revoked=33333333-3333-4333-8333-333333333333\n" };
    };
    const logs = [];
    const summary = join(tmp, "summary-cap.md");
    const tmpRoot = mkdtempSync(join(tmp, "cap-"));
    // D67 alone never cancels a running brief; the fake build costs 40 credits ≈ 200 ₽ — over the 50 ₽ cap.
    const code = await main(
      [
        "eval",
        "--env",
        "prod",
        "--briefs",
        "mvp-02,mvp-10",
        "--threshold",
        "d67",
        ...reg("50", { "--expect-rub": "30" }),
      ],
      { ...FOUNDER, GITHUB_STEP_SUMMARY: summary },
      {
        fetch: (url, init = {}) =>
          new URL(url).host === "codename.ru"
            ? platform.handler(new Request(url, init))
            : cloud.fetch(url, init),
        run,
        has: () => true,
        exists: () => true,
        sleep: async () => {},
        evalPollMs: 1,
        evalMaxBriefRub: 10_000,
        kdf: FAST,
        tmpRoot,
        log: (s) => logs.push(s),
        spendJournal: spendJournal(),
      },
    );
    expect(code).toBe(1);
    expect(logs).toContainEqual(
      expect.stringMatching(
        /^::warning title=Журнал трат v3::замер остановлен: потолок прогона 50 ₽ достигнут/,
      ),
    );
    // Stopped by the cap, not cancelled: the database step still ran (exact spend, session revoked).
    expect(
      sqls.map((x) =>
        x.includes("'costs='") ? "collect" : x.includes("UPDATE platform.sessions") ? "revoke" : "seed",
      ),
    ).toEqual(["seed", "collect", "revoke"]);
    const runs = [...platform.st.runs.values()];
    expect(runs.filter((x) => x.status === "cancelled").length).toBeGreaterThan(0);
    const sum = readFileSync(summary, "utf8");
    expect(sum).toMatch(/- Прогон остановлен: потолок прогона 50 ₽ достигнут/);
    expect(sum).toMatch(
      /Ожидали 30 ₽, потолок 50 ₽, факт \d[\d\s]* ₽ \(точно, по журналу вызовов моделей\) — дороже ожиданий\./,
    );
    expect(sum).toMatch(/пробы и замеры с 2026-10-08 потратили 513 ₽/);
    // The beta v2 budget line is gone with V3.
    expect(sum).not.toContain("Бюджет разработки беты v2");
    const entry = JSON.parse(readFileSync(join(tmpRoot, "wizard-eval-prod", "spend-entry.json"), "utf8"));
    expect(entry.result).toMatch(
      /^остановлен: потолок прогона 50 ₽ достигнут .*; засчитано \d из 2, порог не пройден$/,
    );
  });

  it("d76 (B2-41): plans approved as they are, screenshots next to the report, the v3 spend, a strict verdict", async () => {
    const cloud = fakeCloud();
    await bootstrap(cloud, fakeTools());
    const db = { tokenHash: "", csrfHash: "", orgId: "11111111-1111-4111-8111-111111111111" };
    const platform = fakePlatform({
      hashes: () => db,
      origin: "https://codename.ru",
      cookieNames: { session: "__Host-wizard_session", csrf: "__Host-wizard_csrf" },
      pipeline: "modules",
    });
    const base = fakeTools({ namespaces: ["default", "wizard-platform"], founderJob: "1" });
    const sqls = [];
    const run = (cmd, args, o = {}) => {
      const r = base.run(cmd, args, o);
      if (cmd !== "kubectl" || !args.includes("exec")) return r;
      sqls.push(o.input);
      if (o.input.includes("INSERT INTO platform.users")) {
        db.tokenHash = /\\set token_hash '([0-9a-f]{64})'/.exec(o.input)[1];
        db.csrfHash = /\\set csrf_hash '([0-9a-f]{64})'/.exec(o.input)[1];
        const email = /\\set email '([^']+)'/.exec(o.input)[1];
        return {
          status: 0,
          stdout: `${JSON.stringify({ userId: "22222222-2222-4222-8222-222222222222", orgId: db.orgId, sessionId: "33333333-3333-4333-8333-333333333333", email })}\n`,
        };
      }
      if (o.input.includes("'costs='")) {
        const ids = [...platform.st.systems.keys()];
        return {
          status: 0,
          stdout: `costs=${JSON.stringify(ids.map((id) => ({ system_id: id, rub: 11.5, credits_milli: 2300, calls: 9 })))}\ngaps=null\nb2={"rub": 123.4, "since": "2026-10-08"}\nphotos=${JSON.stringify([{ system_id: ids[0], revision: 1, built: true, providers: { pexels: 2, pixabay: 1 } }])}\n`,
        };
      }
      return { status: 0, stdout: "revoked=33333333-3333-4333-8333-333333333333\n" };
    };
    const shot = [];
    const logs = [];
    const summary = join(tmp, "summary-d76.md");
    const code = await main(
      // The fake build costs 40 credits ≈ 200 ₽: the cap is 1 000 ₽ (a hard stop under any threshold).
      ["eval", "--env", "prod", "--briefs", "mvp-01,mvp-02", ...reg("1000", { "--wave": "checkpoint" })],
      { ...FOUNDER, GITHUB_STEP_SUMMARY: summary, WIZARD_V3_BUDGET_SINCE: "2026-10-09" },
      {
        fetch: (url, init = {}) =>
          new URL(url).host === "codename.ru"
            ? platform.handler(new Request(url, init))
            : cloud.fetch(url, init),
        run,
        has: () => true,
        exists: () => true,
        sleep: async () => {},
        evalPollMs: 1,
        evalMaxBriefRub: 10_000,
        evalScreenshots: ({ dir }) => ({
          screenshot: async (r) => {
            shot.push(r.id);
            return [{ label: "телефон, 390 px", src: join(dir, `${r.id}-390.png`) }];
          },
          close: async () => shot.push("closed"),
        }),
        kdf: FAST,
        tmpRoot: tmp,
        log: (l) => logs.push(l),
        spendJournal: spendJournal(),
      },
    );
    expect(code).toBe(0);
    // B2-41: the stock photos of the sites as an annotation (the job summary is not readable through the API).
    expect(logs).toContain(
      "::notice title=D76 фото::Фото со стоков: 1 сайт из 2, всего 3 фото (Pexels 2, Pixabay 1)",
    );
    expect(sqls[0]).toContain("\\set org_name 'Замер D76 · ");
    // V3-01: the eval spend since the start of the v3 budget (WIZARD_V3_BUDGET_SINCE over the journal's day).
    expect(sqls[1]).toContain("\\set b2_since '2026-10-09'");
    // The plan of each system was approved through approveSystemPlan, never a card.
    expect(platform.st.requests.filter((x) => x.endsWith("/plan/approve"))).toHaveLength(2);
    expect(platform.st.requests.some((x) => x.endsWith("/card/approve"))).toBe(false);
    expect(shot.at(-1)).toBe("closed");
    expect(
      shot
        .slice(0, -1)
        .map((x) => x.slice(0, 6))
        .sort(),
    ).toEqual(["mvp-01", "mvp-02"]);
    const dir = join(tmp, "wizard-eval-prod");
    const md = readdirSync(dir).find((f) => /^d76-\d{8}-[0-9a-f]{6}\.md$/.test(f));
    expect(md).toBeTruthy();
    const text = readFileSync(join(dir, md), "utf8");
    expect(text).toContain("# Замер беты v2 (порог D76)");
    expect(text).toContain("строгий порог D76 пройден — засчитано 2 из 2");
    expect(text).not.toContain("Бюджет разработки беты v2");
    expect(text).toMatch(
      /- Итого: потрачено 23 ₽ из плана 2\s000 ₽ волны «Чекпоинты основателя»; всего по v3 — 23 ₽ из 12\s000 ₽\./,
    );
    expect(text).toContain(
      "- По журналу вызовов моделей платформы пробы и замеры с 2026-10-08 потратили 123 ₽.",
    );
    expect(text).toContain("](shots/mvp-01-");
    const json = JSON.parse(readFileSync(join(dir, md.replace(/\.md$/, ".json")), "utf8"));
    expect(json).toMatchObject({
      kind: "d76",
      threshold: "d76",
      maxCostRub: 1000,
      db: { b2: { rub: 123.4 } },
    });
    expect(readFileSync(summary, "utf8")).toContain("строгий порог D76 пройден");
  });

  it("the seed refused by the database: no briefs, SSH closed, the psql error without the statement's values", async () => {
    const cloud = fakeCloud();
    await bootstrap(cloud, fakeTools());
    const base = fakeTools({ namespaces: ["default", "wizard-platform"], founderJob: "1" });
    const run = (cmd, args, o = {}) => {
      const r = base.run(cmd, args, o);
      if (cmd === "kubectl" && args.includes("exec"))
        return {
          status: 3,
          stdout: "",
          stderr: `psql:<stdin>:9: ERROR:  duplicate key value violates unique constraint\nDETAIL:  Key (token_hash)=(${"f".repeat(64)}) already exists.\n`,
        };
      return r;
    };
    const calls = [];
    await expect(
      main(["eval", "--env", "prod", "--briefs", "mvp-01", ...reg()], FOUNDER, {
        fetch: (url, init = {}) => {
          if (new URL(url).host === "codename.ru") calls.push(url);
          return cloud.fetch(url, init);
        },
        run,
        has: () => true,
        exists: () => true,
        sleep: async () => {},
        kdf: FAST,
        tmpRoot: tmp,
        log: () => {},
        spendJournal: spendJournal(),
      }),
    ).rejects.toThrow(/psql в wizard-postgres-0: код 3: psql:<stdin>:9: ERROR: {2}duplicate key/);
    expect(calls).toEqual([]);
    expect(cloud.st.rules.get("fw-prod").map((r) => r.id)).toEqual(["keep"]);
  });
});

describe("runCounted (B2-41)", () => {
  const ready = { ready: true, gaps: { reported: [] } };
  it("d76: a ready system with out-of-scope items counts mid-run (the platform records them, the report re-checks)", () => {
    const r = {
      ...ready,
      plan: { coverage: "uncovered", outOfScope: [{ what: "оплата", replacement: null }] },
    };
    expect(runCounted("d76")(r)).toBe(true);
    expect(runCounted("d76")({ ...r, ready: false })).toBe(false);
    expect(runCounted("d76")({ ...ready, plan: { coverage: "unknown" } })).toBe(false);
  });
  it("d67: the report's counting", () => {
    expect(runCounted("d67")(ready)).toBe(true);
    expect(runCounted("d67")({ ready: false, gaps: { reported: [] } })).toBe(false);
  });
});

describe("serverStockProbe (B2-41: the stocks from the worker pod)", () => {
  it("prints HTTP codes only and becomes one annotation; never a key or a URL", () => {
    expect(SERVER_STOCK_PROBE).not.toMatch(/console\.log\([^)]*(key|KEY|url|u\b)/);
    expect(
      serverStockLine("pexels=404 pixabay=200 images.pexels.com=0:ENOTFOUND cdn.pixabay.com=200\n"),
    ).toBe(
      "pexels — HTTP 404; pixabay — HTTP 200; images.pexels.com — 0:ENOTFOUND; cdn.pixabay.com — HTTP 200",
    );
    expect(serverStockLine("error: unable to upgrade connection")).toBeNull();
    const calls = [];
    const logs = [];
    const line = serverStockProbe({
      kubectl: (args) => {
        calls.push(args);
        return { status: 0, stdout: "pexels=404 pixabay=200" };
      },
      log: (l) => logs.push(l),
    });
    expect(line).toBe("pexels — HTTP 404; pixabay — HTTP 200");
    expect(calls[0].slice(0, 5)).toEqual(["-n", "wizard-platform", "exec", "deploy/wizard-worker", "--"]);
    expect(logs).toEqual(["::notice title=Стоки с сервера::pexels — HTTP 404; pixabay — HTTP 200"]);
    serverStockProbe({ kubectl: () => ({ status: 1, stdout: "" }), log: (l) => logs.push(l) });
    expect(logs.at(-1)).toMatch(/^::warning title=Стоки с сервера::/);
  });
});

/** V3-18: kubectl exec of the v3 checkpoint and the probe — the worker's env, the probe script, psql in postgres. */
function v3Cluster({ pipeline = "modules", orgs = "eval", collect = "", probe = null } = {}) {
  const base = fakeTools({ namespaces: ["default", "wizard-platform"], founderJob: "1" });
  const db = { orgId: "11111111-1111-4111-8111-111111111111" };
  const seen = { sqls: [], scripts: [], orgsChecked: 0 };
  const run = (cmd, args, o = {}) => {
    const r = base.run(cmd, args, o);
    if (cmd !== "kubectl" || !args.includes("exec")) return r;
    if (args.includes("-e") && args.at(-1).includes("WIZARD_BUILD_PIPELINE_ORGS")) {
      seen.orgsChecked += 1;
      return { status: 0, stdout: `${pipeline}\n${orgs}` };
    }
    if (args.includes("--input-type=module")) {
      seen.scripts.push(o.input);
      return probe ? probe(o.input) : { status: 1, stdout: "", stderr: "Error: no probe" };
    }
    seen.sqls.push(o.input);
    if (o.input.includes("INSERT INTO platform.users")) {
      const email = /\\set email '([^']+)'/.exec(o.input)[1];
      return {
        status: 0,
        stdout: `${JSON.stringify({ userId: "22222222-2222-4222-8222-222222222222", orgId: db.orgId, sessionId: "33333333-3333-4333-8333-333333333333", email })}\n`,
      };
    }
    // V3-40: the payment check's session of the measurement org's owner.
    if (o.input.includes("WITH sys AS"))
      return {
        status: 0,
        stdout: `${JSON.stringify({ userId: "22222222-2222-4222-8222-222222222222", orgId: db.orgId, sessionId: "44444444-4444-4444-8444-444444444444" })}\n`,
      };
    if (o.input.includes("'costs='")) return { status: 0, stdout: collect };
    if (o.input.includes("'probe_rub='")) return { status: 0, stdout: "probe_rub=0.3412\n" };
    return { status: 0, stdout: "revoked=33333333-3333-4333-8333-333333333333\n" };
  };
  return { base, run, seen, db };
}

/** A v3 result as the driver leaves it (tools/eval/server/v3.mjs), for the pilot's report and spend. */
function v3Result(id, systemId) {
  return {
    id,
    class: "booking",
    title: "Стоматология: онлайн-запись",
    status: "ready",
    ready: true,
    systemId,
    error: null,
    runs: [],
    inputs: [],
    gaps: { outOfScope: [], reported: [], mentions: [] },
    interview: {
      turns: 4,
      questions: 3,
      retries: 0,
      free: 0,
      restAt: null,
      by: { recommended: 1, option: 0, delegate: 1, text: 1 },
      minutes: 2.1,
    },
    tz: null,
    direction: {
      names: ["А", "Б", "В"],
      archetypes: ["a", "b", "c"],
      costRub: 3.2,
      fallback: false,
      n: null,
      archetype: "a",
      pinned: false,
    },
    brief: {
      version: 5,
      goals: 1,
      scenarios: { must: 3, should: 1 },
      roles: 3,
      data: 2,
      integrations: 0,
      outOfScope: 0,
      assumptions: 2,
      qa: 3,
      capability: { modules: 3, custom: 0, not_yet: 0 },
      canariesKept: 0,
    },
    coverage: {
      score: 0.9,
      roles: { missing: [] },
      entities: { missing: [] },
      features: { missing: [] },
      acceptance: { missing: [] },
    },
    build: {
      runId: "55555555-5555-4555-8555-555555555555",
      status: "succeeded",
      minutes: 12.4,
      previewMinutes: 3.1,
      stages: [{ id: "skeleton", label: "Каркас", status: "done", sec: 120 }],
      spentRub: 240,
      reusedRub: 0,
      capRub: 500,
      scenarios: { total: 4, passed: 4, failed: 0, stopped: 0, toRequests: 0, mustNotPassed: 0, list: [] },
    },
    buildMinutes: 12.4,
    techreview: { status: "done", blocked: false },
    gates: {
      G0: { passed: true, blockers: [], ownerActions: [], warnings: 0 },
      G1: { passed: true, blockers: [], ownerActions: [], warnings: 0 },
      G2: { passed: true, blockers: [], ownerActions: [], warnings: 0 },
    },
    publish: { status: "review_pending" },
    screenshots: [{ label: "телефон, 390 px", src: "shots/x-390.png" }],
    creditsUsed: 52,
    costRubEstimate: 260,
    minutes: 15.2,
  };
}

describe("pilot: V3-18 — checkpoint 1 of v3 and the probe of the v3 routes", () => {
  const deps = (cloud, cluster, over = {}) => ({
    fetch: (url, init = {}) => cloud.fetch(url, init),
    run: cluster.run,
    has: () => true,
    exists: () => true,
    sleep: async () => {},
    kdf: FAST,
    tmpRoot: tmp,
    spendJournal: spendJournal(),
    ...over,
  });

  it("arguments: --threshold v3 for eval; v3-probe is pre-registered and capped at 30 ₽", () => {
    expect(
      parseArgs([
        "eval",
        "--env",
        "prod",
        "--threshold",
        "v3",
        "--briefs",
        "v3-02",
        ...reg("1400", { "--founder-ok": "yes", "--wave": "checkpoint" }),
      ]),
    ).toMatchObject({
      threshold: "v3",
      briefs: "v3-02",
      maxCostRub: 1400,
      spend: { wave: "checkpoint", founderOk: true },
    });
    expect(parseArgs(["v3-probe", "--env", "prod", ...reg("30", { "--expect-rub": "5" })])).toMatchObject({
      command: "v3-probe",
      maxCostRub: 30,
      spend: { wave: "A", expectRub: 5, capRub: 30 },
    });
    expect(() => parseArgs(["v3-probe", "--env", "prod", ...reg("31", { "--expect-rub": "5" })])).toThrow(
      /не больше 30 ₽/,
    );
    expect(() => parseArgs(["v3-probe", "--env", "prod"])).toThrow(/Платный прогон не начат/);
    expect(() => parseArgs(["v3-probe", "--env", "prod", "--briefs", "all", ...reg("30")])).toThrow(
      /unknown/,
    );
    // --shape: the shape probe; empty (the workflow's default) — the route probe, as without the flag.
    const shape = (v) =>
      parseArgs(["v3-probe", "--env", "prod", "--shape", v, ...reg("30", { "--expect-rub": "12" })]);
    expect(shape("techreview,critic").shape).toEqual(["critic", "techreview"]);
    expect(shape("")).not.toHaveProperty("shape");
    expect(
      parseArgs(["v3-probe", "--env", "prod", ...reg("30", { "--expect-rub": "5" })]),
    ).not.toHaveProperty("shape");
    expect(() => shape("critic;curl")).toThrow(/--shape/);
    expect(() => parseArgs(["eval", "--env", "prod", "--shape", "critic", ...reg("300")])).toThrow(/unknown/);
    // V3-40 --pay: the payment check of shops already built; empty (the workflow's default) — not this probe.
    const sys = "cd76a3c8-b8d0-4fa7-95de-c61108e9e11f";
    const pay = (v, extra = []) =>
      parseArgs(["v3-probe", "--env", "prod", "--pay", v, ...extra, ...reg("1", { "--expect-rub": "0" })]);
    expect(pay(sys).pay).toEqual([sys]);
    expect(pay("")).not.toHaveProperty("pay");
    expect(() => pay("not-a-system")).toThrow(/--pay/);
    expect(() => pay(sys, ["--shape", "critic"])).toThrow(/разные пробы/);
    expect(() => parseArgs(["eval", "--env", "prod", "--pay", sys, ...reg("300")])).toThrow(/unknown/);
  });

  it("v3-probe --shape: the shape script in the worker folder (run here without network), annotations per model, the report", async () => {
    const cloud = fakeCloud();
    await bootstrap(cloud, fakeTools());
    const cluster = v3Cluster({
      probe: (input) => {
        const r = spawnSync("node", PROBE_IN_POD.slice(1), {
          cwd: join(import.meta.dirname, "..", "..", "..", "apps", "worker"),
          input,
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: process.env.HOME ?? tmp },
          maxBuffer: 64 * 1024 * 1024,
        });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      },
    });
    const logs = [];
    const code = await main(
      [
        "v3-probe",
        "--env",
        "prod",
        "--shape",
        "critic,techreview",
        ...reg("30", {
          "--expect-rub": "12",
          "--purpose": "Формы запросов critic_visual и techreview",
          "--hypothesis": "Видно, какая форма отказывает и почему",
        }),
      ],
      FOUNDER,
      deps(cloud, cluster, {
        log: (l) => logs.push(l),
        probeFake: true,
        probeShapeFail: [
          { model: "Kimi", minImages: 2, message: "At most 1 image(s) may be provided in one request." },
        ],
      }),
    );
    // kimi refuses six images: the build shape of critic_visual did not work on every model → exit 1.
    expect(code, logs.filter((l) => l.startsWith("::")).join("\n")).toBe(1);
    expect(cluster.seen.scripts).toHaveLength(1);
    const script = cluster.seen.scripts[0];
    expect(script.startsWith('import * as llm from "@wizard/llm";')).toBe(true);
    expect(script).toContain(`"orgId":"${cluster.db.orgId}"`);
    for (const s of SECRETS) expect(script).not.toContain(s);
    expect(logs).toContainEqual(expect.stringMatching(/^проба формы запросов v3 .*ожидаемо ≈ [\d.]+ ₽/));
    const ann = logs.filter((l) => l.startsWith("::") && l.includes("title=V3 форма · "));
    expect(ann).toHaveLength(6);
    // The pod loaded the tools' own checks from @wizard/agents next to the worker.
    const kimi = ann.find((l) => l.includes("critic_visual · kimi-k2.6"));
    expect(kimi).toMatch(
      /^::warning title=V3 форма · critic_visual · kimi-k2\.6::как в сборке: ❌ LLM_UNAVAILABLE/,
    );
    expect(kimi).toContain("напрямую HTTP 400 «");
    expect(kimi).toContain("1 JPEG: ✅");
    expect(ann.find((l) => l.includes("techreview · deepseek-v4-pro"))).toMatch(
      /^::notice .*как в сборке: ✅.*сводка ×2: ✅.*второй ход: ✅/,
    );
    expect(logs).toContainEqual(
      expect.stringMatching(/^::error title=V3 форма::Как в сборке прошли 5 из 6 моделей/),
    );
    const dir = join(tmp, "wizard-eval-prod");
    const md = readdirSync(dir).find((f) => /^v3-shape-\d{4}-\d{2}-\d{2}-\d{8}-[0-9a-f]{6}\.md$/.test(f));
    const text = readFileSync(join(dir, md), "utf8");
    expect(text).toContain("**Итог: как в сборке прошли 5 из 6 моделей;");
    expect(text).toContain("Аргументы: @wizard/agents.");
    expect(text).toContain("Расход по журналу вызовов моделей: 0.3412 ₽.");
    const entry = JSON.parse(readFileSync(join(dir, "spend-entry.json"), "utf8"));
    expect(entry).toMatchObject({ wave: "A", capRub: 30, expectRub: 12, actualRub: 0.3412 });
    expect(entry.result).toMatch(/^форма: как в сборке прошли 5 из 6 моделей/);
    expect(cloud.st.rules.get("fw-prod").map((r) => r.id)).toEqual(["keep"]);
  }, 180_000);

  it("v3 on the server (D78): the default pipeline v3 (or empty) runs every org on v3; else WIZARD_BUILD_PIPELINE_ORGS", () => {
    const kubectl =
      (stdout, status = 0) =>
      () => ({ status, stdout });
    expect(v3OrgsOfServer(kubectl("v3\n"))).toEqual({ value: "", eval: true, via: "pipeline" });
    expect(v3OrgsOfServer(kubectl("\n"))).toEqual({ value: "", eval: true, via: "pipeline" });
    expect(v3OrgsOfServer(kubectl("modules\nEval, staff"))).toEqual({
      value: "Eval, staff",
      eval: true,
      via: "orgs",
    });
    expect(v3OrgsOfServer(kubectl("legacy\n"))).toMatchObject({ eval: false, via: "orgs" });
    expect(v3OrgsOfServer(kubectl("", 1))).toEqual({ value: "", eval: false });
  });

  it("eval v3 refuses to start when the server keeps eval orgs off v3: nothing seeded, nothing spent", async () => {
    const cloud = fakeCloud();
    await bootstrap(cloud, fakeTools());
    const cluster = v3Cluster({ orgs: "staff" });
    const logs = [];
    let driven = 0;
    const code = await main(
      ["eval", "--env", "prod", "--threshold", "v3", ...reg("1000", { "--wave": "checkpoint" })],
      FOUNDER,
      deps(cloud, cluster, { log: (l) => logs.push(l), v3Eval: async () => driven++ }),
    );
    expect(code).toBe(2);
    expect(cluster.seen.orgsChecked).toBe(1);
    expect(cluster.seen.sqls).toEqual([]);
    expect(driven).toBe(0);
    expect(logs).toContainEqual(
      expect.stringMatching(
        /^::error title=V3::На сервере организации замера не на v3: конвейер не v3, а WIZARD_BUILD_PIPELINE_ORGS = «staff» без eval/,
      ),
    );
    expect(cloud.st.rules.get("fw-prod").map((r) => r.id)).toEqual(["keep"]);
  });

  it("eval v3: the v3 briefs through the v3 driver, collect with the v3 lines, the checkpoint report and the spend entry", async () => {
    const cloud = fakeCloud();
    await bootstrap(cloud, fakeTools());
    const sid = "44444444-4444-4444-8444-444444444444";
    const collect = [
      `costs=${JSON.stringify([{ system_id: sid, rub: 251.3, credits_milli: 50260, calls: 41 }])}`,
      "gaps=[]",
      `v3calls=${JSON.stringify([{ system_id: sid, call_type: "page_compose", tier: "T1", model_id: "glm-5.3", attempts: 9, ok: 9, fallback: 0, scrubbed: true, rub: 180.5, input_tokens: 1, output_tokens: 1, latency_ms: 9000 }])}`,
      `v3hooks=${JSON.stringify([{ system_id: sid, key: "techreview", status: "done", notes: [], blockers: [], cost_milli: 1000, duration_ms: 1 }])}`,
      `v3similarity=${JSON.stringify([{ system_id: sid, archetype: "a", similarity: 0.41 }])}`,
      "v3events=[]",
      "v3t1forbidden=0",
      "",
    ].join("\n");
    const cluster = v3Cluster({ collect });
    const logs = [];
    const asked = [];
    const summary = join(tmp, "summary-v3.md");
    const code = await main(
      [
        "eval",
        "--env",
        "prod",
        "--threshold",
        "v3",
        "--briefs",
        "v3-02",
        ...reg("1400", { "--wave": "checkpoint", "--founder-ok": "yes" }),
      ],
      { ...FOUNDER, GITHUB_STEP_SUMMARY: summary },
      deps(cloud, cluster, {
        log: (l) => logs.push(l),
        evalScreenshots: () => ({ screenshot: async () => [], close: async () => {} }),
        v3Eval: async (o) => {
          asked.push(o);
          return {
            kind: "v3",
            threshold: "v3",
            base: "https://codename.ru",
            runId: o.runId,
            orgId: o.orgId,
            startedAt: "2026-10-09T07:00:00.000Z",
            finishedAt: "2026-10-09T07:16:00.000Z",
            maxCostRub: o.maxCostRub,
            concurrency: 2,
            peakConcurrency: 1,
            g2: "publish",
            fixAttempts: 1,
            failFast: false,
            stopped: null,
            results: [v3Result(o.briefs[0].id, sid)],
          };
        },
      }),
    );
    expect(code).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0].briefs.map((b) => b.id)).toEqual(["v3-02-dental-booking"]);
    expect(asked[0]).toMatchObject({ orgId: cluster.db.orgId, maxCostRub: 1400, threshold: "v3" });
    expect(typeof asked[0].screenshot).toBe("function");
    // The org «Замер V3 · …», then collect with the v3 lines, then the revoke.
    expect(cluster.seen.sqls[0]).toContain("\\set org_name 'Замер V3 · ");
    expect(cluster.seen.sqls[1]).toContain("'v3calls='");
    expect(cluster.seen.sqls[1]).toContain("'v3t1forbidden='");
    const dir = join(tmp, "wizard-eval-prod");
    const md = readdirSync(dir).find((f) => /^v3-a-checkpoint1-\d{4}-\d{2}-\d{2}\.md$/.test(f));
    expect(md).toBeTruthy();
    const text = readFileSync(join(dir, md), "utf8");
    expect(text).toContain("# Чекпоинт 1 волны A: замер v3 на сервере");
    expect(text).toContain("**Итог: готовы 1 из 1**");
    expect(text).toContain("| v3-02-dental-booking | услуги и запись | ✅ готова | 3.1 | 15.2 | 251 |");
    expect(text).toContain("| page_compose | 9 из 9 | glm-5.3 | T1 | 180,5 ₽ |");
    expect(text).toMatch(/- Итого: потрачено 251 ₽ из плана 2\s000 ₽ волны «Чекпоинты основателя»/);
    const entry = JSON.parse(readFileSync(join(dir, "spend-entry.json"), "utf8"));
    expect(entry).toMatchObject({
      wave: "checkpoint",
      capRub: 1400,
      founderOk: true,
      actualRub: 251.3,
      result: "готовы 1 из 1",
    });
    expect(readFileSync(summary, "utf8")).toContain("Чекпоинт 1 волны A");
    expect(logs).toContain("v3 для организаций замера включён (WIZARD_BUILD_PIPELINE_ORGS: eval)");
  });

  it("eval v3-final (V3-40): 12 briefs, shots at 390 and 1440 px, fingerprints in collect, the run report and the §6 report", async () => {
    const cloud = fakeCloud();
    await bootstrap(cloud, fakeTools());
    const sid = (i) => `44444444-4444-4444-8444-4444444444${String(i).padStart(2, "0")}`;
    const collect = [
      `costs=${JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ system_id: sid(i), rub: 250, credits_milli: 50000, calls: 40 })))}`,
      "gaps=[]",
      "v3calls=[]",
      "v3events=[]",
      "v3t1forbidden=0",
      "",
    ].join("\n");
    const cluster = v3Cluster({ collect });
    const logs = [];
    const asked = [];
    const shotOpts = [];
    const code = await main(
      [
        "eval",
        "--env",
        "prod",
        "--threshold",
        "v3-final",
        ...reg("3600", { "--wave": "final", "--founder-ok": "yes", "--expect-rub": "3000" }),
      ],
      FOUNDER,
      deps(cloud, cluster, {
        log: (l) => logs.push(l),
        evalScreenshots: (o) => {
          shotOpts.push(o);
          return { screenshot: async () => [], close: async () => {} };
        },
        v3Eval: async (o) => {
          asked.push(o);
          return {
            kind: "v3",
            threshold: "v3-final",
            base: "https://codename.ru",
            runId: o.runId,
            orgId: o.orgId,
            startedAt: "2026-10-20T07:00:00.000Z",
            finishedAt: "2026-10-20T09:00:00.000Z",
            maxCostRub: o.maxCostRub,
            concurrency: 2,
            peakConcurrency: 2,
            g2: "publish",
            fixAttempts: 1,
            failFast: false,
            stopped: null,
            results: o.briefs.map((b, i) => ({ ...v3Result(b.id, sid(i)), class: b.class, title: b.title })),
          };
        },
      }),
    );
    expect(code).toBe(0);
    expect(asked[0].briefs).toHaveLength(12);
    expect(asked[0]).toMatchObject({ threshold: "v3-final", maxCostRub: 3600 });
    expect(shotOpts[0].viewports.map((v) => v.width)).toEqual([390, 1440]);
    expect(cluster.seen.sqls[0]).toContain("\\set org_name 'Замер V3 · ");
    expect(cluster.seen.sqls[1]).toContain("'v3fingerprints='");
    const dir = join(tmp, "wizard-eval-prod");
    const run = readdirSync(dir).find((f) => /^v3-final-run-\d{4}-\d{2}-\d{2}\.md$/.test(f));
    expect(readFileSync(join(dir, run), "utf8")).toContain("# Финальный замер v3: прогон на сервере");
    expect(readdirSync(dir).some((f) => /^v3-final-run-\d{4}-\d{2}-\d{2}\.json$/.test(f))).toBe(true);
    const md = readdirSync(dir).find((f) => /^v3-final-\d{4}-\d{2}-\d{2}\.md$/.test(f));
    const text = readFileSync(join(dir, md), "utf8");
    // The run's systems carry no critic stage here: the design floor (10.10.2026) waits for its data too.
    expect(text).toContain(
      "**Итог: ⏳ ждёт данных — дизайн (оценка критика), слепое сравнение, разнообразие.**",
    );
    expect(text).toContain(
      "готовы 12 из 12 (сайт бизнеса 3/3, услуги и запись 3/3, CRM и админка 3/3, магазин 3/3)",
    );
    expect(text).toContain("| 2 | Слепое сравнение |");
    expect(text).toContain("ожидает оценщиков");
    // The spend of this run (3 000 ₽, not in the journal yet) counts against the 12 000 ₽ of v3.
    expect(text).toMatch(/с этим прогоном, ещё не закрытым в журнале: 3\s000 ₽/);
    expect(JSON.parse(readFileSync(join(dir, "spend-entry.json"), "utf8"))).toMatchObject({
      wave: "final",
      actualRub: 3000,
      result: "готовы 12 из 12",
    });
  });

  it("v3-probe --pay: the owner's session of the measurement org, a purchase per shop, logout and revoke, the report", async () => {
    const cloud = fakeCloud();
    await bootstrap(cloud, fakeTools());
    const cluster = v3Cluster();
    const logs = [];
    const api = [];
    const shops = ["cd76a3c8-b8d0-4fa7-95de-c61108e9e11f", "0c07ecad-db25-4a53-8a25-1cad47f688c8"];
    const code = await main(
      [
        "v3-probe",
        "--env",
        "prod",
        "--pay",
        shops.join(","),
        ...reg("1", {
          "--expect-rub": "0",
          "--purpose": "Проба оплаты магазинов финального замера",
          "--hypothesis": "Заказы оплачиваются тестовой картой",
        }),
      ],
      FOUNDER,
      deps(cloud, cluster, {
        log: (l) => logs.push(l),
        kassaEnv: { YOUKASSA_TEST_SHOP_ID: "123456", YOUKASSA_TEST_API_KEY: "test_kassa-secret" },
        launch: async () => {
          throw new Error("no browser in this test");
        },
        fetch: (url, init = {}) => {
          const u = new URL(url);
          if (u.host !== "codename.ru") return cloud.fetch(url, init);
          api.push(`${init.method ?? "GET"} ${u.pathname}`);
          // The platform answers nothing useful here: the keys step fails, the purchase never starts.
          return Promise.resolve(new Response(JSON.stringify({ error: { code: "NOPE" } }), { status: 500 }));
        },
      }),
    );
    // Neither shop paid → exit 1; nothing built, no model called.
    expect(code, logs.filter((l) => l.startsWith("::")).join("\n")).toBe(1);
    expect(cluster.seen.scripts).toHaveLength(0);
    const sessionSql = cluster.seen.sqls.find((q) => q.includes("WITH sys AS"));
    expect(sessionSql).toContain(`\\set systems '{${shops.join(",")}}'`);
    expect(sessionSql).toContain("o.kind = 'eval'");
    expect(cluster.seen.sqls.at(-1)).toContain("UPDATE platform.sessions SET revoked_at = now()");
    expect(api.at(-1)).toBe("POST /api/v1/auth/logout");
    // The code archive of each system is asked as its owner (here the platform refuses: a warning, not a failure).
    for (const id of shops) expect(api).toContain(`GET /api/v1/systems/${id}/repo/archive`);
    expect(logs).toContainEqual(expect.stringMatching(/^::warning::архив кода cd76a3c8-.*: HTTP 500/));
    for (const l of logs) expect(l).not.toContain("test_kassa-secret");
    const ann = logs.filter((l) => l.startsWith("::error title=Оплата · "));
    expect(ann).toHaveLength(2);
    const dir = join(tmp, "wizard-eval-prod");
    const json = readdirSync(dir).find((f) => /^v3-pay-\d{4}-\d{2}-\d{2}-\d{8}-[0-9a-f]{6}\.json$/.test(f));
    const doc = JSON.parse(readFileSync(join(dir, json), "utf8"));
    expect(doc).toMatchObject({ kind: "wizard-v3-pay-probe", orgId: cluster.db.orgId });
    expect(doc.results.map((r) => [r.systemId, r.payment.status])).toEqual(shops.map((id) => [id, "failed"]));
    const entry = JSON.parse(readFileSync(join(dir, "spend-entry.json"), "utf8"));
    expect(entry).toMatchObject({
      wave: "A",
      capRub: 1,
      expectRub: 0,
      actualRub: 0,
      result: "оплачено 0 из 2",
    });
  }, 120_000);

  it("v3-probe: an eval org, the script of the pod over stdin (run here without network), the exact ₽, the report", async () => {
    const cloud = fakeCloud();
    await bootstrap(cloud, fakeTools());
    // The pod: the very script, run in the worker's app folder with its tsx and @wizard/llm (fake answers, no network).
    const cluster = v3Cluster({
      probe: (input) => {
        expect(PROBE_IN_POD[0]).toBe("node");
        const r = spawnSync("node", PROBE_IN_POD.slice(1), {
          cwd: join(import.meta.dirname, "..", "..", "..", "apps", "worker"),
          input,
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: process.env.HOME ?? tmp },
        });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      },
    });
    const logs = [];
    const summary = join(tmp, "summary-probe.md");
    const code = await main(
      [
        "v3-probe",
        "--env",
        "prod",
        ...reg("30", {
          "--expect-rub": "5",
          "--purpose": "Проба маршрутов v3",
          "--hypothesis": "Все головы отвечают",
        }),
      ],
      { ...FOUNDER, GITHUB_STEP_SUMMARY: summary },
      deps(cloud, cluster, { log: (l) => logs.push(l), probeFake: true }),
    );
    expect(code, logs.filter((l) => l.startsWith("::")).join("\n")).toBe(0);
    // The org of the probe is an eval one (V3 label) and its session is revoked at once; the script has its id only.
    expect(cluster.seen.sqls[0]).toContain("\\set org_name 'Замер V3 · ");
    expect(cluster.seen.sqls[1]).toContain("UPDATE platform.sessions");
    expect(cluster.seen.sqls[2]).toContain("'probe_rub='");
    expect(cluster.seen.scripts).toHaveLength(1);
    expect(cluster.seen.scripts[0]).toContain(`"orgId":"${cluster.db.orgId}"`);
    expect(cluster.seen.scripts[0]).toContain('"capRub":30');
    for (const s of SECRETS) expect(cluster.seen.scripts[0]).not.toContain(s);
    const dir = join(tmp, "wizard-eval-prod");
    const md = readdirSync(dir).find((f) => /^v3-probe-\d{4}-\d{2}-\d{2}-\d{8}-[0-9a-f]{6}\.md$/.test(f));
    const text = readFileSync(join(dir, md), "utf8");
    expect(text).toContain("**Итог: ответили 8 из 8; расход");
    expect(text).toContain("| interview_v3 | glm-5.3 (T1) | ✅ ответила | glm-5.3 | T1 | default_T1 | да |");
    expect(text).toContain("| critic_visual | kimi-k2.6 (T0) | ✅ ответила | kimi-k2.6 | T0 |");
    expect(text).toContain("Расход по журналу вызовов моделей: 0.3412 ₽.");
    const entry = JSON.parse(readFileSync(join(dir, "spend-entry.json"), "utf8"));
    expect(entry).toMatchObject({
      wave: "A",
      capRub: 30,
      expectRub: 5,
      actualRub: 0.3412,
      result: "ответили 8 из 8",
    });
    expect(logs).toContainEqual(
      expect.stringMatching(/^::notice title=Траты v3::потрачено 0 ₽ из плана 2\s400 ₽ волны A/),
    );
    expect(cloud.st.rules.get("fw-prod").map((r) => r.id)).toEqual(["keep"]);
  }, 120_000);
});
