// V3-32: the local runner of the repository sandbox. It exists only with WIZARD_UNSAFE_LOCAL_EXEC=1 and an explicit
// WIZARD_REPO_SANDBOX=process; it builds the environment from scratch (no platform secrets), never writes outside its
// directory, kills a command at its limit and refuses network outside the install phase. The cloud runner (gVisor pods)
// is tested in v3-repo-pod-sandbox.test.ts. The commands below are this test's own (node -e), not a client's code.

import { agentCommand, SandboxPolicyError, snapshotOf } from "@wizard/agents/repo";
import { describe, expect, test } from "vitest";
import { ProcessSandbox, repoSandboxFromEnv, sandboxEnv } from "../src/repo-agent/index.js";

const node = (phase: "install" | "build" | "test" | "agent", code: string, timeoutMs = 20_000) => ({
  phase,
  argv: [process.execPath, "-e", code],
  network: phase === "install" ? ("registry" as const) : ("none" as const),
  timeoutMs,
  label: "node -e",
});

describe("the local runner", () => {
  test("only with WIZARD_UNSAFE_LOCAL_EXEC=1 and WIZARD_REPO_SANDBOX=process", () => {
    expect(repoSandboxFromEnv({ unsafeLocalExec: false }, { WIZARD_REPO_SANDBOX: "process" })).toBeNull();
    expect(repoSandboxFromEnv({ unsafeLocalExec: true }, {})).toBeNull();
    expect(repoSandboxFromEnv({ unsafeLocalExec: true }, { WIZARD_REPO_SANDBOX: "process" })?.kind).toBe(
      "process",
    );
  });

  test("the environment is built from scratch: no secrets; no network outside install", () => {
    const base = {
      PATH: "/usr/bin",
      WIZARD_SECRETS_KEY: "s3cr3t",
      CLOUDRU_API_KEY: "k",
      HTTPS_PROXY: "http://proxy.wizard:3128",
      DATABASE_URL: "postgres://x",
    };
    const none = sandboxEnv("/tmp/wz-repo-x", { network: "none" }, base);
    expect(JSON.stringify(none)).not.toMatch(/s3cr3t|CLOUDRU|DATABASE_URL|WIZARD_/);
    expect(none).toMatchObject({ npm_config_offline: "true", HTTPS_PROXY: "http://127.0.0.1:9", CI: "1" });
    const install = sandboxEnv("/tmp/wz-repo-x", { network: "registry" }, base);
    expect(install.HTTPS_PROXY).toBe("http://proxy.wizard:3128");
    expect(install.npm_config_offline).toBeUndefined();
    expect(JSON.stringify(install)).not.toMatch(/s3cr3t|CLOUDRU|DATABASE_URL/);
  });

  test("files stay inside the workspace; commands see no secrets, hit their limit, and get no network outside install", async () => {
    const sb = new ProcessSandbox({ PATH: process.env.PATH, WIZARD_SECRETS_KEY: "s3cr3t" });
    const ws = await sb.open(
      snapshotOf({
        "package.json": '{"name":"x"}',
        "src/a.txt": "текст",
        "evil-link": { link: "../../../../etc/passwd" },
        "abs-link": { link: "/etc/passwd" },
        "ok-link": { link: "src/a.txt" },
      }),
    );
    try {
      const ls = await ws.run(
        node(
          "build",
          `const fs=require("fs");console.log(JSON.stringify({a:fs.readFileSync("src/a.txt","utf8"),evil:fs.existsSync("evil-link"),abs:fs.existsSync("abs-link"),ok:fs.readFileSync("ok-link","utf8"),secret:process.env.WIZARD_SECRETS_KEY??null,offline:process.env.npm_config_offline}))`,
        ),
      );
      expect(ls.ok).toBe(true);
      expect(JSON.parse(ls.output.trim())).toEqual({
        a: "текст",
        evil: false,
        abs: false,
        ok: "текст",
        secret: null,
        offline: "true",
      });
      await ws.write(
        new Map<string, string | null>([
          ["../outside.txt", "x"],
          ["src/b.txt", "новый"],
        ]),
      );
      const b = await ws.run(node("test", `console.log(require("fs").readFileSync("src/b.txt","utf8"))`));
      expect(b.output.trim()).toBe("новый");
      const slow = await ws.run(node("agent", "setInterval(() => {}, 1000)", 300));
      expect(slow).toMatchObject({ ok: false, timedOut: true });
      await expect(
        ws.run({ ...agentCommand(node("build", "1")), network: "registry" }),
      ).rejects.toBeInstanceOf(SandboxPolicyError);
    } finally {
      await ws.close();
    }
  });
});
