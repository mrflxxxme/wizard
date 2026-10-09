// The techreview of the agent's change in a client's repository (V3-32; the deterministic part first, as in V3-15):
// forbidden paths (CI, lockfiles, .env, generated files of a Wizard system), new dependencies, secrets in added lines,
// tests deleted or switched off, the size of the change, and the repository's own build and tests in the sandbox. Then a
// reviewer on a model of another family than the agent (callType repo_review — T0 only, models.yaml#client_code)
// answers with a closed set of findings; a finding about a file the change does not touch is dropped. Blockers of
// either part → no PR.
import { createRegistry, type LlmMessage, modelFamily, type OrgPolicy, type RouteOutput } from "@wizard/llm";
import { z } from "zod";
import { callTool, type RouteFn } from "../core/loop.js";
import { defineTool } from "../core/tool.js";
import type { RepoProfile } from "./compat.js";
import type { SandboxResult } from "./sandbox.js";
import type { RepoSnapshot } from "./snapshot.js";

export const REPO_REVIEW_CALL_TYPE = "repo_review" as const;
/** Largest change the agent may propose in one PR. */
export const MAX_CHANGED_FILES = 50;
export const MAX_CHANGE_BYTES = 400 * 1024;

export interface RepoCheck {
  id: string;
  ok: boolean;
  message_ru: string;
  /** Path the check is about. */
  file?: string;
}

const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
]);

/** Paths the agent never changes, with the reason. */
export function forbiddenPath(path: string, kind: RepoProfile["kind"]): string | null {
  const name = path.split("/").at(-1) ?? path;
  if (path.startsWith(".github/workflows/") || name === ".gitlab-ci.yml" || path.startsWith(".gitlab/ci/"))
    return "CI меняет человек";
  if (LOCKFILES.has(name))
    return "lockfile обновляется только установкой зависимостей — на этапе агента сети нет";
  if (/^\.env(\.|$)/.test(name) && name !== ".env.example") return "файлы окружения с ключами не коммитятся";
  if (path.split("/").includes("node_modules")) return "node_modules не коммитятся";
  if (/\.(pem|key|p12|pfx|keystore|jks)$/i.test(name)) return "ключи и сертификаты не коммитятся";
  if (kind === "wizard_system") {
    const top = path.split("/")[0] ?? "";
    if (!(path === "spec/appspec.json" || top === "ui" || top === "functions"))
      return "в системе Wizard агент меняет только ui/**, functions/** и spec/appspec.json — остальное пишет Wizard";
  }
  return null;
}

const SECRET_RES: readonly [RegExp, string][] = [
  [/-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/, "закрытый ключ"],
  [/\bAKIA[0-9A-Z]{16}\b/, "ключ AWS"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "токен GitHub"],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/, "токен GitLab"],
  [/\bsk-[A-Za-z0-9_-]{24,}\b/, "ключ API"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "токен Slack"],
  [/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/, "токен Telegram-бота"],
  [/(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["'][^"'\s]{16,}["']/i, "ключ или пароль в коде"],
];

const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const SKIP_RE = /\b(describe|it|test|context)\.(skip|only)\s*\(|\b(xit|xdescribe|fit|fdescribe)\s*\(/;

const addedLines = (before: string | null, after: string): string[] => {
  const old = new Set((before ?? "").split("\n"));
  return after.split("\n").filter((l) => !old.has(l));
};

function depsChanged(before: string | null, after: string | null): boolean {
  const deps = (t: string | null) => {
    try {
      const v = JSON.parse(t ?? "{}") as Record<string, unknown>;
      return JSON.stringify(
        ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].map(
          (k) => v[k] ?? null,
        ),
      );
    } catch {
      return null;
    }
  };
  return deps(before) !== deps(after);
}

/** The deterministic part over the change and the sandbox runs after it. */
export function repoChecks(o: {
  snapshot: RepoSnapshot;
  changes: ReadonlyMap<string, string | null>;
  kind: RepoProfile["kind"];
  build: SandboxResult | null;
  test: SandboxResult | null;
}): RepoCheck[] {
  const out: RepoCheck[] = [];
  const fail = (id: string, message_ru: string, file?: string) =>
    out.push({ id, ok: false, message_ru, ...(file ? { file } : {}) });
  let bytes = 0;
  for (const [path, after] of o.changes) {
    const before = o.snapshot.get(path)?.text ?? null;
    bytes += after?.length ?? 0;
    const why = forbiddenPath(path, o.kind);
    if (why) fail("R-PATH", `${path}: ${why}`, path);
    if (path === "package.json" || path.endsWith("/package.json"))
      if (depsChanged(before, after))
        fail(
          "R-DEPS",
          `${path}: изменены зависимости — новые пакеты добавляет человек вместе с lockfile`,
          path,
        );
    if (after !== null)
      for (const line of addedLines(before, after))
        for (const [re, what] of SECRET_RES)
          if (re.test(line)) {
            fail("R-SECRET", `${path}: в правке ${what} — секреты не коммитятся`, path);
            break;
          }
    if (TEST_FILE.test(path)) {
      if (after === null && before !== null) fail("R-TESTS", `${path}: агент удалил тестовый файл`, path);
      else if (after !== null && addedLines(before, after).some((l) => SKIP_RE.test(l)))
        fail("R-TESTS", `${path}: агент отключил тесты (skip/only)`, path);
    }
  }
  if (o.changes.size === 0) fail("R-EMPTY", "агент не предложил изменений");
  if (o.changes.size > MAX_CHANGED_FILES)
    fail(
      "R-SIZE",
      `изменено ${o.changes.size} файлов — больше ${MAX_CHANGED_FILES} в одном PR не предлагаем`,
    );
  if (bytes > MAX_CHANGE_BYTES) fail("R-SIZE", "правка больше 400 КБ — разбейте задачу на части");
  for (const r of [o.build, o.test]) {
    if (!r) continue;
    const name = r.phase === "test" ? "тесты" : "сборка";
    if (r.timedOut) fail("R-VERIFY", `${name} не уложились в лимит времени песочницы`);
    else if (!r.ok) fail("R-VERIFY", `${name} после правки не проходят`);
  }
  if (!out.length) out.push({ id: "R-OK", ok: true, message_ru: "детерминированные проверки пройдены" });
  return out;
}

// ---------------------------------------------------------------- reviewer

export const MAX_REVIEW_FINDINGS = 10;

const findingSchema = z.strictObject({
  severity: z.enum(["blocker", "major", "minor"]),
  file: z.string().min(1).max(300),
  title_ru: z.string().min(5).max(240),
});

export const submitRepoReview = defineTool({
  name: "submit_repo_review",
  description: "Findings of the review of the agent's change (closed set; empty — nothing to fix).",
  input: z.strictObject({ findings: z.array(findingSchema).max(MAX_REVIEW_FINDINGS) }),
});

export interface RepoFinding {
  severity: "blocker" | "major" | "minor";
  file: string;
  title_ru: string;
}

export interface RepoReview {
  checks: RepoCheck[];
  findings: RepoFinding[];
  /** Russian blockers: no PR while any is left. */
  blockers: string[];
  reviewer: {
    status: "done" | "skipped";
    model: string | null;
    calls: number;
    reason?: string;
    unfounded: number;
  };
}

/** A unified-like view of the change for the reviewer: changed files with their new text (bounded). */
export function changeDigest(
  snapshot: RepoSnapshot,
  changes: ReadonlyMap<string, string | null>,
  max = 60_000,
): string {
  const parts: string[] = [];
  let left = max;
  for (const [path, after] of changes) {
    const before = snapshot.get(path)?.text ?? null;
    const head = `=== ${path} (${after === null ? "удалён" : before === null ? "новый" : "изменён"}) ===`;
    const body =
      after === null ? "" : after.length > left ? `${after.slice(0, Math.max(0, left))}\n…` : after;
    parts.push(head, body);
    left -= head.length + body.length;
    if (left <= 0) break;
  }
  return parts.join("\n");
}

function reviewMessages(task: string, digest: string, checks: readonly RepoCheck[]): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "Ты — ревьюер изменения в репозитории клиента. Изменение сделал ИИ-агент другого семейства моделей по задаче владельца.",
        "Проверь: решает ли правка задачу, не ломает ли она соседний код, обработку ошибок и краевые случаи, нет ли утечки данных и небезопасного кода, понятна ли она человеку.",
        "Детерминированные проверки (checks) — источник истины: не повторяй их.",
        "У каждой находки — путь изменённого файла (file). severity: blocker — с этим PR открывать нельзя; major — заметная ошибка; minor — улучшение.",
        "Ответ — только вызов submit_repo_review. Нечего исправлять — пустой список findings.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `## Задача владельца\n\n${task}`,
        `## Проверки\n\n${JSON.stringify(checks)}`,
        `## Изменение\n\n${digest}`,
      ].join("\n\n"),
    },
  ];
}

/** The reviewer of another family than the agent's model; findings about untouched files are dropped. */
export async function reviewRepoChange(o: {
  route: RouteFn;
  orgPolicy: OrgPolicy | null;
  ctx: { orgId: string };
  task: string;
  snapshot: RepoSnapshot;
  changes: ReadonlyMap<string, string | null>;
  checks: RepoCheck[];
  /** Model ids that wrote the change: the reviewer avoids their families. */
  agentModels: readonly string[];
  signal?: AbortSignal;
}): Promise<RepoReview> {
  const reg = createRegistry();
  const families = new Set<string>();
  for (const id of o.agentModels) {
    const m = reg.models.find((x) => x.id === id);
    if (m) families.add(modelFamily(m));
  }
  const blockers = o.checks.filter((c) => !c.ok).map((c) => c.message_ru);
  let model: string | null = null;
  let calls = 0;
  const route: RouteFn = async (input) => {
    calls += 1;
    const out: RouteOutput = await o.route({ ...input, avoidFamilies: [...families] });
    model = out.model;
    return out;
  };
  let findings: RepoFinding[] = [];
  let unfounded = 0;
  try {
    const r = await callTool({
      route,
      callType: REPO_REVIEW_CALL_TYPE,
      orgPolicy: o.orgPolicy,
      ctx: o.ctx,
      ...(o.signal ? { signal: o.signal } : {}),
      stepName: "repo_review",
      messages: reviewMessages(o.task, changeDigest(o.snapshot, o.changes), o.checks),
      tool: submitRepoReview,
      maxRepairs: 1,
    });
    if (!r.ok)
      return {
        checks: o.checks,
        findings: [],
        blockers,
        reviewer: { status: "skipped", model, calls, reason: "ревьюер не дал ответа по форме", unfounded: 0 },
      };
    const all = r.value.findings as RepoFinding[];
    findings = all.filter((f) => o.changes.has(f.file.replace(/:\d+$/, "")));
    unfounded = all.length - findings.length;
  } catch (e) {
    // The reviewer's models unavailable or the task's budget spent: the deterministic verdict stands.
    return {
      checks: o.checks,
      findings: [],
      blockers,
      reviewer: {
        status: "skipped",
        model,
        calls,
        reason:
          e instanceof Error && /BUDGET/.test(e.message)
            ? "бюджет задачи исчерпан"
            : "модели ревьюера недоступны",
        unfounded: 0,
      },
    };
  }
  for (const f of findings) if (f.severity === "blocker") blockers.push(`${f.file}: ${f.title_ru}`);
  return { checks: o.checks, findings, blockers, reviewer: { status: "done", model, calls, unfounded } };
}
