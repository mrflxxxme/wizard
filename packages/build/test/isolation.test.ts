// L3-13 (isolation.yaml#static_checks_G0.build, sdk.md §1.1, deploy.yaml#local.bundles_never_contain_env):
// the resolver rejects everything but @wizard/sdk, @wizard/ui-kit and own ui/** / functions/** files.
import { afterEach, describe, expect, test } from "vitest";
import { build, clientText, forumFiles } from "./helpers.js";

const MARKER = "WZ_SECRET_MARKER_7f3a9c";

function withFiles(extra: Record<string, string>): Map<string, string> {
  const files = forumFiles();
  for (const [k, v] of Object.entries(extra)) files.set(k, v);
  return files;
}

async function rejected(extra: Record<string, string>, evidence: RegExp) {
  const r = await build({ files: withFiles(extra) });
  expect(r.ok).toBe(false);
  expect(r.client.size).toBe(0);
  expect(r.serverFunctions).toBe("");
  const hit = r.errors.find((e) => evidence.test(e.evidence ?? e.message_ru));
  expect(hit, JSON.stringify(r.errors, null, 2)).toBeDefined();
  expect(hit).toMatchObject({ id: "G0-BUILD-01", severity: "blocker", status: "fail" });
  return hit;
}

const page = (imp: string) => `${imp}\nexport default function X() { return null; }\n`;
const scanner = (imp: string) => `${imp}\n${forumFiles().get("ui/Scanner.tsx")}`;

describe("resolver (L3-13)", () => {
  afterEach(() => {
    delete process.env.WZ_BUILD_TEST_SECRET;
  });

  test("escape: import k from '../../../.env?raw' → error with file and line", async () => {
    const hit = await rejected(
      { "ui/Scanner.tsx": scanner('import k from "../../../.env?raw";\nconsole.log(k);') },
      /«\.\.\/\.\.\/\.\.\/\.env\?raw» запрещён/,
    );
    expect(hit?.file).toBe("ui/Scanner.tsx");
    expect(hit?.line).toBe(1);
  });

  test.each([
    ["query suffix inside ui/", "ui/Scanner.tsx", 'import k from "./Landing.tsx?raw";', /суффиксы запроса/],
    ["absolute path", "ui/Scanner.tsx", 'import k from "/etc/passwd";', /запрещён/],
    ["bare package", "ui/Scanner.tsx", 'import { useState } from "react";', /«react» запрещён/],
    ["node builtin in functions", "functions/lib/x.ts", 'import fs from "node:fs";', /«node:fs» запрещён/],
    ["ui-kit from functions", "functions/lib/x.ts", 'import { Button } from "@wizard/ui-kit";', /запрещён/],
    ["sdk sub-path", "ui/Scanner.tsx", 'import { x } from "@wizard/sdk/host";', /запрещён/],
    ["functions → ui", "functions/lib/x.ts", 'import L from "../../ui/Landing";', /за пределы functions/],
    ["ui → functions", "ui/Scanner.tsx", 'import f from "../functions/sendReminder";', /за пределы ui/],
    [
      "import attributes",
      "ui/Scanner.tsx",
      'import d from "./Landing" with { type: "json" };',
      /import attributes/,
    ],
  ])("%s", async (_name, file, imp, evidence) => {
    const extra: Record<string, string> =
      file === "ui/Scanner.tsx"
        ? { [file]: scanner(`${imp}\nconsole.log(${imp.match(/import \{? ?(\w+)/)?.[1] ?? "0"});`) }
        : {
            [file]: `${imp}\nexport const y = [${imp.match(/import \{? ?(\w+)/)?.[1]}];\n`,
            "functions/sendReminder.ts": `import { y } from "./lib/x";\n${forumFiles().get("functions/sendReminder.ts")}\nexport const z = y;`,
          };
    await rejected(extra, evidence);
  });

  test("require() and non-ts files are rejected", async () => {
    await rejected(
      {
        "functions/lib/x.ts": 'const cp = require("child_process");\nexport const y = cp;\n',
        "functions/sendReminder.ts": `import { y } from "./lib/x";\n${forumFiles().get("functions/sendReminder.ts")}\nexport const z = y;`,
      },
      /только статический import \(require-call\)/,
    );
    await rejected(
      { "ui/data.json": "{}", "ui/Scanner.tsx": scanner('import d from "./data.json";\nconsole.log(d);') },
      /не найден в ui\//,
    );
  });

  test(".env and host files never reach the bundle; env and define are not forwarded", async () => {
    process.env.WZ_BUILD_TEST_SECRET = MARKER;
    const files = withFiles({
      ".env": `WIZARD_DB_URL=postgres://x:${MARKER}@h/db\n`,
      ".data/registry.json": `{"k":"${MARKER}"}`,
      "_generated/wizard.d.ts": `// ${MARKER}`,
      "ui/Scanner.tsx": scanner("console.log(process.env.WZ_BUILD_TEST_SECRET, import.meta.env);"),
    });
    for (const env of ["draft", "prod"] as const) {
      const r = await build({ env, files });
      expect(r.errors).toEqual([]);
      expect(clientText(r)).not.toContain(MARKER);
      expect(r.serverFunctions).not.toContain(MARKER);
      expect(JSON.stringify(r.manifest)).not.toContain(MARKER);
    }
  });

  test("invalid file names are refused", async () => {
    for (const bad of ["ui/../../etc/x.tsx", "ui/./x.tsx", "functions/a b.ts"]) {
      const r = await build({ files: withFiles({ [bad]: page("") }) });
      expect(r.ok, bad).toBe(false);
      expect(r.errors[0]?.message_ru).toContain("Недопустимое имя файла");
    }
  });
});
