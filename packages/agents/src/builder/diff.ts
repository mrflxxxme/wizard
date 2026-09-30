// Human diff (agents/builder.yaml#human_diff): deterministic Russian lines from a batch of ops and changed files.
import type { AppSpec, OpName } from "@wizard/appspec";

type Rec = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const OPS_RU: Record<string, string> = {
  read: "смотреть",
  create: "создавать",
  update: "изменять",
  delete: "удалять",
};
const CONNECTOR_RU: Record<string, string> = {
  yookassa: "оплата ЮKassa",
  telegram: "Telegram",
  email: "почта",
  qr: "QR-коды",
};
const FIELD_PATCH_RU: Record<string, string> = {
  label: "название",
  required: "обязательность",
  unique: "уникальность",
  default: "значение по умолчанию",
  enum: "варианты",
  pii: "категория ПДн",
  min: "минимум",
  max: "максимум",
  maxLength: "длина",
};

/** One template per op (ops.yaml#ops); `unknown` for anything else. Exported for the key-parity test. */
export const OP_TEMPLATES: Record<OpName | "unknown", string> = {
  set_app: "Изменены название или описание системы",
  set_theme: "Изменён стиль",
  add_entity: "Добавлены данные «{label}» ({n} полей)",
  update_entity: "Изменены настройки данных «{label}»",
  remove_entity: "Удалены данные «{label}» ⚠",
  add_field: "В «{entity.label}» добавлено поле «{label}»",
  update_field: "В «{entity.label}» изменено поле «{label}»: {что}",
  remove_field: "Из «{entity.label}» удалено поле «{label}» ⚠",
  add_role: "Добавлена роль «{label}»",
  update_role: "Изменена роль «{label}»",
  remove_role: "Удалена роль «{label}» ⚠",
  set_permission: "«{role.label}» теперь может: {ops по-русски} — «{entity.label}»{, только свои}",
  remove_permission: "«{role.label}» больше не имеет доступа к «{entity.label}»",
  add_workflow: "Новая автоматизация: {label}",
  update_workflow: "Изменена автоматизация: {label}",
  remove_workflow: "Удалена автоматизация: {label}",
  add_integration: "Подключено: {connector по-русски}",
  update_integration: "Изменены настройки подключения: {connector по-русски}",
  remove_integration: "Отключено: {connector по-русски}",
  add_function: "Добавлена серверная логика",
  remove_function: "Удалена серверная логика",
  add_page: "Новый экран «{title}»",
  update_page: "Изменён экран «{title}»",
  remove_page: "Удалён экран «{title}»",
  add_ai_action: "Новое ИИ-действие «{label}»",
  set_acceptance: "Обновлены критерии приёмки ({n})",
  set_compliance: "Обновлены настройки персональных данных",
  unknown: "Изменены настройки системы",
};

const MAX_LINES = 20;

interface Line {
  text: string;
  group: string;
  destructive: boolean;
}

function lookup(before: AppSpec, after: AppSpec) {
  const entity = (name: string) =>
    after.entities.find((e) => e.name === name) ?? before.entities.find((e) => e.name === name);
  const role = (name: string) =>
    after.roles.find((r) => r.name === name) ?? before.roles.find((r) => r.name === name);
  const entityLabel = (name: string) => entity(name)?.label ?? name;
  const roleLabel = (name: string) => role(name)?.label ?? name;
  const fieldLabel = (e: string, f: string) =>
    (
      entity(e)?.fields.find((x) => x.name === f) ??
      before.entities.find((x) => x.name === e)?.fields.find((x) => x.name === f)
    )?.label ?? f;
  const workflow = (name: string) =>
    [...(after.workflows ?? []), ...(before.workflows ?? [])].find((w) => w.name === name);
  const integration = (name: string) =>
    [...(after.integrations ?? []), ...(before.integrations ?? [])].find((i) => i.name === name);
  const page = (route: string) =>
    [...(after.pages ?? []), ...(before.pages ?? [])].find((p) => p.route === route);
  return { entityLabel, roleLabel, fieldLabel, workflow, integration, page };
}

function opLine(op: Rec, before: AppSpec, after: AppSpec): Line {
  const L = lookup(before, after);
  const name = str(op.op);
  const connectorRu = (n: string) => {
    const c = L.integration(n)?.connector ?? n;
    return CONNECTOR_RU[c] ?? c;
  };
  const destructive = name.startsWith("remove_") && name !== "remove_permission";
  let group = "system";
  let text: string;
  switch (name) {
    case "set_app":
    case "set_theme":
    case "add_function":
    case "remove_function":
    case "set_compliance":
      text = OP_TEMPLATES[name];
      break;
    case "add_entity": {
      group = `e:${str(op.name)}`;
      const n = Array.isArray(op.fields) ? op.fields.length : 0;
      text = `Добавлены данные «${str(op.label) || str(op.name)}» (${n} полей)`;
      break;
    }
    case "update_entity":
      group = `e:${str(op.name)}`;
      text = `Изменены настройки данных «${L.entityLabel(str(op.name))}»`;
      break;
    case "remove_entity":
      group = `e:${str(op.name)}`;
      text = `Удалены данные «${L.entityLabel(str(op.name))}» ⚠`;
      break;
    case "add_field": {
      group = `e:${str(op.entity)}`;
      const f = (op.field ?? {}) as Rec;
      text = `В «${L.entityLabel(str(op.entity))}» добавлено поле «${str(f.label) || str(f.name)}»`;
      break;
    }
    case "update_field": {
      group = `e:${str(op.entity)}`;
      const keys = Object.keys((op.patch ?? {}) as Rec).map((k) => FIELD_PATCH_RU[k] ?? k);
      text = `В «${L.entityLabel(str(op.entity))}» изменено поле «${L.fieldLabel(str(op.entity), str(op.name))}»: ${keys.join(", ")}`;
      break;
    }
    case "remove_field":
      group = `e:${str(op.entity)}`;
      text = `Из «${L.entityLabel(str(op.entity))}» удалено поле «${L.fieldLabel(str(op.entity), str(op.name))}» ⚠`;
      break;
    case "add_role":
      group = `r:${str(op.name)}`;
      text = `Добавлена роль «${str(op.label) || str(op.name)}»`;
      break;
    case "update_role":
      group = `r:${str(op.name)}`;
      text = `Изменена роль «${L.roleLabel(str(op.name))}»`;
      break;
    case "remove_role":
      group = `r:${str(op.name)}`;
      text = `Удалена роль «${L.roleLabel(str(op.name))}» ⚠`;
      break;
    case "set_permission": {
      group = `e:${str(op.entity)}`;
      const ops = (Array.isArray(op.ops) ? op.ops : []).map((o) => OPS_RU[String(o)] ?? String(o));
      const own = op.rowFilter && Object.keys(op.rowFilter as Rec).length > 0 ? ", только свои" : "";
      text = `«${L.roleLabel(str(op.role))}» теперь может: ${ops.join(", ")} — «${L.entityLabel(str(op.entity))}»${own}`;
      break;
    }
    case "remove_permission":
      group = `e:${str(op.entity)}`;
      text = `«${L.roleLabel(str(op.role))}» больше не имеет доступа к «${L.entityLabel(str(op.entity))}»`;
      break;
    case "add_workflow":
    case "update_workflow":
    case "remove_workflow": {
      const w = (op.workflow ?? {}) as Rec;
      const wname = str(w.name) || str(op.name);
      const label = str(w.label) || L.workflow(wname)?.label || wname;
      const verb = { add_workflow: "Новая", update_workflow: "Изменена", remove_workflow: "Удалена" }[name];
      text = `${verb} автоматизация: ${label}`;
      break;
    }
    case "add_integration": {
      const i = (op.integration ?? {}) as Rec;
      const c = str(i.connector);
      text = `Подключено: ${CONNECTOR_RU[c] ?? c}`;
      break;
    }
    case "update_integration":
      text = `Изменены настройки подключения: ${connectorRu(str(op.name))}`;
      break;
    case "remove_integration":
      text = `Отключено: ${connectorRu(str(op.name))}`;
      break;
    case "add_page":
      group = `p:${str(op.route)}`;
      text = `Новый экран «${str(op.title)}»`;
      break;
    case "update_page":
      group = `p:${str(op.route)}`;
      text = `Изменён экран «${L.page(str(op.route))?.title ?? str(op.route)}»`;
      break;
    case "remove_page":
      group = `p:${str(op.route)}`;
      text = `Удалён экран «${L.page(str(op.route))?.title ?? str(op.route)}»`;
      break;
    case "add_ai_action": {
      const a = (op.aiAction ?? {}) as Rec;
      text = `Новое ИИ-действие «${str(a.label) || str(a.name)}»`;
      break;
    }
    case "set_acceptance":
      text = `Обновлены критерии приёмки (${Array.isArray(op.acceptance) ? op.acceptance.length : 0})`;
      break;
    default:
      text = OP_TEMPLATES.unknown;
  }
  return { text, group, destructive };
}

function finish(lines: Line[]): string[] {
  const order = new Map<string, number>();
  for (const l of lines) if (!order.has(l.group)) order.set(l.group, order.size);
  const sorted = [...lines].sort(
    (a, b) =>
      Number(b.destructive) - Number(a.destructive) || (order.get(a.group) ?? 0) - (order.get(b.group) ?? 0),
  );
  // Identical lines (e.g. several add_function) are merged with a counter.
  const counts = new Map<string, number>();
  for (const l of sorted) counts.set(l.text, (counts.get(l.text) ?? 0) + 1);
  const texts = [...counts].map(([t, n]) => (n > 1 ? `${t} (×${n})` : t));
  if (texts.length <= MAX_LINES) return texts;
  const rest = texts.length - (MAX_LINES - 1);
  return [...texts.slice(0, MAX_LINES - 1), `и ещё ${rest} ${plural(rest)}`];
}

function plural(n: number): string {
  const pr = new Intl.PluralRules("ru").select(n);
  return pr === "one" ? "изменение" : pr === "few" ? "изменения" : "изменений";
}

/** humanDiff of a batch: `before` — spec before the batch, `after` — after it (labels of removed items come from `before`). */
export function humanDiff(ops: readonly unknown[], before: AppSpec, after: AppSpec): string[] {
  return finish(ops.map((op) => opLine((op ?? {}) as Rec, before, after)));
}

/** humanDiff lines for changed files (builder.yaml#human_diff.files). */
export function humanDiffFiles(paths: readonly string[], spec: AppSpec): string[] {
  const lines: Line[] = paths.map((path) => {
    const page = (spec.pages ?? []).find((p) => p.file === path);
    if (page) return { text: `Изменён экран «${page.title}»`, group: `p:${page.route}`, destructive: false };
    if ((spec.functions ?? []).some((f) => f.file === path))
      return { text: "Изменена логика экрана или автоматизации", group: "fn", destructive: false };
    if (path.startsWith("ui/")) {
      const component = path.replace(/^.*\//, "").replace(/\.tsx$/, "");
      return { text: `Изменён элемент интерфейса «${component}»`, group: "ui", destructive: false };
    }
    return { text: "Изменена вспомогательная логика", group: "fn", destructive: false };
  });
  return finish(lines);
}
