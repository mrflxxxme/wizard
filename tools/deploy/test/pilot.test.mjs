// Pilot from a GitHub-hosted runner (tools/deploy/pilot.mjs, pilot-secrets.mjs): founder inputs, the secrets bundle
// (generated once, encrypted, reused), the state bucket and the temporary SSH rule through a fake Timeweb API and a
// fake S3, the whole bootstrap/deploy/DR flow with a fake tofu/ssh/kubectl/helm. No cloud calls.
import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  bucketMatches,
  checkInputs,
  closeAdminAccess,
  ensureStateBucket,
  envVars,
  FOUNDER_STAFF_SQL,
  founderStaffJob,
  main,
  parseArgs,
  SHAPES,
  summaryText,
  tfvars,
  twcClient,
} from "../pilot.mjs";
import {
  alertSettings,
  clusterSecretFiles,
  decryptBundle,
  encryptBundle,
  ensureBundle,
  envFile,
  GENERATED,
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
    expect(f.platformEnv).toContain("WIZARD_S3_SECRET_ACCESS_KEY=files-secret\n");
    expect(f.platformEnv).toContain("WIZARD_SMTP_FROM=Wizard <noreply@codename.ru>\n");
    expect(f.platformEnv).toContain("CLOUDRU_API_KEY=cloudru-secret-key\n");
    expect(f.platformEnv).not.toContain("ZAI_API_KEY");
    expect(f.platformEnv).not.toContain("WALG");
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
    });
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
        WHERE accepted_at IS NULL AND revoked_at IS NULL;`;
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
    const id = step();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(q("SELECT is_staff FROM platform.users")).toBe("t");
    expect(step()).toBe(id);
  });
});
