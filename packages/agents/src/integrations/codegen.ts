// Typed client of a contract as system code (V3-20): functions/integrations/<id>/{types,mock,client}.ts and one action
// per operation, checked by G0 like any function (only @wizard/sdk and own files, v.* arguments, strict tsc). Mode
// «mock» — no network code at all: the client answers from the contract's mock (the same bodies the platform's mock
// gives), the functions declare no egress and no key. Mode «live» (after the key check) — ctx.http.fetch on literal
// https URLs of the contract's base, the key as secret://name in the header or the query; the functions declare
// exactly the contract's hosts and its key (D37), so the runtime and its egress proxy let nothing else out.
import type { AppSpec } from "@wizard/appspec";
import { mockBody } from "./client.js";
import { type ContractOperation, type IntegrationContract, secretName } from "./contract.js";
import type { ApiSchema } from "./schema.js";

export type IntegrationMode = "mock" | "live";
export type SpecFunction = NonNullable<AppSpec["functions"]>[number];

/** Folder of an integration's code in the system. */
export const integrationDir = (id: string): string => `functions/integrations/${id}`;
/** Matches files of integration code: functions/integrations/<id>/… */
export const INTEGRATION_FILE_RE = /^functions\/integrations\/([a-z][a-z0-9_]{0,39})\//;

const pascal = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const camelOf = (id: string) =>
  id
    .split("_")
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p : pascal(p)))
    .join("");

/** Name of the action of an operation: <camel integration id><Operation> (functionSchema.name, ≤ 60). */
export function integrationFunctionName(contractId: string, opId: string): string {
  return `${camelOf(contractId)}${pascal(opId)}`.slice(0, 60);
}

const IDENT_TS_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (name: string) => (IDENT_TS_RE.test(name) ? name : JSON.stringify(name));
const lit = (v: unknown) => JSON.stringify(v);

/** TypeScript type of a schema node (answers: unknown where the schema is free-form). */
export function tsType(s: ApiSchema, indent = ""): string {
  let t: string;
  if (s.enum?.length) t = s.enum.map((v) => lit(v)).join(" | ");
  else
    switch (s.type) {
      case "string":
        t = "string";
        break;
      case "integer":
      case "number":
        t = "number";
        break;
      case "boolean":
        t = "boolean";
        break;
      case "null":
        t = "null";
        break;
      case "array":
        t = s.items ? `Array<${tsType(s.items, indent)}>` : "unknown[]";
        break;
      case "object": {
        const props = Object.entries(s.properties ?? {});
        if (!props.length) {
          t = "Record<string, unknown>";
          break;
        }
        const req = new Set(s.required ?? []);
        const inner = `${indent}  `;
        t = `{\n${props
          .map(
            ([n, sub]) =>
              `${inner}${key(n)}${req.has(n) ? "" : "?"}: ${tsType(sub, inner)}${req.has(n) ? "" : " | undefined"};`,
          )
          .join("\n")}\n${indent}}`;
        break;
      }
      default:
        t = "unknown";
    }
  return s.nullable && t !== "unknown" && t !== "null" ? `${t} | null` : t;
}

/**
 * v.* validator and TS type of an argument schema, or null when the subset cannot validate it (free-form value): such
 * a property is left out of the function's arguments (and of the request).
 */
export function argOf(s: ApiSchema, indent = ""): { v: string; ts: string } | null {
  let r: { v: string; ts: string } | null = null;
  const bounds = (o: Record<string, number | undefined>) => {
    const parts = Object.entries(o)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${k}: ${x}`);
    return parts.length ? `{ ${parts.join(", ")} }` : "";
  };
  if (s.enum?.length) {
    const strs = s.enum.filter((x): x is string => typeof x === "string");
    if (strs.length === s.enum.length)
      r = { v: `v.enum(${strs.map(lit).join(", ")})`, ts: strs.map(lit).join(" | ") };
    else if (s.enum.every((x) => typeof x === "number")) r = { v: "v.number()", ts: "number" };
    else if (s.enum.every((x) => typeof x === "boolean")) r = { v: "v.boolean()", ts: "boolean" };
  } else
    switch (s.type) {
      case "string":
        r =
          s.format === "date"
            ? { v: "v.date()", ts: "string" }
            : s.format === "date-time"
              ? { v: "v.datetime()", ts: "string" }
              : { v: `v.string(${bounds({ min: s.minLength, max: s.maxLength })})`, ts: "string" };
        break;
      case "integer":
        r = { v: `v.int(${bounds({ min: s.minimum, max: s.maximum })})`, ts: "number" };
        break;
      case "number":
        r = { v: `v.number(${bounds({ min: s.minimum, max: s.maximum })})`, ts: "number" };
        break;
      case "boolean":
        r = { v: "v.boolean()", ts: "boolean" };
        break;
      case "array": {
        const item = s.items ? argOf(s.items, indent) : null;
        if (item)
          r = {
            v: `v.array(${item.v}${s.maxItems !== undefined ? `, { max: ${s.maxItems} }` : ""})`,
            ts: `Array<${item.ts}>`,
          };
        break;
      }
      case "object": {
        const shape = objectShape(s, indent);
        if (shape) r = { v: `v.object(${shape.v})`, ts: shape.ts };
        break;
      }
      default:
        r = null;
    }
  if (r && s.nullable) r = { v: `v.nullable(${r.v})`, ts: `${r.ts} | null` };
  return r;
}

/** Shape of an object schema with named properties: `{ a: v.…, … }` and its type; null when nothing is supported. */
function objectShape(s: ApiSchema, indent: string): { v: string; ts: string; keys: string[] } | null {
  const req = new Set(s.required ?? []);
  const inner = `${indent}  `;
  const vs: string[] = [];
  const ts: string[] = [];
  const keys: string[] = [];
  for (const [n, sub] of Object.entries(s.properties ?? {})) {
    const a = argOf(sub, inner);
    if (!a) continue;
    keys.push(n);
    const opt = !req.has(n);
    vs.push(`${inner}${key(n)}: ${opt ? `v.optional(${a.v})` : a.v},`);
    ts.push(`${inner}${key(n)}${opt ? "?" : ""}: ${a.ts}${opt ? " | undefined" : ""};`);
  }
  if (!keys.length) return null;
  return { v: `{\n${vs.join("\n")}\n${indent}}`, ts: `{\n${ts.join("\n")}\n${indent}}`, keys };
}

interface OpArgs {
  /** `args: {…}` body of the action. */
  validators: string[];
  /** Fields of the input type. */
  fields: string[];
  /** Params that made it into the arguments. */
  params: ContractOperation["params"];
  hasBody: boolean;
}

function opArgs(op: ContractOperation): OpArgs {
  const validators: string[] = [];
  const fields: string[] = [];
  const params: ContractOperation["params"] = [];
  for (const p of op.params) {
    const a = argOf(p.schema, "  ");
    if (!a) {
      if (p.required) throw new Error(`required param ${p.name} of ${op.id} has no validator`);
      continue;
    }
    params.push(p);
    validators.push(`    ${p.arg}: ${p.required ? a.v : `v.optional(${a.v})`},`);
    fields.push(`  ${p.arg}${p.required ? "" : "?"}: ${a.ts}${p.required ? "" : " | undefined"};`);
  }
  let hasBody = false;
  if (op.body) {
    const a = argOf(op.body.schema, "    ");
    if (a) {
      hasBody = true;
      validators.push(`    body: ${op.body.required ? a.v : `v.optional(${a.v})`},`);
      fields.push(`  body${op.body.required ? "" : "?"}: ${a.ts}${op.body.required ? "" : " | undefined"};`);
    } else if (op.body.required) throw new Error(`body of ${op.id} has no validator`);
  }
  return { validators, fields, params, hasBody };
}

/** Whether an operation can be generated (its required params and body are expressible as v.* arguments). */
export function generatable(op: ContractOperation): boolean {
  try {
    opArgs(op);
    return true;
  } catch {
    return false;
  }
}

const header = (c: IntegrationContract, ref: string) =>
  `// Generated by Wizard from the integration contract «${c.name.replace(/[\r\n]/g, " ")}» (${ref}).\n// Do not edit: the platform regenerates this file when the contract or the key changes.\n`;

function typesFile(c: IntegrationContract, ops: readonly ContractOperation[], ref: string): string {
  const parts = [header(c, ref)];
  for (const op of ops) {
    const a = opArgs(op);
    const T = pascal(op.id);
    parts.push(
      `/** ${op.method} ${op.path}${op.summary ? ` — ${op.summary.replace(/\*\//g, "* /")}` : ""} */`,
    );
    parts.push(
      a.fields.length
        ? `export interface ${T}Input {\n${a.fields.join("\n")}\n}`
        : `export type ${T}Input = Record<string, unknown>;`,
    );
    parts.push(
      `export type ${T}Output = ${op.response.status === 204 ? "null" : tsType(op.response.schema)};\n`,
    );
  }
  return `${parts.join("\n")}\n`;
}

function mockFile(c: IntegrationContract, ops: readonly ContractOperation[], ref: string): string {
  const entries = ops.map(
    (op) =>
      `  ${op.id}: { status: ${op.response.status}, body: ${JSON.stringify(mockBody(c, op))} as unknown },`,
  );
  return `${header(c, ref)}\n/** Answers of the mock by operation: the same bodies the platform's contract tests check. */\nexport const MOCK = {\n${entries.join("\n")}\n};\n`;
}

/** Template literal of an operation's URL: the literal base, path params by encodeURIComponent, then the query. */
function urlExpr(c: IntegrationContract, op: ContractOperation, params: ContractOperation["params"]): string {
  let path = op.path.replace(/`/g, "").replace(/\$\{/g, "$ {");
  for (const p of params.filter((x) => x.in === "path"))
    path = path.split(`{${p.name}}`).join(`\${seg(input.${p.arg})}`);
  const q = params.filter((x) => x.in === "query").map((p) => `[${lit(p.name)}, input.${p.arg}]`);
  const auth =
    c.auth.kind === "query" && c.auth.secret && c.auth.name
      ? `, ${lit(`${encodeURIComponent(c.auth.name)}=${c.auth.secret}`)}`
      : "";
  const query = q.length || auth ? `\${query([${q.join(", ")}]${auth})}` : "";
  return `\`${c.baseUrl}${path}${query}\``;
}

function headersExpr(c: IntegrationContract, params: ContractOperation["params"], hasBody: boolean): string {
  const h: string[] = [`Accept: "application/json"`];
  if (hasBody) h.push(`"Content-Type": "application/json"`);
  if (c.auth.secret && c.auth.kind === "bearer") h.push(`Authorization: ${lit(`Bearer ${c.auth.secret}`)}`);
  if (c.auth.secret && c.auth.kind === "header" && c.auth.name)
    h.push(`${key(c.auth.name)}: ${lit(c.auth.secret)}`);
  const extra = params
    .filter((p) => p.in === "header")
    .map((p) => `...(input.${p.arg} === undefined ? {} : { ${key(p.name)}: text(input.${p.arg}) })`);
  return `{ ${[...h, ...extra].join(", ")} }`;
}

function clientFile(
  c: IntegrationContract,
  ops: readonly ContractOperation[],
  mode: IntegrationMode,
  ref: string,
): string {
  const types = ops.flatMap((op) => [`${pascal(op.id)}Input`, `${pascal(op.id)}Output`]);
  const out: string[] = [header(c, ref)];
  if (mode === "mock") {
    out.push(`import { MOCK } from "./mock";`);
    out.push(`import type { ${types.join(", ")} } from "./types";\n`);
    out.push(
      `/** mock — answers from the contract's mock without network; live — requests to the API with the key. */`,
    );
    out.push(`export const MODE = "mock" as const;\n`);
    for (const op of ops) {
      const T = pascal(op.id);
      out.push(
        `/** ${op.method} ${op.path} (mock) */\nexport async function ${op.id}(_input: ${T}Input): Promise<${T}Output> {\n  return MOCK.${op.id}.body as ${T}Output;\n}\n`,
      );
    }
    return out.join("\n");
  }
  out.push(`import type { ActionCtx } from "@wizard/sdk";`);
  out.push(`import type { ${types.join(", ")} } from "./types";\n`);
  out.push(
    `/** mock — answers from the contract's mock without network; live — requests to the API with the key. */`,
  );
  out.push(`export const MODE = "live" as const;\n`);
  out.push(`const text = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));`);
  out.push(`const seg = (v: unknown): string => encodeURIComponent(text(v));`);
  out.push(`/** ?a=1&b=2 of the defined values; \`raw\` (the key as secret://name) is appended as is. */`);
  out.push(`function query(pairs: Array<[string, unknown]>, raw?: string): string {
  const parts: string[] = [];
  for (const [k, v] of pairs) {
    if (v === undefined || v === null) continue;
    for (const item of Array.isArray(v) ? v : [v]) parts.push(\`\${encodeURIComponent(k)}=\${seg(item)}\`);
  }
  if (raw) parts.push(raw);
  return parts.length ? \`?\${parts.join("&")}\` : "";
}`);
  out.push(`/** The answer as JSON; anything but 2xx is an error of the function with the status (no body: it may hold ПДн). */
async function answer(ctx: ActionCtx, res: { status: number; text(): Promise<string> }): Promise<unknown> {
  if (res.status < 200 || res.status > 299)
    throw ctx.error("INTEGRATION_FAILED", { message: ${lit(`Сервис «${c.name}» ответил ошибкой`)}, status: res.status });
  const body = await res.text();
  return body.trim() === "" ? null : JSON.parse(body);
}\n`);
  for (const op of ops) {
    const T = pascal(op.id);
    const a = opArgs(op);
    const init = [`method: ${lit(op.method)}`, `headers: ${headersExpr(c, a.params, a.hasBody)}`];
    if (a.hasBody) init.push(`body: JSON.stringify(input.body ?? null)`);
    const used = a.params.length > 0 || a.hasBody;
    out.push(`/** ${op.method} ${op.path} */
export async function ${op.id}(ctx: ActionCtx, ${used ? "input" : "_input"}: ${T}Input): Promise<${T}Output> {
  const res = await ctx.http.fetch(${urlExpr(c, op, a.params)}, { ${init.join(", ")} });
  return (await answer(ctx, res)) as ${T}Output;
}\n`);
  }
  return out.join("\n");
}

function actionFile(
  c: IntegrationContract,
  op: ContractOperation,
  mode: IntegrationMode,
  ref: string,
): string {
  const a = opArgs(op);
  const call = mode === "mock" ? `${op.id}(args)` : `${op.id}(ctx, args)`;
  const handler = mode === "mock" ? `async (_ctx, args) => ${call}` : `async (ctx, args) => ${call}`;
  return `${header(c, ref)}import { action, v } from "@wizard/sdk";
import { ${op.id} } from "./client";

/** ${c.name.replace(/\*\//g, "* /")}: ${op.method} ${op.path}${op.summary ? ` — ${op.summary.replace(/\*\//g, "* /")}` : ""} */
export default action({
  args: {
${a.validators.join("\n")}
  },
  handler: ${handler},
});
`;
}

export interface IntegrationCode {
  /** System files by path (functions/integrations/<id>/**). */
  files: Record<string, string>;
  /** Spec functions: one action per operation; live — egress = the contract's hosts, secretRefs = its key. */
  functions: SpecFunction[];
  /** Operations left out (their required arguments are not expressible), Russian. */
  skipped: string[];
}

/** Generates the integration code of a contract in a mode; `ref` — its contractRef (headers of the files). */
export function integrationCode(
  contract: IntegrationContract,
  mode: IntegrationMode,
  ref: string,
): IntegrationCode {
  const dir = integrationDir(contract.id);
  const ops = contract.operations.filter(generatable);
  const skipped = contract.operations
    .filter((o) => !ops.includes(o))
    .map((o) => `Операция ${o.method} ${o.path} пропущена: её параметры не описать проверяемыми аргументами`);
  const files: Record<string, string> = {
    [`${dir}/types.ts`]: typesFile(contract, ops, ref),
    [`${dir}/mock.ts`]: mockFile(contract, ops, ref),
    [`${dir}/client.ts`]: clientFile(contract, ops, mode, ref),
  };
  const functions: SpecFunction[] = [];
  for (const op of ops) {
    const file = `${dir}/${op.id}.ts`;
    files[file] = actionFile(contract, op, mode, ref);
    functions.push({
      name: integrationFunctionName(contract.id, op.id),
      kind: "action",
      file,
      ...(mode === "live"
        ? {
            egress: [...contract.hosts],
            ...(contract.auth.secret ? { secretRefs: [contract.auth.secret] } : {}),
          }
        : {}),
    });
  }
  return { files, functions, skipped };
}

/** Key name of a contract (secret://<name> → <name>), null for an open API. */
export const contractSecretName = (c: IntegrationContract): string | null =>
  c.auth.secret ? secretName(c.auth.secret) : null;
