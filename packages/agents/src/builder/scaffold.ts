// Deterministic helpers of the build loop (agents/builder.yaml#scaffold): page stubs from the spec, so every
// declared page file exists before the code phase, and pages on routes the runtime serves itself (G0-SPEC-05).
import type { AppSpec, Page } from "@wizard/appspec";
import { DEFAULT_POLICY_PAGE, reservedRoute } from "@wizard/gates";
import { STUB_MARKER } from "./prompt.js";

/** PascalCase component name from a page file: ui/pages/lead-detail.tsx → LeadDetailPage. */
export function pageComponentName(file: string): string {
  const base = (file.split("/").pop() ?? "").replace(/\.tsx$/, "");
  const name = base
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join("");
  const safe = /^[A-Za-z]/.test(name) ? name : `P${name}`;
  return safe.endsWith("Page") ? safe : `${safe}Page`;
}

/** A page stub that passes G0 (default-exported component on ui-kit); the model rewrites it in the code phase. */
export function pageStub(page: Pick<Page, "file" | "title" | "route">): string {
  return [
    `// ${STUB_MARKER}: placeholder of page ${page.route} created from the spec; the builder rewrites the whole file.`,
    'import { AppShell } from "@wizard/ui-kit";',
    "",
    `export default function ${pageComponentName(page.file)}() {`,
    "  return (",
    `    <AppShell title={${JSON.stringify(page.title)}}>`,
    "      <p>Страница готовится.</p>",
    "    </AppShell>",
    "  );",
    "}",
    "",
  ].join("\n");
}

export const isStub = (content: string | null): boolean =>
  content?.slice(0, 200).includes(STUB_MARKER) === true;

export interface DroppedPage {
  route: string;
  title: string;
  reason: "login" | "policy";
}

const reasonText = (r: DroppedPage["reason"]) =>
  r === "login" ? "вход (/login)" : "страница политики обработки ПДн (compliance.policyPage)";

export function droppedPageNote(d: DroppedPage): string {
  return `Страница «${d.title}» (${d.route}) не нужна: этот адрес обслуживает платформа — ${reasonText(d.reason)}. Не объявляй её и не пиши для неё файл.`;
}

/**
 * add_page ops on /login or on the policy page (the batch's set_compliance.policyPage, else the spec's, else
 * /privacy) are dropped: the runtime renders those routes itself (runtime.yaml#routing, G0-SPEC-05).
 */
export function dropReservedPages(
  ops: readonly Record<string, unknown>[],
  spec: AppSpec,
): { ops: Record<string, unknown>[]; dropped: DroppedPage[] } {
  let policy = spec.compliance?.policyPage ?? DEFAULT_POLICY_PAGE;
  for (const op of ops)
    if (op.op === "set_compliance" && typeof op.policyPage === "string") policy = op.policyPage;
  const dropped: DroppedPage[] = [];
  const kept = ops.filter((op) => {
    if (op.op !== "add_page" || typeof op.route !== "string") return true;
    const reason = reservedRoute(op.route, policy);
    if (reason !== "login" && reason !== "policy") return true;
    dropped.push({ route: op.route, title: String(op.title ?? op.route), reason });
    return false;
  });
  return { ops: kept, dropped };
}

/** Pages of the spec that sit on /login or on its policy page (e.g. policyPage was set after the page). */
export function pagesOnReservedRoutes(spec: AppSpec): DroppedPage[] {
  const policy = spec.compliance?.policyPage ?? DEFAULT_POLICY_PAGE;
  const out: DroppedPage[] = [];
  for (const p of spec.pages ?? []) {
    const reason = reservedRoute(p.route, policy);
    if (reason === "login" || reason === "policy") out.push({ route: p.route, title: p.title, reason });
  }
  return out;
}
