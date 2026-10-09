// L3-38 / M2-06: deploys run only on the self-hosted runner in Cloud.ru with short-lived credentials; prod only by the
// repository owner from main; both workflows are no-ops until the founder enables them.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PILOT_PIPELINE_INPUTS, PLATFORM_PASSTHROUGH, STOCK_KEY_ENV } from "../pilot-secrets.mjs";

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

  it("ci runs the goal scenarios of the modules in three shards next to e2e (B2-28)", () => {
    const { doc } = load("ci.yml");
    expect(doc.jobs.goals.strategy.matrix.shard).toEqual(["1/3", "2/3", "3/3"]);
    expect(doc.jobs.goals.env.WIZARD_GOALS_SHARD).toBe(gh("matrix.shard"));
    const steps = JSON.stringify(doc.jobs.goals.steps);
    for (const f of ["goals.browser.test.ts", "goals-b218.browser.test.ts", "goals-time.browser.test.ts"])
      expect(steps).toContain(f);
    expect(steps).toContain("b2-build-v2.browser.test.ts");
    // V3-18: the goal scenarios of the eval briefs on the composed v3 pages (no model); every form variant — in e2e.
    expect(steps).toContain("v3-goals.browser.test.ts");
    expect(JSON.stringify(doc.jobs.e2e.steps)).toContain("v3-goals-variants.browser.test.ts");
    expect(JSON.stringify(doc.jobs.e2e.steps)).not.toContain("goals.browser.test.ts");
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
      expect(doc.jobs.pilot.permissions).toEqual({ contents: "read", packages: "write", issues: "write" });
    }
    // The read-only check comes first and is the default: a run without choosing anything changes nothing.
    const action = load("bootstrap-pilot.yml").on.workflow_dispatch.inputs.action;
    expect(action.options).toEqual(["check", "apply", "diagnose", "reboot", "destroy"]);
    expect(action.default).toBe("check");
    // eval has its own form (V3-01): prod only, the shared concurrency group of prod, which briefs and the threshold
    // (B2-41: d76 of beta v2 by default) and the pre-registration of the spend journal: no defaults to run on — the
    // cap, the purpose, the hypothesis, the expected ₽ and the wave are filled for each run; «да» is «no» unless chosen.
    const ev = load("eval-pilot.yml");
    expect(Object.keys(ev.on)).toEqual(["workflow_dispatch"]);
    expect(ev.doc.concurrency).toEqual({ group: "pilot-prod", "cancel-in-progress": false });
    expect(ev.doc.jobs.pilot.uses).toBe("./.github/workflows/pilot-reusable.yml");
    expect(ev.doc.jobs.pilot.permissions).toEqual({ contents: "read", packages: "write", issues: "write" });
    const inputs = ev.on.workflow_dispatch.inputs;
    expect(inputs.env).toBeUndefined();
    expect(inputs.briefs).toMatchObject({ type: "string", default: "all" });
    // V3-18: v3 — checkpoint 1 of v3 on the same form.
    expect(inputs.threshold).toMatchObject({ type: "choice", options: ["d76", "d67", "v3"], default: "d76" });
    expect(inputs.max_cost_rub).toBeUndefined();
    for (const n of ["cap_rub", "purpose", "hypothesis", "expect_rub", "confirm"])
      expect(inputs[n], n).toMatchObject({ type: "string", default: "" });
    expect(inputs.wave).toMatchObject({
      type: "choice",
      options: ["-", "A", "B", "C", "checkpoint", "final", "retry"],
      default: "-",
    });
    expect(inputs.founder_ok).toMatchObject({ type: "choice", options: ["no", "yes"], default: "no" });
    // actionlint of CI holds a workflow_dispatch form to 10 inputs.
    for (const f of ["bootstrap-pilot.yml", "deploy-pilot.yml", "eval-pilot.yml", "v3-probe.yml"])
      expect(Object.keys(load(f).on.workflow_dispatch.inputs).length, f).toBeLessThanOrEqual(10);
    expect(ev.doc.jobs.pilot.with).toMatchObject({
      env: "prod",
      command: "eval",
      briefs: gh("inputs.briefs"),
      cap_rub: gh("inputs.cap_rub"),
      threshold: gh("inputs.threshold"),
      wave: gh("inputs.wave"),
      purpose: gh("inputs.purpose"),
      hypothesis: gh("inputs.hypothesis"),
      expect_rub: gh("inputs.expect_rub"),
      founder_ok: gh("inputs.founder_ok"),
    });
    const reusableInputs = load("pilot-reusable.yml").on.workflow_call.inputs;
    for (const f of ["bootstrap-pilot.yml", "eval-pilot.yml", "v3-probe.yml"])
      for (const n of Object.keys(load(f).doc.jobs.pilot.with))
        expect(reusableInputs, `${f}: ${n}`).toHaveProperty(n);
    // D75: the daily model cap is raised for one deploy only (the next deploy without it is back to the default).
    const dep = load("deploy-pilot.yml");
    expect(dep.on.workflow_dispatch.inputs.llm_daily_cap_rub).toMatchObject({ type: "string", default: "" });
    expect(dep.doc.jobs.pilot.with.llm_daily_cap_rub).toBe(gh("inputs.llm_daily_cap_rub"));
    expect(load("pilot-reusable.yml").doc.jobs.pilot.env.WIZARD_LLM_DAILY_CAP_RUB).toBe(
      gh("inputs.llm_daily_cap_rub || vars.WIZARD_LLM_DAILY_CAP_RUB"),
    );
    // B2-41: the pipeline of new systems and the stock photos are deploy parameters (modules and off by default).
    expect(dep.on.workflow_dispatch.inputs.build_pipeline).toMatchObject({
      type: "choice",
      options: ["modules", "legacy"],
      default: "modules",
    });
    // B2-43: library — the photo library the release's runner fills (the stocks are closed for the server in RF).
    expect(dep.on.workflow_dispatch.inputs.stock_mode).toMatchObject({
      type: "choice",
      options: ["off", "library", "live"],
      default: "off",
    });
    expect(dep.doc.jobs.pilot.with).toMatchObject({
      build_pipeline: gh("inputs.build_pipeline"),
      pipeline_orgs: gh("inputs.pipeline_orgs"),
      stock_mode: gh("inputs.stock_mode"),
    });
    // V3-18: the orgs on v3 are a deploy parameter too (the variable is the fallback); the form stays ≤ 10 inputs.
    expect(dep.on.workflow_dispatch.inputs.pipeline_orgs).toMatchObject({ type: "string", default: "" });
    expect(load("pilot-reusable.yml").doc.jobs.pilot.env.WIZARD_BUILD_PIPELINE_ORGS).toBe(
      gh("inputs.pipeline_orgs || vars.WIZARD_BUILD_PIPELINE_ORGS"),
    );
    const penv = load("pilot-reusable.yml").doc.jobs.pilot.env;
    expect(penv.WIZARD_BUILD_PIPELINE).toBe(gh("inputs.build_pipeline || vars.WIZARD_BUILD_PIPELINE"));
    expect(penv.WIZARD_STOCK_MODE).toBe(gh("inputs.stock_mode || vars.WIZARD_STOCK_MODE"));
    // V3-18: v3 per org (the measurement orgs, the founder's) — the deploy form field, the repository variable as fallback.
    expect(penv.WIZARD_BUILD_PIPELINE_ORGS).toBe(
      gh("inputs.pipeline_orgs || vars.WIZARD_BUILD_PIPELINE_ORGS"),
    );
    for (const n of PILOT_PIPELINE_INPUTS) expect(penv, n).toHaveProperty(n);
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

  it("eval: the PROD word on prod, briefs and the spend journal record validated before any secret is read", () => {
    const ok = {
      COMMAND: "eval",
      CONFIRM: "PROD",
      EVAL_BRIEFS: "all",
      EVAL_THRESHOLD: "d76",
      EVAL_WAVE: "A",
      EVAL_PURPOSE: "Проба сборки",
      EVAL_HYPOTHESIS: "Брифы собираются",
      EVAL_EXPECT_RUB: "250",
      EVAL_CAP_RUB: "300",
      EVAL_FOUNDER_OK: "no",
    };
    expect(authorize(ok).code).toBe(0);
    expect(authorize({ ...ok, CONFIRM: "" }).out).toContain("Подтверждение не совпало");
    expect(authorize({ ...ok, EVAL_BRIEFS: "mvp-03,mvp-10" }).code).toBe(0);
    expect(authorize({ ...ok, EVAL_BRIEFS: "mvp-01; curl x" }).out).toContain("briefs");
    expect(authorize({ ...ok, EVAL_THRESHOLD: "d67" }).code).toBe(0);
    expect(authorize({ ...ok, EVAL_THRESHOLD: "v3", EVAL_BRIEFS: "v3-02,v3-04" }).code).toBe(0);
    expect(authorize({ ...ok, EVAL_THRESHOLD: "d76; curl x" }).out).toContain("threshold");
    // V3-01: a paid run only with its record in the spend journal; > 1 000 ₽ at once — with the founder's «да».
    for (const [k, v, why] of [
      ["EVAL_PURPOSE", "", "purpose и hypothesis"],
      ["EVAL_HYPOTHESIS", "", "purpose и hypothesis"],
      ["EVAL_WAVE", "-", "wave"],
      ["EVAL_EXPECT_RUB", "", "expect_rub"],
      ["EVAL_EXPECT_RUB", "1e3", "expect_rub"],
      ["EVAL_CAP_RUB", "", "cap_rub"],
      ["EVAL_CAP_RUB", "2e3", "cap_rub"],
      ["EVAL_CAP_RUB", "0", "cap_rub"],
      ["EVAL_FOUNDER_OK", "maybe", "founder_ok"],
      ["EVAL_CAP_RUB", "1500", "founder_ok=yes"],
    ]) {
      const r = authorize({ ...ok, [k]: v });
      expect(r.code, `${k}=${v}`).toBe(1);
      expect(r.out, `${k}=${v}`).toContain("::error title=Журнал трат v3::Платный прогон не начат");
      expect(r.out, `${k}=${v}`).toContain(why);
    }
    expect(authorize({ ...ok, EVAL_EXPECT_RUB: "12,5", EVAL_WAVE: "final" }).code).toBe(0);
    expect(authorize({ ...ok, EVAL_CAP_RUB: "3600", EVAL_FOUNDER_OK: "yes" }).code).toBe(0);
    // Deploys need none of it.
    expect(authorize({ COMMAND: "deploy", CONFIRM: "PROD" }).code).toBe(0);
    const dep = { COMMAND: "deploy", CONFIRM: "PROD" };
    expect(authorize({ ...dep, LLM_DAILY_CAP_RUB: "1100" }).code).toBe(0);
    expect(authorize({ ...dep, LLM_DAILY_CAP_RUB: "" }).code).toBe(0);
    expect(authorize({ ...dep, LLM_DAILY_CAP_RUB: "1e9" }).out).toContain("llm_daily_cap_rub");
    expect(authorize({ ...dep, LLM_DAILY_CAP_RUB: "0" }).code).toBe(1);
    expect(authorize({ ...dep, BUILD_PIPELINE: "legacy", STOCK_MODE: "live" }).code).toBe(0);
    expect(authorize({ ...dep, STOCK_MODE: "library" }).code).toBe(0);
    expect(authorize({ ...dep, BUILD_PIPELINE: "v3" }).out).toContain("build_pipeline");
    expect(authorize({ ...dep, STOCK_MODE: "record" }).out).toContain("stock_mode");
    const { doc } = load("pilot-reusable.yml");
    const job = doc.jobs.pilot;
    const run = job.steps.find((s) => s.name === `Pilot (${gh("inputs.command")})`).run;
    // Inputs reach the shell as environment variables, never spliced into the script.
    expect(run).toContain(
      'eval) node tools/deploy/pilot.mjs eval --env "$DEPLOY_ENV" --briefs "$EVAL_BRIEFS" --threshold "$EVAL_THRESHOLD" --wave "$EVAL_WAVE" --purpose "$EVAL_PURPOSE" --hypothesis "$EVAL_HYPOTHESIS" --expect-rub "$EVAL_EXPECT_RUB" --cap-rub "$EVAL_CAP_RUB" --founder-ok "$EVAL_FOUNDER_OK"',
    );
    expect(run).not.toContain("inputs.");
    expect(job.env.EVAL_BRIEFS).toBe(gh("inputs.briefs"));
    expect(job.env.EVAL_THRESHOLD).toBe(gh("inputs.threshold"));
    for (const [env, input] of [
      ["EVAL_CAP_RUB", "cap_rub"],
      ["EVAL_WAVE", "wave"],
      ["EVAL_PURPOSE", "purpose"],
      ["EVAL_HYPOTHESIS", "hypothesis"],
      ["EVAL_EXPECT_RUB", "expect_rub"],
      ["EVAL_FOUNDER_OK", "founder_ok"],
    ]) {
      expect(job.env[env], env).toBe(gh(`inputs.${input}`));
      expect(doc.jobs.authorize.steps[0].env[env], env).toBe(gh(`inputs.${input}`));
    }
    // The free text of the record never reaches a script as an expression (script injection).
    expect(doc.jobs.authorize.steps[0].run).not.toContain("inputs.");
    const report = job.steps.find((s) => s.name === "Eval report");
    expect(report.if).toBe("always() && (inputs.command == 'eval' || inputs.command == 'v3-probe')");
    expect(report.with.name).toBe(
      `${gh("inputs.command == 'v3-probe' && 'v3-probe' || inputs.threshold")}-eval-${gh("inputs.env")}-${gh("github.run_id")}`,
    );
    // d76 and v3 screenshots: Chromium of the workspace's Playwright, only for those measurements.
    const chromium = job.steps.find((s) => s.name === "Chromium for the screenshots");
    expect(chromium.if).toBe(
      "inputs.command == 'eval' && (inputs.threshold == 'd76' || inputs.threshold == 'v3')",
    );
    expect(chromium.run).toContain("playwright install --with-deps --only-shell chromium");
    expect(report.uses).toBe("actions/upload-artifact@v4");
    expect(report.with.path).toBe(`${gh("runner.temp")}/wizard-eval-${gh("inputs.env")}`);
    expect(job.steps.find((s) => s.name === "Clean up the runner").run).toContain("wizard-eval-");
  });

  it("V3-18 v3-probe: its own form, prod, pre-registered like eval and never over 30 ₽ — before any secret", () => {
    const pr = load("v3-probe.yml");
    expect(Object.keys(pr.on)).toEqual(["workflow_dispatch"]);
    expect(pr.doc.concurrency).toEqual({ group: "pilot-prod", "cancel-in-progress": false });
    expect(pr.doc.jobs.pilot.uses).toBe("./.github/workflows/pilot-reusable.yml");
    const inputs = pr.on.workflow_dispatch.inputs;
    expect(inputs.wave).toMatchObject({ type: "choice", options: ["A", "B", "C"], default: "A" });
    for (const n of ["purpose", "hypothesis", "expect_rub", "cap_rub", "confirm"])
      expect(inputs[n], n).toMatchObject({ type: "string", default: "" });
    expect(pr.doc.jobs.pilot.with).toMatchObject({
      env: "prod",
      command: "v3-probe",
      wave: gh("inputs.wave"),
      cap_rub: gh("inputs.cap_rub"),
      founder_ok: "no",
    });
    const ok = {
      COMMAND: "v3-probe",
      CONFIRM: "PROD",
      EVAL_BRIEFS: "all",
      EVAL_THRESHOLD: "d76",
      EVAL_WAVE: "A",
      EVAL_PURPOSE: "Проба маршрутов v3",
      EVAL_HYPOTHESIS: "Головы отвечают",
      EVAL_EXPECT_RUB: "5",
      EVAL_CAP_RUB: "30",
      EVAL_FOUNDER_OK: "no",
    };
    expect(authorize(ok).code).toBe(0);
    expect(authorize({ ...ok, CONFIRM: "" }).out).toContain("Подтверждение не совпало");
    expect(authorize({ ...ok, EVAL_PURPOSE: "" }).out).toContain("purpose и hypothesis");
    const over = authorize({ ...ok, EVAL_CAP_RUB: "31" });
    expect(over.code).toBe(1);
    expect(over.out).toContain("проба маршрутов v3 не дороже 30 ₽");
    const run = load("pilot-reusable.yml").doc.jobs.pilot.steps.find(
      (s) => s.name === `Pilot (${gh("inputs.command")})`,
    ).run;
    expect(run).toContain(
      'v3-probe) node tools/deploy/pilot.mjs v3-probe --env "$DEPLOY_ENV" --wave "$EVAL_WAVE" --purpose "$EVAL_PURPOSE" --hypothesis "$EVAL_HYPOTHESIS" --expect-rub "$EVAL_EXPECT_RUB" --cap-rub "$EVAL_CAP_RUB" --founder-ok "$EVAL_FOUNDER_OK" --shape "$PROBE_SHAPE"',
    );
    // The shape probe: one more field of the form (empty — the route probe), checked before any secret, for
    // v3-probe only; it reaches the script as an environment variable.
    expect(inputs.probe_shape).toMatchObject({ type: "string", default: "" });
    expect(pr.doc.jobs.pilot.with.probe_shape).toBe(gh("inputs.probe_shape"));
    const reusable = load("pilot-reusable.yml").doc;
    expect(load("pilot-reusable.yml").on.workflow_call.inputs.probe_shape).toMatchObject({
      type: "string",
      default: "",
    });
    expect(reusable.jobs.pilot.env.PROBE_SHAPE).toBe(gh("inputs.probe_shape"));
    expect(reusable.jobs.authorize.steps[0].env.PROBE_SHAPE).toBe(gh("inputs.probe_shape"));
    for (const v of ["critic", "techreview", "critic,techreview", "techreview,critic"])
      expect(authorize({ ...ok, PROBE_SHAPE: v }).code, v).toBe(0);
    for (const v of ["page", "critic;curl x", "critic,", "critic,techreview,critic"]) {
      const r = authorize({ ...ok, PROBE_SHAPE: v });
      expect(r.code, v).toBe(1);
      expect(r.out, v).toContain("probe_shape — critic, techreview или critic,techreview");
    }
    expect(authorize({ COMMAND: "deploy", CONFIRM: "PROD", PROBE_SHAPE: "critic" }).out).toContain(
      "probe_shape — только для v3-probe",
    );
  });

  it("check: no images, no OpenTofu/helm setup, no SSH to close, a short timeout", () => {
    const { doc } = load("pilot-reusable.yml");
    // diagnose reads the running cluster: no images either.
    expect(doc.jobs.images.if).toBe(
      "inputs.command != 'destroy' && inputs.command != 'check' && inputs.command != 'diagnose' && inputs.command != 'eval' && inputs.command != 'v3-probe' && inputs.command != 'reboot'",
    );
    // A skipped images job does not block the pilot job.
    expect(doc.jobs.pilot.if).toContain("needs.images.result != 'failure'");
    const job = doc.jobs.pilot;
    expect(job["timeout-minutes"]).toBe(
      gh(
        "inputs.command == 'check' && 5 || inputs.command == 'eval' && 330 || inputs.command == 'v3-probe' && inputs.probe_shape != '' && 90 || inputs.command == 'v3-probe' && 30 || 90",
      ),
    );
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
    // issues: write — only the live progress of eval (the token reaches the step for eval only).
    expect(job.permissions).toEqual({ contents: "read", packages: "read", issues: "write" });
    const pilotStep = job.steps.find((s) => String(s.name).startsWith("Pilot"));
    expect(pilotStep.env.GITHUB_TOKEN).toBe(gh("inputs.command == 'eval' && github.token || ''"));
    // Public packages: the cluster pulls anonymously; the job token only checks that the images are there.
    expect(job.env.WIZARD_GHCR_TOKEN).toBe(gh("secrets.WIZARD_GHCR_TOKEN"));
    expect(job.env.WIZARD_GHCR_JOB_TOKEN).toBe(gh("github.token"));
    expect(job.env.WIZARD_GHCR_ANONYMOUS).toBe("1");
    for (const n of ["TWC_TOKEN", "WIZARD_STATE_PASSPHRASE", "CLOUDRU_API_KEY", "WIZARD_SMTP_PASSWORD"])
      expect(job.env[n]).toBe(gh(`secrets.${n}`));
    // B2-38: the stock keys come from the secrets of the same name (pilot-secrets.mjs STOCK_KEY_ENV reads them).
    for (const [input] of Object.values(STOCK_KEY_ENV)) expect(job.env[input]).toBe(gh(`secrets.${input}`));
    for (const n of ["WIZARD_PLATFORM_DOMAIN", "WIZARD_SYSTEMS_DOMAIN"])
      expect(job.env[n]).toBe(gh(`vars.${n}`));
    // Public repository, public logs: personal addresses come from secrets first (masked in the printed env).
    for (const n of ["WIZARD_ACME_EMAIL", "WIZARD_FOUNDER_EMAIL"])
      expect(job.env[n]).toBe(gh(`secrets.${n} || vars.${n}`));
    // The founder's Timeweb S3 account key, under names no runner tool reads implicitly.
    expect(job.env.WIZARD_S3_ACCOUNT_KEY_ID).toBe(gh("secrets.AWS_ACCESS_KEY_ID"));
    expect(job.env.WIZARD_S3_ACCOUNT_SECRET).toBe(gh("secrets.AWS_SECRET_ACCESS_KEY"));
    expect(job.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    // The VM region: the run's input wins over the repository variable (ru-1 when Moscow has no free node).
    expect(job.env.WIZARD_TIMEWEB_LOCATION).toBe(gh("inputs.location || vars.WIZARD_TIMEWEB_LOCATION"));
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

  it("B2-43 stock-library: after a successful release with library outputs, keys only in its step, masked first", () => {
    const { doc } = load("pilot-reusable.yml");
    const pilotStep = doc.jobs.pilot.steps.find((s) => String(s.name).startsWith("Pilot"));
    expect(pilotStep.id).toBe("pilot");
    expect(doc.jobs.pilot.outputs).toEqual({
      files_bucket: gh("steps.pilot.outputs.files_bucket"),
      s3_endpoint: gh("steps.pilot.outputs.s3_endpoint"),
      s3_region: gh("steps.pilot.outputs.s3_region"),
    });
    const job = doc.jobs["stock-library"];
    expect(job.needs).toEqual(["authorize", "pilot"]);
    expect(job.if).toBe(
      gh("!cancelled() && needs.pilot.result == 'success' && needs.pilot.outputs.files_bucket != ''"),
    );
    // A seeding problem never fails the release; read-only token; the same environment (its secrets) as the release.
    expect(job["continue-on-error"]).toBe(true);
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBe(gh("inputs.env"));
    expect(job.env).toBeUndefined();
    expect(job.steps[0].with.ref).toBe(gh("needs.authorize.outputs.sha"));
    const install = job.steps.find((s) => String(s.run ?? "").includes("pnpm install"));
    expect(install.env).toBeUndefined();
    const withSecrets = job.steps.filter((s) => JSON.stringify(s.env ?? {}).includes("secrets."));
    expect(withSecrets.map((s) => s.name)).toEqual(["Photo library"]);
    const step = withSecrets[0];
    expect(step.env).toEqual({
      PEXELS_API_KEY: gh("secrets.PEXELS_API_KEY"),
      PIXABAY_API_KEY: gh("secrets.PIXABAY_API_KEY"),
      // The S3 account key the pods get (pilot-secrets.mjs clusterSecretFiles), under the runtime's names.
      WIZARD_S3_ACCESS_KEY_ID: gh("secrets.AWS_ACCESS_KEY_ID"),
      WIZARD_S3_SECRET_ACCESS_KEY: gh("secrets.AWS_SECRET_ACCESS_KEY"),
      WIZARD_FILES_STORAGE: "s3",
      WIZARD_S3_BUCKET: gh("needs.pilot.outputs.files_bucket"),
      WIZARD_S3_ENDPOINT: gh("needs.pilot.outputs.s3_endpoint"),
      WIZARD_S3_REGION: gh("needs.pilot.outputs.s3_region"),
    });
    const lines = step.run.trim().split("\n");
    const secretVars = [
      "PEXELS_API_KEY",
      "PIXABAY_API_KEY",
      "WIZARD_S3_ACCESS_KEY_ID",
      "WIZARD_S3_SECRET_ACCESS_KEY",
    ];
    expect(lines).toEqual([
      `for v in ${secretVars.map((k) => `"$${k}"`).join(" ")}; do if [ -n "$v" ]; then echo "::add-mask::$v"; fi; done`,
      "node tools/deploy/stock-library.mjs seed",
    ]);
    const r = spawnSync("bash", ["-e", "-c", lines[0]], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, PEXELS_API_KEY: "px-1", WIZARD_S3_SECRET_ACCESS_KEY: "s3-2" },
    });
    expect(r.stdout).toBe("::add-mask::px-1\n::add-mask::s3-2\n");
  });
});

describe.skipIf(!hasYaml)("stock workflow (B2-38: the stock keys from CI)", () => {
  const STOCK_SECRETS = ["PEXELS_API_KEY", "PIXABAY_API_KEY"];
  const keyNames = (step) =>
    STOCK_SECRETS.filter((n) => JSON.stringify(step.env ?? {}).includes(`secrets.${n}`));

  it("workflow_dispatch with action check | probe | record, one run at a time, a job per action", () => {
    const { doc, on } = load("stock.yml");
    expect(Object.keys(on)).toEqual(["workflow_dispatch"]);
    expect(on.workflow_dispatch.inputs.action).toMatchObject({
      type: "choice",
      options: ["check", "probe", "record"],
      default: "check",
    });
    expect(on.workflow_dispatch.inputs.briefs).toMatchObject({ type: "string", default: "" });
    expect(doc.concurrency).toEqual({ group: "stock", "cancel-in-progress": false });
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(Object.keys(doc.jobs)).toEqual(["check", "probe", "record"]);
    for (const [name, job] of Object.entries(doc.jobs)) {
      expect(job.if).toBe(`inputs.action == '${name}'`);
      expect(job["runs-on"]).toBe("ubuntu-latest");
      expect(job["timeout-minutes"]).toBeLessThanOrEqual(15);
      // No PROD confirmation, no environment: nothing here touches the server.
      expect(job.environment).toBeUndefined();
    }
    // Minimal permissions: issues only for the probe's comment, contents/PR write only for the recording.
    expect(doc.jobs.check.permissions).toEqual({ contents: "read" });
    expect(doc.jobs.probe.permissions).toEqual({ contents: "read", issues: "write" });
    expect(doc.jobs.record.permissions).toEqual({ contents: "write", "pull-requests": "write" });
  });

  it("keys only in the env of the step that uses them, masked first; never in a script, a job env or an install", () => {
    const { doc, text } = load("stock.yml");
    expect(doc.env).toBeUndefined();
    const used = {};
    for (const [name, job] of Object.entries(doc.jobs)) {
      expect(job.env, name).toBeUndefined();
      for (const step of job.steps) {
        expect(String(step.run ?? ""), `${name}: ${step.name}`).not.toContain("secrets.");
        expect(JSON.stringify(step.with ?? {})).not.toContain("secrets.");
        const keys = keyNames(step);
        if (keys.length === 0) continue;
        used[name] = keys;
        for (const k of keys) expect(step.env[k]).toBe(gh(`secrets.${k}`));
        const lines = step.run.trim().split("\n");
        // The first line masks every key of the step before anything runs.
        // One key — a plain `if` (a one-word `for` loop is shellcheck SC2066, actionlint fails on it).
        expect(lines[0]).toBe(
          keys.length === 1
            ? `if [ -n "$${keys[0]}" ]; then echo "::add-mask::$${keys[0]}"; fi`
            : `for v in ${keys.map((k) => `"$${k}"`).join(" ")}; do if [ -n "$v" ]; then echo "::add-mask::$v"; fi; done`,
        );
        expect(lines.slice(1).join("\n")).toMatch(/^node tools\/deploy\/stock-ci\.mjs (check|probe|record)$/);
      }
    }
    // The recording gets only the Pexels key (Pixabay answers are never kept).
    expect(used).toEqual({ check: STOCK_SECRETS, probe: STOCK_SECRETS, record: ["PEXELS_API_KEY"] });
    // Installation never sees a key.
    for (const job of Object.values(doc.jobs))
      for (const step of job.steps.filter((s) => String(s.run ?? "").includes("pnpm install")))
        expect(step.env).toBeUndefined();
    expect(text.match(/secrets\.[A-Z_]+/g).sort()).toEqual(
      ["PEXELS_API_KEY", "PEXELS_API_KEY", "PEXELS_API_KEY", "PIXABAY_API_KEY", "PIXABAY_API_KEY"].map(
        (n) => `secrets.${n}`,
      ),
    );
  });

  it("the masking line hides each key and skips an empty one", () => {
    const line = `for v in "$PEXELS_API_KEY" "$PIXABAY_API_KEY"; do if [ -n "$v" ]; then echo "::add-mask::$v"; fi; done`;
    const r = spawnSync("bash", ["-e", "-c", line], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, PEXELS_API_KEY: "px-1", PIXABAY_API_KEY: "" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("::add-mask::px-1\n");
  });

  it("probe: briefs and the issue token reach the script as env; record: main only, tests, then the PR", () => {
    const { doc } = load("stock.yml");
    const probe = doc.jobs.probe.steps.find((s) => s.name === "Probe of the photos stage");
    expect(probe.env).toMatchObject({
      GITHUB_TOKEN: gh("github.token"),
      STOCK_PROBE_BRIEFS: gh("inputs.briefs"),
    });
    expect(probe.run).not.toContain("inputs.");
    const names = doc.jobs.record.steps.map((s) => s.name ?? s.uses ?? s.run);
    expect(names).toEqual([
      "Only from main",
      "actions/checkout@v4",
      "pnpm/action-setup@v4",
      "actions/setup-node@v4",
      "pnpm install --frozen-lockfile",
      "Record the Pexels answers",
      "Fixture tests on the recording",
      "Pull request",
    ]);
    const only = doc.jobs.record.steps[0];
    expect(only.env.REF).toBe(gh("github.ref"));
    expect(only.run).toContain('"$REF" != "refs/heads/main"');
    const tests = doc.jobs.record.steps.find((s) => s.name === "Fixture tests on the recording");
    expect(tests.run).toContain("packages/agents/test/stock.test.ts");
    const pr = doc.jobs.record.steps.find((s) => s.name === "Pull request");
    expect(pr.env.GH_TOKEN).toBe(gh("github.token"));
    expect(Object.keys(pr.env)).not.toContain("PEXELS_API_KEY");
  });

  /** The PR step's shell in a scratch clone (a bare «origin», a fake gh that prints the PR number). */
  const prStep = (prepare, ghScript = "echo 17") => {
    const run = load("stock.yml").doc.jobs.record.steps.find((s) => s.name === "Pull request").run;
    const dir = mkdtempSync(join(tmpdir(), "wizard-stock-pr-"));
    const git = (cwd, ...a) => {
      const r = spawnSync("git", a, { cwd, encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout;
    };
    try {
      git(dir, "init", "-q", "--bare", "-b", "main", "origin.git");
      git(dir, "clone", "-q", join(dir, "origin.git"), "work");
      const work = join(dir, "work");
      git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
      git(work, "push", "-q", "origin", "HEAD:main");
      mkdirSync(join(work, "tools/fixtures/stock"), { recursive: true });
      prepare(work);
      mkdirSync(join(dir, "bin"));
      writeFileSync(
        join(dir, "bin", "gh"),
        `#!/bin/sh\necho "$@" > "${join(dir, "gh-args")}"\n${ghScript}\n`,
        {
          mode: 0o755,
        },
      );
      const r = spawnSync("bash", ["-e", "-c", run], {
        cwd: work,
        encoding: "utf8",
        env: {
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          HOME: dir,
          GITHUB_REPOSITORY: "o/r",
          RUN_ID: "42",
          RUN_URL: "https://run/42",
          GH_TOKEN: "t",
        },
      });
      const branches = git(join(dir, "origin.git"), "branch", "--list");
      let args = "";
      try {
        args = readFileSync(join(dir, "gh-args"), "utf8");
      } catch {}
      return { code: r.status, out: r.stdout + r.stderr, branches, args };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("PR step: no change → «без изменений»; the recording → branch stock-record/<run> and a PR into main", () => {
    const recorded = (w) => writeFileSync(join(w, "tools/fixtures/stock/pexels.recorded.json"), "{}\n");
    const same = prStep(() => {});
    expect(same.code).toBe(0);
    expect(same.out).toContain("::notice title=Стоки: запись фикстур::без изменений");
    expect(same.branches).not.toContain("stock-record");
    const rec = prStep(recorded);
    expect(rec.code, rec.out).toBe(0);
    expect(rec.out).toContain("::notice title=Стоки: запись фикстур::PR #17 из stock-record/42 в main");
    expect(rec.branches).toContain("stock-record/42");
    expect(rec.args).toContain("api repos/o/r/pulls");
    expect(rec.args).toContain("head=stock-record/42");
    expect(rec.args).toContain("base=main");
    const other = prStep((w) => {
      recorded(w);
      writeFileSync(join(w, "other.txt"), "x");
    });
    expect(other.code).toBe(1);
    expect(other.out).toContain("изменилось что-то кроме pexels.recorded.json");
    const refused = prStep(recorded, "exit 1");
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("ветка stock-record/42 отправлена, но PR не создан");
  });
});

describe.skipIf(!hasYaml)(
  "integrations-sandbox workflow (V3-22: the API passports on the test contours)",
  () => {
    const KEYS = {
      cdek: ["CDEK_TEST_ACCOUNT", "CDEK_TEST_SECURE"],
      yookassa: ["YOOKASSA_TEST_SHOP_ID", "YOOKASSA_TEST_SECRET_KEY"],
    };
    const STEPS = { cdek: "CDEK test contour", yookassa: "YooKassa test shop" };

    it("workflow_dispatch only, read-only token, GitHub-hosted, one run at a time, no environment", () => {
      const { doc, on } = load("integrations-sandbox.yml");
      expect(Object.keys(on)).toEqual(["workflow_dispatch"]);
      expect(on.workflow_dispatch.inputs.passports).toMatchObject({
        type: "choice",
        options: ["all", "cdek", "yookassa"],
        default: "all",
      });
      expect(on.workflow_dispatch.inputs.cdek_order).toMatchObject({ type: "boolean", default: false });
      expect(doc.permissions).toEqual({ contents: "read" });
      expect(doc.concurrency).toEqual({ group: "integrations-sandbox", "cancel-in-progress": false });
      expect(Object.keys(doc.jobs)).toEqual(["sandbox"]);
      const job = doc.jobs.sandbox;
      expect(job["runs-on"]).toBe("ubuntu-latest");
      expect(job["timeout-minutes"]).toBeLessThanOrEqual(15);
      expect(job.permissions).toBeUndefined();
      expect(job.environment).toBeUndefined();
      expect(job.env).toBeUndefined();
    });

    it("one step per passport (≤ 10 annotations of a level per step), each after a good install, even if the other failed", () => {
      const { doc } = load("integrations-sandbox.yml");
      const steps = doc.jobs.sandbox.steps;
      const install = steps.find((s) => String(s.run ?? "").includes("pnpm install"));
      expect(install).toMatchObject({ id: "install", run: "pnpm install --frozen-lockfile" });
      expect(install.env).toBeUndefined();
      for (const [id, name] of Object.entries(STEPS)) {
        const step = steps.find((s) => s.name === name);
        expect(step.if).toBe(
          gh(
            `!cancelled() && steps.install.outcome == 'success' && (inputs.passports == 'all' || inputs.passports == '${id}')`,
          ),
        );
        // The first line masks every key of the step before anything runs.
        expect(step.run.trim().split("\n")).toEqual([
          `for v in ${KEYS[id].map((k) => `"$${k}"`).join(" ")}; do if [ -n "$v" ]; then echo "::add-mask::$v"; fi; done`,
          `node tools/integrations/sandbox-check.mjs --passports=${id}`,
        ]);
      }
      // The order option reaches the script as env, never as text of the script.
      expect(steps.find((s) => s.name === STEPS.cdek).env.CDEK_ORDER).toBe(gh("inputs.cdek_order"));
      for (const s of steps) expect(String(s.run ?? "")).not.toContain("inputs.");
    });

    it("keys only in the env of their own step; nowhere else", () => {
      const { doc, text } = load("integrations-sandbox.yml");
      for (const step of doc.jobs.sandbox.steps) {
        expect(String(step.run ?? "")).not.toContain("secrets.");
        expect(JSON.stringify(step.with ?? {})).not.toContain("secrets.");
        const id = Object.keys(STEPS).find((k) => STEPS[k] === step.name);
        const own = id ? KEYS[id] : [];
        for (const k of own) expect(step.env[k]).toBe(gh(`secrets.${k}`));
        expect(
          Object.values(step.env ?? {})
            .join(" ")
            .match(/secrets\.[A-Z_]+/g) ?? [],
        ).toEqual(own.map((k) => `secrets.${k}`));
      }
      expect(text.match(/secrets\.[A-Z_]+/g).sort()).toEqual(
        [...KEYS.cdek, ...KEYS.yookassa].map((k) => `secrets.${k}`).sort(),
      );
    });
  },
);
