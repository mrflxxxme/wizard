// Spec lookups and issue builders shared by connector validateSpec implementations.
import { type AppSpec, type Entity, type Field, type FieldType, pointer } from "@wizard/appspec";
import { z } from "zod";
import type { SpecCheckContext, SpecIssue } from "./types.js";

export const IDENT_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const ident = z.string().regex(IDENT_RE, {
  error: "Ожидается имя: латиница в нижнем регистре, цифры и _, до 40 символов",
});

/** String length in code points (as in appspec.schema.json). */
export function cpText(min: number, max: number) {
  return z.string().refine((s) => [...s].length >= min && [...s].length <= max, {
    error: `Длина текста — от ${min} до ${max} символов`,
  });
}

export class Issues {
  readonly list: SpecIssue[] = [];
  constructor(private readonly at: SpecCheckContext) {}

  add(rule: string, rel: readonly (string | number)[], message: string, allowed?: readonly string[]): void {
    const issue: SpecIssue = {
      code: "CONFIG_INVALID",
      path: pointer([...this.at.base, ...rel]),
      message_ru: message,
      rule,
    };
    if (allowed) issue.allowed = [...allowed];
    this.list.push(issue);
  }
}

export function entityOf(spec: AppSpec, name: string): Entity | undefined {
  return spec.entities.find((e) => e.name === name);
}

export function fieldOf(entity: Entity | undefined, name: string): Field | undefined {
  return entity?.fields.find((f) => f.name === name);
}

export function enumValues(field: Field | undefined): string[] {
  return field?.type === "enum" ? (field.enum ?? []).map((o) => o.value) : [];
}

export function fieldNames(entity: Entity): string[] {
  return entity.fields.map((f) => f.name);
}

/** Checks `entity` exists; reports and returns undefined otherwise. */
export function requireEntity(
  spec: AppSpec,
  issues: Issues,
  rule: string,
  rel: readonly (string | number)[],
  name: string,
): Entity | undefined {
  const e = entityOf(spec, name);
  if (!e) {
    issues.add(
      rule,
      rel,
      `Сущность «${name}» не найдена в спецификации`,
      spec.entities.map((x) => x.name),
    );
  }
  return e;
}

/** Checks `field` exists on `entity` (and has one of `types`, when given). */
export function requireField(
  entity: Entity,
  issues: Issues,
  rule: string,
  rel: readonly (string | number)[],
  name: string,
  types?: readonly FieldType[],
): Field | undefined {
  const f = fieldOf(entity, name);
  if (!f) {
    issues.add(rule, rel, `Поле «${name}» не найдено в сущности «${entity.name}»`, fieldNames(entity));
    return undefined;
  }
  if (types && !types.includes(f.type)) {
    issues.add(
      `${rule}_type`,
      rel,
      `Поле «${entity.name}.${name}» должно иметь тип ${types.join(" или ")}, а не ${f.type}`,
    );
    return undefined;
  }
  return f;
}

export function requireEnumValue(
  entity: Entity,
  field: Field,
  issues: Issues,
  rule: string,
  rel: readonly (string | number)[],
  value: string,
): void {
  const values = enumValues(field);
  if (!values.includes(value)) {
    issues.add(
      rule,
      rel,
      `Значения «${value}» нет среди статусов поля «${entity.name}.${field.name}»`,
      values,
    );
  }
}

export function hasPermission(spec: AppSpec, role: string, entity: string, op: string): boolean {
  return spec.permissions.some((p) => p.role === role && p.entity === entity && p.ops.includes(op as never));
}

/** A field is unique if marked `unique` or covered alone by a unique index. */
export function isUniqueField(entity: Entity, field: string): boolean {
  if (fieldOf(entity, field)?.unique) return true;
  return (entity.indexes ?? []).some((ix) => ix.unique && ix.fields.length === 1 && ix.fields[0] === field);
}

export function hasDeclaredSecret(at: SpecCheckContext, name: string): boolean {
  return (at.integration.secretRefs ?? []).includes(`secret://${name}`);
}

/** Placeholders `{{a}}`, `{{a.b}}` in a template. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g)].map((m) => m[1] as string);
}
