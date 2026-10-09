// Compatibility of a client's repository with the agent (V3-32, product.yaml D77_v3 (4)): only Wizard systems and web
// projects on JS/TS (React, Vue, Next, Vite, Astro) with a lockfile whose build and tests pass in the sandbox within
// 10 minutes. profileRepo reads the snapshot (no execution); compatReport turns the profile and the sandbox run into the
// owner's report «что сможем / не сможем» with the reason of every «не сможем». PHP and 1С-Битрикс, 1С and mobile
// applications go to «Запросы на развитие» (or «под ключ»).
import { type RepoSnapshot, readJson, readText, topOf } from "./snapshot.js";

/** Sandbox time limit of install + build + tests (D77 (4)). */
export const SANDBOX_LIMIT_MS = 10 * 60_000;
/** Largest repository the agent takes (files, bytes of the working tree). */
export const MAX_REPO_FILES = 5000;
export const MAX_REPO_BYTES = 64 * 1024 * 1024;

export type RepoKind =
  | "wizard_system"
  | "js_web"
  | "js_monorepo"
  | "js_other"
  | "php"
  | "bitrix"
  | "onec"
  | "mobile"
  | "other_stack"
  | "empty";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

/** Web frameworks the agent works with (D77 (4)); the order is the one shown to the owner. */
export const SUPPORTED_FRAMEWORKS = [
  { id: "next", deps: ["next"], label: "Next.js" },
  { id: "astro", deps: ["astro"], label: "Astro" },
  { id: "vite", deps: ["vite"], label: "Vite" },
  { id: "react", deps: ["react"], label: "React" },
  { id: "vue", deps: ["vue", "nuxt"], label: "Vue" },
] as const;
export type Framework = (typeof SUPPORTED_FRAMEWORKS)[number]["id"];

/** JS web frameworks outside the list: named in the report, not worked on. */
const OTHER_WEB = [
  { deps: ["@angular/core"], label: "Angular" },
  { deps: ["svelte", "@sveltejs/kit"], label: "Svelte" },
  { deps: ["solid-js"], label: "Solid" },
  { deps: ["ember-source"], label: "Ember" },
] as const;

const LOCKFILES: Record<string, PackageManager> = {
  "pnpm-lock.yaml": "pnpm",
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "yarn.lock": "yarn",
  "bun.lockb": "bun",
  "bun.lock": "bun",
};

/** One package of a JS monorepo (the root package of a single project is not listed). */
export interface WorkspacePackage {
  path: string;
  name: string | null;
  kind: "web" | "mobile" | "unsupported_web" | "library";
  frameworks: Framework[];
  /** Label of an unsupported web framework or the mobile stack. */
  other: string | null;
  scripts: { build: boolean; test: boolean };
}

export interface RepoProfile {
  kind: RepoKind;
  /** Short Russian name of the stack («PHP (1С-Битрикс)», «Python»…) for the other kinds. */
  stackRu: string | null;
  frameworks: Framework[];
  /** Unsupported web framework of the root package (Angular, Svelte…). */
  otherWeb: string | null;
  /** Mobile stack of the root package (React Native, Expo, Flutter…). */
  mobile: string | null;
  packageManager: PackageManager | null;
  /** Lockfile of that manager at the root. */
  lockfile: string | null;
  /** Every lockfile at the root. */
  lockfiles: string[];
  /** yarn ≥ 2 (Berry): install --immutable. */
  yarnBerry: boolean;
  typescript: boolean;
  /** Scripts of the root package.json (an «npm init» test stub is no test). */
  scripts: { build: boolean; test: boolean };
  workspaces: WorkspacePackage[];
  /** Submodule paths (their code is not in the snapshot). */
  submodules: string[];
  /** Rule files for agents and contributors found (AGENTS.md, CLAUDE.md, CONTRIBUTING). */
  ruleFiles: string[];
  /** engines.node, .nvmrc or .node-version. */
  node: string | null;
  files: number;
  bytes: number;
}

const has = (s: RepoSnapshot, p: string) => s.has(p);
const anyUnder = (s: RepoSnapshot, prefix: string) => [...s.keys()].some((p) => p.startsWith(prefix));
const ext = (p: string) => /\.([A-Za-z0-9]+)$/.exec(p)?.[1]?.toLowerCase() ?? "";

function depsOf(pkg: Record<string, unknown> | null): Set<string> {
  const out = new Set<string>();
  for (const k of ["dependencies", "devDependencies", "peerDependencies"]) {
    const v = pkg?.[k];
    if (v && typeof v === "object") for (const name of Object.keys(v)) out.add(name);
  }
  return out;
}

const NO_TEST = /no test specified/i;

function scriptsOf(pkg: Record<string, unknown> | null): { build: boolean; test: boolean } {
  const s = (pkg?.scripts ?? {}) as Record<string, unknown>;
  const build = typeof s.build === "string" && s.build.trim() !== "";
  const test = typeof s.test === "string" && s.test.trim() !== "" && !NO_TEST.test(s.test);
  return { build, test };
}

function frameworksOf(deps: ReadonlySet<string>): Framework[] {
  return SUPPORTED_FRAMEWORKS.filter((f) => f.deps.some((d) => deps.has(d))).map((f) => f.id);
}

const otherWebOf = (deps: ReadonlySet<string>) =>
  OTHER_WEB.find((f) => f.deps.some((d) => deps.has(d)))?.label ?? null;

function mobileOfDeps(deps: ReadonlySet<string>): string | null {
  if (deps.has("expo")) return "Expo (React Native)";
  if (deps.has("react-native")) return "React Native";
  if (deps.has("@capacitor/core")) return "Capacitor";
  if (deps.has("@ionic/core")) return "Ionic";
  if (deps.has("nativescript")) return "NativeScript";
  return null;
}

/** Mobile markers of a directory prefix ("" — the root). */
function mobileOfFiles(s: RepoSnapshot, prefix: string): string | null {
  if (has(s, `${prefix}pubspec.yaml`)) return "Flutter";
  const paths = [...s.keys()].filter((p) => p.startsWith(prefix));
  const android = paths.some((p) => p.endsWith("AndroidManifest.xml"));
  const ios = paths.some((p) => /\.xcodeproj\//.test(p) || p.endsWith("Info.plist"));
  if (android && ios) return "Android и iOS";
  if (android) return "Android";
  if (ios) return "iOS";
  return null;
}

/** Workspace globs of the root: package.json workspaces, pnpm-workspace.yaml, lerna.json. */
function workspaceGlobs(s: RepoSnapshot, root: Record<string, unknown> | null): string[] {
  const out: string[] = [];
  const ws = root?.workspaces;
  if (Array.isArray(ws)) out.push(...ws.filter((x): x is string => typeof x === "string"));
  else if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages))
    out.push(...((ws as { packages: unknown[] }).packages.filter((x) => typeof x === "string") as string[]));
  const pnpmWs = readText(s, "pnpm-workspace.yaml");
  if (pnpmWs) {
    let inPackages = false;
    for (const line of pnpmWs.split("\n")) {
      if (/^packages:\s*$/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^\S/.test(line)) inPackages = false;
      const m = inPackages ? /^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(line) : null;
      if (m?.[1]) out.push(m[1].trim());
    }
  }
  const lerna = readJson(s, "lerna.json");
  if (Array.isArray(lerna?.packages))
    out.push(...((lerna.packages as unknown[]).filter((x) => typeof x === "string") as string[]));
  return [...new Set(out)];
}

/** Package directories matching the globs (dir, dir/*, dir/**; «!» excludes). */
function workspaceDirs(s: RepoSnapshot, globs: readonly string[]): string[] {
  const pkgDirs = [...s.keys()]
    .filter((p) => p.endsWith("/package.json") && !p.includes("node_modules/"))
    .map((p) => p.slice(0, -"/package.json".length));
  const match = (dir: string, g: string) => {
    const glob = g.replace(/^\.\//, "").replace(/\/+$/, "");
    if (glob.endsWith("/**")) return dir.startsWith(`${glob.slice(0, -3)}/`);
    if (glob.endsWith("/*")) {
      const base = glob.slice(0, -2);
      return dir.startsWith(`${base}/`) && !dir.slice(base.length + 1).includes("/");
    }
    return dir === glob;
  };
  const include = globs.filter((g) => !g.startsWith("!"));
  const exclude = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  return pkgDirs.filter((d) => include.some((g) => match(d, g)) && !exclude.some((g) => match(d, g))).sort();
}

function wizardSystem(s: RepoSnapshot): boolean {
  if (!has(s, "spec/appspec.json") || !(anyUnder(s, "ui/") || anyUnder(s, "functions/"))) return false;
  const agents = readText(s, "AGENTS.md") ?? "";
  return has(s, "brief/brief.json") || /собранной в Wizard/.test(agents);
}

/** Other stacks of the repository: PHP (and 1С-Битрикс), 1С, mobile, and back-end languages. */
function otherStack(s: RepoSnapshot): { kind: RepoKind; ru: string } | null {
  const paths = [...s.keys()];
  if (
    paths.some(
      (p) =>
        p.startsWith("bitrix/") ||
        p.startsWith("local/php_interface/") ||
        p.startsWith("local/templates/") ||
        p.startsWith("local/components/"),
    )
  )
    return { kind: "bitrix", ru: "PHP (1С-Битрикс)" };
  const code = paths.filter((p) => /\.(php|bsl|os|ts|tsx|js|jsx|mjs|vue|py|go|java|kt|rb|cs)$/i.test(p));
  const php = code.filter((p) => ext(p) === "php").length;
  if (has(s, "composer.json") || (code.length > 0 && php / code.length >= 0.3))
    return { kind: "php", ru: "PHP" };
  if (
    paths.some((p) => ["bsl", "epf", "erf", "cf", "cfe"].includes(ext(p))) ||
    paths.some((p) => p === "Configuration.xml" || p.endsWith("/Configuration.xml"))
  )
    return { kind: "onec", ru: "1С" };
  const back: [string, string][] = [
    ["pyproject.toml", "Python"],
    ["requirements.txt", "Python"],
    ["go.mod", "Go"],
    ["Gemfile", "Ruby"],
    ["pom.xml", "Java"],
    ["Cargo.toml", "Rust"],
  ];
  for (const [f, ru] of back) if (has(s, f) && !has(s, "package.json")) return { kind: "other_stack", ru };
  if (paths.some((p) => p.endsWith(".csproj") || p.endsWith(".sln")) && !has(s, "package.json"))
    return { kind: "other_stack", ru: ".NET" };
  return null;
}

/** RULE_FILES of rules.ts: the files whose rules the agent follows. */
export const RULE_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "CONTRIBUTING",
  ".github/CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
] as const;

/** What the repository is: stack, package manager and lockfile, scripts, packages of a monorepo, rule files. */
export function profileRepo(s: RepoSnapshot): RepoProfile {
  let bytes = 0;
  for (const f of s.values()) bytes += f.size;
  const root = readJson(s, "package.json");
  const deps = depsOf(root);
  const lockfiles = Object.keys(LOCKFILES).filter((f) => has(s, f));
  const declared = typeof root?.packageManager === "string" ? root.packageManager : "";
  const declaredPm = (/^(pnpm|npm|yarn|bun)@/.exec(declared)?.[1] ?? null) as PackageManager | null;
  const managers = [...new Set(lockfiles.map((f) => LOCKFILES[f] as PackageManager))];
  const packageManager =
    declaredPm && managers.includes(declaredPm)
      ? declaredPm
      : managers.length === 1
        ? (managers[0] as PackageManager)
        : null;
  const lockfile = packageManager ? (lockfiles.find((f) => LOCKFILES[f] === packageManager) ?? null) : null;
  const yarnBerry =
    has(s, ".yarnrc.yml") ||
    /^yarn@([2-9]|\d{2,})/.test(declared) ||
    /__metadata:/.test(readText(s, "yarn.lock") ?? "");
  const typescript =
    has(s, "tsconfig.json") || deps.has("typescript") || [...s.keys()].some((p) => /\.tsx?$/.test(p));
  const globs = workspaceGlobs(s, root);
  const workspaces: WorkspacePackage[] = workspaceDirs(s, globs).map((dir) => {
    const pkg = readJson(s, `${dir}/package.json`);
    const d = depsOf(pkg);
    const fw = frameworksOf(d);
    const mobile = mobileOfDeps(d) ?? mobileOfFiles(s, `${dir}/`);
    const other = otherWebOf(d);
    return {
      path: dir,
      name: typeof pkg?.name === "string" ? pkg.name : null,
      kind: mobile ? "mobile" : fw.length ? "web" : other ? "unsupported_web" : "library",
      frameworks: fw,
      other: mobile ?? other,
      scripts: scriptsOf(pkg),
    };
  });
  const engines = root?.engines as Record<string, unknown> | undefined;
  const node =
    (typeof engines?.node === "string" ? engines.node : null) ??
    readText(s, ".nvmrc")?.trim() ??
    readText(s, ".node-version")?.trim() ??
    null;
  const base = {
    stackRu: null,
    frameworks: frameworksOf(deps),
    otherWeb: otherWebOf(deps),
    mobile: mobileOfDeps(deps) ?? mobileOfFiles(s, ""),
    packageManager,
    lockfile,
    lockfiles,
    yarnBerry: packageManager === "yarn" && yarnBerry,
    typescript,
    scripts: scriptsOf(root),
    workspaces,
    submodules: [...s.values()].filter((f) => f.mode === "160000").map((f) => f.path),
    ruleFiles: RULE_FILES.filter((f) => s.get(f)?.text),
    node: node || null,
    files: s.size,
    bytes,
  };
  if (s.size === 0) return { ...base, kind: "empty" };
  if (wizardSystem(s)) return { ...base, kind: "wizard_system" };
  const other = otherStack(s);
  if (other) return { ...base, kind: other.kind, stackRu: other.ru };
  if (!root) {
    const mobile = mobileOfFiles(s, "");
    if (mobile) return { ...base, kind: "mobile", stackRu: mobile, mobile };
    const top = [...new Set([...s.keys()].map(topOf))];
    return { ...base, kind: "other_stack", stackRu: top.length ? "без package.json" : null };
  }
  // A monorepo first: its mobile package (with android/ and ios/ inside) is one package, not the repository's kind.
  if (workspaces.length) return { ...base, kind: "js_monorepo" };
  if (base.mobile && !base.frameworks.some((f) => f === "next" || f === "vite" || f === "astro"))
    return { ...base, kind: "mobile", stackRu: base.mobile };
  return { ...base, kind: base.frameworks.length ? "js_web" : "js_other" };
}

// ---------------------------------------------------------------- report

export type SandboxStepName = "install" | "build" | "test";

/** One step of the compatibility run in the sandbox. */
export interface SandboxStepSummary {
  step: SandboxStepName;
  /** The command as the owner sees it («pnpm install --frozen-lockfile»). */
  command: string;
  ok: boolean;
  timedOut: boolean;
  durationMs: number;
  /** Last lines of the output (no secrets: the sandbox has none). */
  tail: string;
}

export interface SandboxCheck {
  status: "passed" | "failed" | "timeout" | "unavailable";
  steps: SandboxStepSummary[];
  totalMs: number;
  /** Russian reason of «unavailable» (no sandbox on this stand, the runner is down). */
  reason_ru?: string;
}

export type CompatVerdict = "compatible" | "partial" | "incompatible" | "unchecked";

export interface CompatReport {
  version: 1;
  verdict: CompatVerdict;
  kind: RepoKind;
  /** One Russian sentence for the owner. */
  summary_ru: string;
  /** «Что сможем». */
  can: string[];
  /** «Что не сможем» — each with the reason. */
  cannot: { what_ru: string; why_ru: string }[];
  stack: {
    frameworks: string[];
    packageManager: PackageManager | null;
    lockfile: string | null;
    typescript: boolean;
    monorepo: boolean;
    node: string | null;
  };
  sandbox: SandboxCheck | null;
  /** Rule files found; empty — Wizard proposes AGENTS.md by a separate PR. */
  rules: string[];
  /** For «Запросы на развитие» (D73): what the owner wanted that we do not do. */
  developmentRequest: { category: "mobile" | "other"; quote: string } | null;
  /** Why the agent takes no tasks («несовместим» or «не проверено»): the first such reason; null when it does. */
  blocking_ru: string | null;
}

const labelOf = (id: Framework) => SUPPORTED_FRAMEWORKS.find((f) => f.id === id)?.label ?? id;
const listRu = (xs: readonly string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} и ${xs.at(-1)}`;
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/** The owner's report: «что сможем / не сможем» from the profile and the sandbox run (null — not run yet). */
export function compatReport(
  p: RepoProfile,
  sandbox: SandboxCheck | null,
  commands?: Partial<Record<SandboxStepName, string>>,
): CompatReport {
  const can: string[] = [];
  const cannot: CompatReport["cannot"] = [];
  let verdict = "compatible" as CompatVerdict;
  let devReq: CompatReport["developmentRequest"] = null;
  let blocking: string | null = null;
  const block = (what_ru: string, why_ru: string) => {
    cannot.push({ what_ru, why_ru });
    verdict = "incompatible";
    blocking ??= why_ru;
  };
  const limit = (what_ru: string, why_ru: string) => {
    cannot.push({ what_ru, why_ru });
    if (verdict === "compatible") verdict = "partial";
  };
  const jsKinds: RepoKind[] = ["js_web", "js_monorepo", "js_other"];
  const always = () => {
    cannot.push({
      what_ru: "Менять CI (.github/workflows, .gitlab-ci.yml) и lockfile",
      why_ru:
        "CI и зависимости меняет человек: у приложения Wizard нет прав на workflows, а на этапе агента в песочнице нет сети",
    });
    cannot.push({
      what_ru: "Мержить PR и деплоить",
      why_ru: "PR черновой: мержит только человек, деплой — вашими средствами",
    });
  };

  switch (p.kind) {
    case "empty":
      block("Работать с репозиторием", "репозиторий пуст");
      break;
    case "wizard_system":
      can.push(
        "Дорабатывать систему Wizard по задаче: интерфейс ui/**, функции functions/** и спеку spec/appspec.json",
        "Проверять правки сборкой и типами (G0) и проверками прав, ПДн и секретов (G2) в песочнице Wizard",
        "Открывать черновой PR в ветке wizard/… — после мержа Wizard заберёт изменения и прогонит G0–G2",
      );
      cannot.push({
        what_ru: "Менять бриф, tests/ и AGENTS.md",
        why_ru: "их пишет Wizard; правки этих файлов при импорте не переносятся",
      });
      break;
    case "php":
    case "bitrix":
    case "onec":
      block(
        "Дорабатывать этот репозиторий",
        `${p.stackRu ?? "PHP"} пока не дорабатываем: агент работает с системами Wizard и веб-проектами на JS/TS. Записали в «Запросы на развитие»; доработку можно заказать «под ключ»`,
      );
      devReq = { category: "other", quote: `Доработка репозитория на ${p.stackRu ?? "PHP"}` };
      break;
    case "mobile":
      block(
        "Дорабатывать мобильное приложение",
        `${p.stackRu ?? p.mobile ?? "мобильные приложения"} пока не дорабатываем. Записали в «Запросы на развитие»; доработку можно заказать «под ключ»`,
      );
      devReq = {
        category: "mobile",
        quote: `Доработка мобильного приложения (${p.stackRu ?? p.mobile ?? "мобильное"})`,
      };
      break;
    case "other_stack":
      block(
        "Дорабатывать этот репозиторий",
        `${p.stackRu ? `стек ${p.stackRu}` : "этот стек"} — не веб-проект на JS/TS: агент работает с системами Wizard и проектами на React, Vue, Next, Vite и Astro`,
      );
      devReq = { category: "other", quote: `Доработка репозитория (${p.stackRu ?? "другой стек"})` };
      break;
    default:
      break;
  }

  if (jsKinds.includes(p.kind)) {
    const monorepo = p.kind === "js_monorepo";
    const webPkgs = p.workspaces.filter((w) => w.kind === "web");
    const fw = monorepo ? [...new Set(webPkgs.flatMap((w) => w.frameworks))] : p.frameworks;
    if (!monorepo && p.otherWeb && !fw.length)
      block(
        "Дорабатывать проект",
        `${p.otherWeb} пока не поддерживаем: агент работает с React, Vue, Next, Vite и Astro`,
      );
    else if (!fw.length)
      block(
        "Дорабатывать проект",
        monorepo
          ? "в монорепозитории нет веб-пакета на React, Vue, Next, Vite или Astro"
          : "это не веб-проект: в package.json нет React, Vue, Next, Vite или Astro",
      );
    if (!p.lockfiles.length)
      block(
        "Устанавливать зависимости и собирать проект",
        "нет lockfile (pnpm-lock.yaml, package-lock.json или yarn.lock): без него сборка не воспроизводится. Закоммитьте lockfile и проверьте снова",
      );
    else if (!p.packageManager)
      block(
        "Устанавливать зависимости",
        `в репозитории несколько lockfile (${p.lockfiles.join(", ")}) — неясно, какой менеджер пакетов главный. Оставьте один или укажите packageManager в package.json`,
      );
    else if (p.packageManager === "bun")
      block("Собирать проект на Bun", "в песочнице есть npm, pnpm и yarn; Bun пока не поддерживаем");
    const anyBuild = p.scripts.build || (monorepo && p.workspaces.some((w) => w.scripts.build));
    const anyTest = p.scripts.test || (monorepo && p.workspaces.some((w) => w.scripts.test));
    if (!anyBuild)
      block("Проверять сборку", "в package.json нет скрипта build — без сборки правки нечем проверить");
    if (!anyTest)
      limit(
        "Запускать тесты репозитория",
        "в package.json нет скрипта test: правки проверяют сборка и техревью. Добавьте тесты — агент будет их запускать",
      );
    if (monorepo) {
      for (const w of p.workspaces.filter((x) => x.kind === "mobile"))
        limit(
          `Пакет ${w.path} (${w.other ?? "мобильное приложение"})`,
          "мобильные приложения пока не дорабатываем — записали в «Запросы на развитие»",
        );
      for (const w of p.workspaces.filter((x) => x.kind === "unsupported_web"))
        limit(
          `Пакет ${w.path} (${w.other})`,
          `${w.other} пока не поддерживаем: агент работает с React, Vue, Next, Vite и Astro`,
        );
      const mobilePkg = p.workspaces.find((x) => x.kind === "mobile");
      if (mobilePkg)
        devReq = {
          category: "mobile",
          quote: `Доработка мобильного приложения в монорепозитории (${mobilePkg.other ?? "мобильное"})`,
        };
    }
    if (verdict !== "incompatible") {
      const lang = p.typescript ? "TypeScript" : "JavaScript";
      can.push(
        monorepo
          ? `Дорабатывать веб-пакеты монорепозитория: ${webPkgs.map((w) => `${w.path} (${listRu(w.frameworks.map(labelOf))})`).join(", ")} на ${lang}`
          : `Дорабатывать код по задаче: ${listRu(fw.map(labelOf))} на ${lang}`,
        `Ставить зависимости (${commands?.install ?? p.packageManager}) по lockfile ${p.lockfile}, собирать${anyTest ? " и прогонять тесты репозитория" : ""} в песочнице — не дольше ${minutes(SANDBOX_LIMIT_MS)} минут`,
        "Работать на этапе агента без сети, проверять правку техревью и открывать черновой PR в ветке wizard/…",
      );
    }
  }

  if (p.files > MAX_REPO_FILES || p.bytes > MAX_REPO_BYTES)
    block(
      "Работать с таким большим репозиторием",
      `в нём ${p.files} файлов и ${Math.round(p.bytes / 1024 / 1024)} МБ — агент берёт до ${MAX_REPO_FILES} файлов и ${MAX_REPO_BYTES / 1024 / 1024} МБ`,
    );
  if (p.submodules.length)
    limit(
      `Подмодули (${p.submodules.slice(0, 3).join(", ")}${p.submodules.length > 3 ? " и другие" : ""})`,
      "код подмодулей хранится в других репозиториях — агенту он недоступен",
    );
  if (verdict !== "incompatible") {
    if (p.ruleFiles.length) can.push(`Соблюдать правила репозитория из ${listRu(p.ruleFiles)}`);
    else
      can.push(
        "Предложить правила для агентов (AGENTS.md) отдельным черновым PR — в репозитории нет AGENTS.md, CLAUDE.md и CONTRIBUTING",
      );
  }

  // The sandbox run: install, build and tests within 10 minutes (Wizard systems: G0 and G2 instead).
  if (verdict !== "incompatible") {
    if (!sandbox) {
      verdict = "unchecked";
      blocking = "проверка в песочнице ещё не запускалась";
      cannot.push({ what_ru: "Подтвердить сборку и тесты", why_ru: blocking });
    } else if (sandbox.status === "unavailable") {
      verdict = "unchecked";
      blocking = sandbox.reason_ru ?? "песочница сейчас недоступна — повторите проверку позже";
      cannot.push({ what_ru: "Подтвердить сборку и тесты", why_ru: blocking });
    } else if (sandbox.status === "timeout" || sandbox.totalMs > SANDBOX_LIMIT_MS)
      block(
        "Проверять правки сборкой и тестами",
        `установка, сборка и тесты идут дольше ${minutes(SANDBOX_LIMIT_MS)} минут — это предел песочницы`,
      );
    else if (sandbox.status === "failed") {
      const bad = sandbox.steps.find((x) => !x.ok);
      const last = bad?.tail.trim().split("\n").filter(Boolean).at(-1) ?? "";
      const what =
        bad?.step === "install"
          ? "Устанавливать зависимости"
          : bad?.step === "build"
            ? "Собирать проект"
            : "Проверять правки тестами";
      const why =
        bad?.step === "test"
          ? `${p.kind === "wizard_system" ? "проверки" : "тесты репозитория"} не проходят ещё до правок (${bad.command})`
          : `${bad?.command ?? "команда"}: ошибка ещё до правок`;
      block(what, `${why}${last ? `: «${last.slice(0, 200)}»` : ""}`);
    }
  }
  if (verdict !== "incompatible" && p.kind !== "wizard_system" && !jsKinds.includes(p.kind)) {
    verdict = "incompatible";
    blocking ??= "агент работает с системами Wizard и веб-проектами на JS/TS";
  }
  if (verdict === "incompatible") can.length = 0;
  always();

  const summary_ru =
    verdict === "compatible"
      ? "Репозиторий совместим: агент может дорабатывать его по задачам."
      : verdict === "partial"
        ? "Репозиторий совместим с ограничениями — что не сможем, перечислено ниже."
        : verdict === "unchecked"
          ? "Статическая проверка пройдена, осталось подтвердить сборку и тесты в песочнице."
          : "Репозиторий несовместим: агент его не дорабатывает — причины ниже.";
  return {
    version: 1,
    verdict,
    kind: p.kind,
    summary_ru,
    can,
    cannot,
    stack: {
      frameworks:
        p.kind === "js_monorepo"
          ? [...new Set(p.workspaces.flatMap((w) => w.frameworks))].map(labelOf)
          : p.frameworks.map(labelOf),
      packageManager: p.packageManager,
      lockfile: p.lockfile,
      typescript: p.typescript,
      monorepo: p.kind === "js_monorepo",
      node: p.node,
    },
    sandbox,
    rules: [...p.ruleFiles],
    developmentRequest: devReq,
    blocking_ru: verdict === "incompatible" || verdict === "unchecked" ? blocking : null,
  };
}

/** May the agent take tasks for a repository with this report? */
export const agentAllowed = (r: Pick<CompatReport, "verdict">): boolean =>
  r.verdict === "compatible" || r.verdict === "partial";
