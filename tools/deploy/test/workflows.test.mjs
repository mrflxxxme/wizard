// L3-38 / M2-06: deploys run only on the self-hosted runner in Cloud.ru with short-lived credentials; prod only by the
// repository owner from main; both workflows are no-ops until the founder enables them.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLATFORM_PASSTHROUGH } from "../pilot-secrets.mjs";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const hasYaml = spawnSync("python3", ["-c", "import yaml"]).status === 0;
const load = (f) => {
  const text = readFileSync(join(ROOT, ".github/workflows", f), "utf8");
  const r = spawnSync(
    "python3",
    ["-c", "import sys,json,yaml; print(json.dumps(yaml.safe_load(sys.stdin)))"],
    {
      input: text,
      encoding: "utf8",
    },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  // YAML 1.1: the key `on` loads as true.
  const doc = JSON.parse(r.stdout);
  return { doc, on: doc.on ?? doc.true, text };
};

// GitHub Actions expression text: gh("inputs.env") is the literal dollar-brace expression for inputs.env.
const gh = (expr) => `$${"{{"} ${expr} }}`;

describe.skipIf(!hasYaml)("deploy workflows", () => {
  it("the deploy job runs only on the self-hosted runner in the provider's VPC, with OIDC and per-environment protection", () => {
    const { doc } = load("deploy-reusable.yml");
    const job = doc.jobs.deploy;
    expect(job["runs-on"]).toEqual(["self-hosted", "linux", `wizard-${gh("inputs.env")}`]);
    expect(job.environment).toBe(gh("inputs.env"));
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
    const steps = job.steps.map((s) => s.name ?? s.uses ?? s.run);
    expect(steps).toEqual(
      expect.arrayContaining(["Short-lived credentials (GitHub OIDC → OpenBao)", "Only commits of main"]),
    );
    // Long-lived secrets appear only in the bootstrap step, which is skipped once OpenBao is configured.
    for (const s of job.steps) {
      if (JSON.stringify(s).includes("secrets.")) {
        expect(s.name).toBe("Bootstrap credentials (before OpenBao)");
        expect(s.if).toBe("env.OPENBAO_ADDR == ''");
      }
    }
  });

  it("staging: after green ci on main, no-op notice until enabled", () => {
    const { doc, on } = load("deploy-staging.yml");
    expect(on.workflow_run).toEqual({ workflows: ["ci"], types: ["completed"], branches: ["main"] });
    expect(doc.jobs.gate["runs-on"]).toBe("ubuntu-latest");
    expect(JSON.stringify(doc.jobs.gate)).toContain("vars.WIZARD_DEPLOY_STAGING");
    expect(JSON.stringify(doc.jobs.gate)).toContain("::notice");
    expect(doc.jobs.deploy.uses).toBe("./.github/workflows/deploy-reusable.yml");
    expect(doc.jobs.deploy.with.env).toBe("staging");
    // On demand: created and destroyed from the dispatch form; prod has no destroy.
    expect(on.workflow_dispatch.inputs.mode.options).toEqual(["deploy", "apply", "destroy"]);
    expect(load("deploy-prod.yml").on.workflow_dispatch.inputs.mode.options).toEqual(["deploy", "apply"]);
    expect(load("deploy-reusable.yml").text).toContain("infra.mjs destroy --env");
  });

  it("prod: workflow_dispatch only; owner, main, confirmation and full SHA are checked before any runner in prod", () => {
    const { doc, on } = load("deploy-prod.yml");
    expect(Object.keys(on)).toEqual(["workflow_dispatch"]);
    const run = doc.jobs.authorize.steps[0].run;
    expect(doc.jobs.authorize.steps[0].env).toMatchObject({
      ACTOR: gh("github.actor"),
      TRIGGERING_ACTOR: gh("github.triggering_actor"),
      OWNER: gh("github.repository_owner"),
    });
    for (const check of [
      '"$ACTOR" != "$OWNER"',
      '"$TRIGGERING_ACTOR" != "$OWNER"',
      "refs/heads/main",
      '"PROD"',
      "{40}",
    ]) {
      expect(run).toContain(check);
    }
    expect(doc.jobs.deploy.needs).toBe("authorize");
    expect(doc.jobs.deploy.with.env).toBe("prod");
  });

  it("ci runs the license check with SBOM and the PgBouncer integration test", () => {
    const { doc } = load("ci.yml");
    expect(JSON.stringify(doc.jobs["supply-chain"])).toContain("pnpm licenses:check");
    expect(JSON.stringify(doc.jobs["supply-chain"])).toContain("sbom.mjs");
    expect(doc.jobs.pgbouncer.env.WIZARD_PGBOUNCER_BIN).toBe("/usr/sbin/pgbouncer");
    const images = load("images.yml").doc;
    expect(JSON.stringify(images.jobs.build)).toContain("cyclonedx-json");
  });
});

describe.skipIf(!hasYaml)("pilot workflows (GitHub-hosted, one button)", () => {
  it("bootstrap and deploy: workflow_dispatch only, one concurrency group per environment, the shared reusable", () => {
    for (const [f, command] of [
      ["bootstrap-pilot.yml", gh("inputs.action == 'apply' && 'bootstrap' || inputs.action")],
      ["deploy-pilot.yml", "deploy"],
    ]) {
      const { doc, on } = load(f);
      expect(Object.keys(on)).toEqual(["workflow_dispatch"]);
      expect(on.workflow_dispatch.inputs.env.options).toEqual(["prod", "staging"]);
      expect(doc.concurrency).toEqual({ group: `pilot-${gh("inputs.env")}`, "cancel-in-progress": false });
      expect(doc.jobs.pilot.uses).toBe("./.github/workflows/pilot-reusable.yml");
      expect(doc.jobs.pilot.with.command).toBe(command);
      expect(doc.jobs.pilot.permissions).toEqual({ contents: "read", packages: "write" });
    }
    // The read-only check comes first and is the default: a run without choosing anything changes nothing.
    const action = load("bootstrap-pilot.yml").on.workflow_dispatch.inputs.action;
    expect(action.options).toEqual(["check", "apply", "destroy"]);
    expect(action.default).toBe("check");
  });

  // The authorize step's shell, run with the given context (GITHUB_OUTPUT in a temporary file).
  const authorize = (over) => {
    const step = load("pilot-reusable.yml").doc.jobs.authorize.steps[0];
    const dir = mkdtempSync(join(tmpdir(), "wizard-authorize-"));
    try {
      const r = spawnSync("bash", ["-e", "-c", step.run], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GITHUB_OUTPUT: join(dir, "out"),
          ACTOR: "owner",
          TRIGGERING_ACTOR: "owner",
          OWNER: "owner",
          REF: "refs/heads/main",
          CONFIRM: "",
          SHA: "0123456789abcdef0123456789abcdef01234567",
          DEPLOY_ENV: "prod",
          COMMAND: "check",
          ...over,
        },
      });
      return { code: r.status, out: r.stdout };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("check: no PROD word, but still the owner only and main only", () => {
    expect(authorize({}).code).toBe(0);
    expect(authorize({ DEPLOY_ENV: "staging" }).code).toBe(0);
    expect(authorize({ COMMAND: "bootstrap" }).out).toContain("Подтверждение не совпало");
    expect(authorize({ COMMAND: "bootstrap", CONFIRM: "PROD" }).code).toBe(0);
    expect(authorize({ ACTOR: "someone" }).code).toBe(1);
    expect(authorize({ TRIGGERING_ACTOR: "someone" }).code).toBe(1);
    expect(authorize({ REF: "refs/heads/feature" }).code).toBe(1);
    expect(authorize({ COMMAND: "destroy" }).code).toBe(1);
    expect(authorize({ COMMAND: "plan" }).code).toBe(1);
  });

  it("check: no images, no OpenTofu/helm setup, no SSH to close, a short timeout", () => {
    const { doc } = load("pilot-reusable.yml");
    expect(doc.jobs.images.if).toBe("inputs.command != 'destroy' && inputs.command != 'check'");
    // A skipped images job does not block the pilot job.
    expect(doc.jobs.pilot.if).toContain("needs.images.result != 'failure'");
    const job = doc.jobs.pilot;
    expect(job["timeout-minutes"]).toBe(gh("inputs.command == 'check' && 5 || 90"));
    const step = (k) => job.steps.find((s) => s.name === k || s.uses?.startsWith(k));
    for (const heavy of [
      "opentofu/setup-opentofu",
      "OpenTofu provider cache",
      "Provider cache directory",
      "azure/setup-helm",
      "Tools",
    ])
      expect(step(heavy).if, heavy).toBe("inputs.command != 'check'");
    for (const always of ["actions/checkout", "Only commits of main", "actions/setup-node"])
      expect(step(always).if, always).toBeUndefined();
    expect(step(`Pilot (${gh("inputs.command")})`).run).toContain(
      'check) node tools/deploy/pilot.mjs check --env "$DEPLOY_ENV"',
    );
    expect(step("Close SSH access").if).toBe("always() && inputs.command != 'check'");
    expect(step("Clean up the runner").if).toBe("always()");
  });

  it("owner, main, environment, PROD and a full SHA are checked before any secret is read", () => {
    const { doc } = load("pilot-reusable.yml");
    const a = doc.jobs.authorize;
    expect(a["runs-on"]).toBe("ubuntu-latest");
    expect(JSON.stringify(a)).not.toContain("secrets.");
    for (const check of [
      '"$ACTOR" != "$OWNER"',
      '"$TRIGGERING_ACTOR" != "$OWNER"',
      "refs/heads/main",
      '"$CONFIRM" != "PROD"',
      '"$COMMAND" = "destroy" ] && [ "$DEPLOY_ENV" != "staging"',
      "{40}",
    ])
      expect(a.steps[0].run).toContain(check);
    expect(doc.jobs.images.needs).toBe("authorize");
    expect(doc.jobs.images.with).toEqual({ sha: gh("needs.authorize.outputs.sha"), ghcr: true });
    expect(doc.jobs.pilot.needs).toEqual(["authorize", "images"]);
  });

  it("the pilot job: GitHub-hosted, environment-scoped, read-only token, SSH closed whatever happens", () => {
    const { doc } = load("pilot-reusable.yml");
    const job = doc.jobs.pilot;
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job.environment).toBe(gh("inputs.env"));
    expect(job.permissions).toEqual({ contents: "read", packages: "read" });
    expect(job.env.WIZARD_GHCR_TOKEN).toBe(gh("secrets.WIZARD_GHCR_TOKEN || github.token"));
    for (const n of ["TWC_TOKEN", "WIZARD_STATE_PASSPHRASE", "CLOUDRU_API_KEY", "WIZARD_SMTP_PASSWORD"])
      expect(job.env[n]).toBe(gh(`secrets.${n}`));
    for (const n of ["WIZARD_PLATFORM_DOMAIN", "WIZARD_SYSTEMS_DOMAIN"])
      expect(job.env[n]).toBe(gh(`vars.${n}`));
    // Public repository, public logs: personal addresses come from secrets first (masked in the printed env).
    for (const n of ["WIZARD_ACME_EMAIL", "WIZARD_FOUNDER_EMAIL"])
      expect(job.env[n]).toBe(gh(`secrets.${n} || vars.${n}`));
    // Every setting the secrets file passes through to platform-api reaches the job's environment.
    for (const n of PLATFORM_PASSTHROUGH) expect(job.env, n).toHaveProperty(n);
    const names = job.steps.map((s) => s.name ?? s.uses);
    expect(names).toEqual(expect.arrayContaining(["Only commits of main", "Close SSH access"]));
    const close = job.steps.find((s) => s.name === "Close SSH access");
    expect(close.if).toBe("always() && inputs.command != 'check'");
    expect(close.run).toContain("pilot.mjs close-access");
    expect(JSON.stringify(job)).not.toContain("self-hosted");
    // Images: the pilot's SHA into GHCR when missing; a call never cancels a push's run.
    const images = load("images.yml");
    expect(Object.keys(images.on.workflow_call.inputs)).toEqual(["sha", "ghcr"]);
    expect(images.doc.concurrency.group).toBe(`images-${gh("github.workflow")}-${gh("github.ref")}`);
    expect(JSON.stringify(images.doc.jobs.build.steps)).toContain("imagetools inspect");
  });
});
