// Registry and G0 validation of AppSpec integrations (connector-interface.md §4).
import { type AppSpec, type Integration, pointer } from "@wizard/appspec";
import type { z } from "zod";
import { emailConnector } from "./email.js";
import { qrConnector } from "./qr.js";
import { parseSecretRef } from "./secrets.js";
import { telegramConnector } from "./telegram.js";
import type { AnyConnector, ConnectorId, SpecIssue } from "./types.js";
import { webhookConnector } from "./webhook/index.js";
import { yookassaConnector } from "./yookassa.js";

export const CONNECTORS: Readonly<Record<ConnectorId, AnyConnector>> = {
  yookassa: yookassaConnector,
  telegram: telegramConnector,
  email: emailConnector,
  qr: qrConnector,
  webhook: webhookConnector,
};

export function getConnector(id: string): AnyConnector | undefined {
  return Object.hasOwn(CONNECTORS, id) ? CONNECTORS[id as ConnectorId] : undefined;
}

const TYPE_RU: Record<string, string> = {
  string: "строка",
  number: "число",
  int: "целое число",
  boolean: "да/нет (boolean)",
  object: "объект",
  array: "массив",
  record: "объект",
};

function issueRu(i: z.core.$ZodIssue): string {
  if (/[А-Яа-яЁё]/.test(i.message)) return i.message;
  switch (i.code) {
    case "unrecognized_keys":
      return `Неизвестные параметры: ${i.keys.join(", ")}`;
    case "invalid_type":
      return `Ожидается ${TYPE_RU[i.expected] ?? i.expected}`;
    case "invalid_value":
      return `Допустимые значения: ${i.values.map(String).join(", ")}`;
    case "too_small":
      return i.origin === "array" ? `Нужно не меньше ${i.minimum} элементов` : `Минимум — ${i.minimum}`;
    case "too_big":
      return i.origin === "array" ? `Допустимо не больше ${i.maximum} элементов` : `Максимум — ${i.maximum}`;
    case "invalid_key":
      return "Недопустимое имя ключа";
    case "invalid_format":
      return "Неверный формат значения";
    default:
      return "Недопустимое значение";
  }
}

function zodIssues(error: z.ZodError, base: readonly (string | number)[], connector: string): SpecIssue[] {
  return error.issues.map((i) => ({
    code: "SCHEMA_INVALID" as const,
    path: pointer([...base, ...i.path.map((p) => (typeof p === "symbol" ? String(p) : p))]),
    message_ru: issueRu(i),
    rule: `${connector}.config_schema`,
  }));
}

/** configSchema + declared secrets + validateSpec for one integration (index into spec.integrations). */
export function validateIntegration(spec: AppSpec, index: number): SpecIssue[] {
  const integration = spec.integrations?.[index] as Integration | undefined;
  if (!integration) return [];
  const base = ["integrations", index] as const;
  const connector = getConnector(integration.connector);
  if (!connector) {
    return [
      {
        code: "SCHEMA_INVALID",
        path: pointer([...base, "connector"]),
        message_ru: `Коннектор «${integration.connector}» не поддерживается`,
        rule: "connector.unknown",
        allowed: Object.keys(CONNECTORS),
      },
    ];
  }
  const issues: SpecIssue[] = [];
  const declared = new Set((integration.secretRefs ?? []).map(parseSecretRef));
  const known = new Set(connector.secrets.map((s) => s.name));
  for (const s of connector.secrets) {
    if (s.required && !declared.has(s.name)) {
      issues.push({
        code: "CONFIG_INVALID",
        path: pointer([...base, "secretRefs"]),
        message_ru: `Не объявлен секрет «${s.label}»: добавьте secret://${s.name} в secretRefs`,
        rule: "connector.secret_required",
      });
    }
  }
  (integration.secretRefs ?? []).forEach((ref, i) => {
    const name = parseSecretRef(ref);
    if (!name || !(known.has(name) || (connector.secretPrefix && name.startsWith(connector.secretPrefix)))) {
      issues.push({
        code: "CONFIG_INVALID",
        path: pointer([...base, "secretRefs", i]),
        message_ru: `Коннектор «${connector.id}» не использует секрет «${ref}»`,
        rule: "connector.secret_unknown",
        allowed: [...known].map((n) => `secret://${n}`),
      });
    }
  });
  const parsed = connector.configSchema.safeParse(integration.config ?? {});
  if (!parsed.success) return [...issues, ...zodIssues(parsed.error, [...base, "config"], connector.id)];
  const extra = connector.validateSpec?.(parsed.data, spec, { integration, base: [...base, "config"] }) ?? [];
  return [...issues, ...extra];
}

/** G0 for all integrations of the spec. */
export function validateIntegrations(spec: AppSpec): SpecIssue[] {
  return (spec.integrations ?? []).flatMap((_, i) => validateIntegration(spec, i));
}
