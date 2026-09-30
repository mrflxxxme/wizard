import { readFileSync } from "node:fs";
import type { AppSpec } from "@wizard/appspec";

const EXAMPLES = new URL("../../../specs/appspec/examples/", import.meta.url);

export type Example = "forum" | "bakery";

export function loadSpec(name: Example): AppSpec {
  return JSON.parse(readFileSync(new URL(`${name}.json`, EXAMPLES), "utf8")) as AppSpec;
}

export function integrationIndex(spec: AppSpec, name: string): number {
  const i = (spec.integrations ?? []).findIndex((x) => x.name === name);
  if (i < 0) throw new Error(`no integration ${name}`);
  return i;
}

// biome-ignore lint/suspicious/noExplicitAny: fixtures mutate arbitrary JSON
export type Json = any;

export function entity(spec: AppSpec, name: string): Json {
  return spec.entities.find((e) => e.name === name);
}

export function field(spec: AppSpec, ent: string, name: string): Json {
  return entity(spec, ent).fields.find((f: Json) => f.name === name);
}

export function config(spec: AppSpec, integration: string): Json {
  return (spec.integrations ?? [])[integrationIndex(spec, integration)]?.config;
}
