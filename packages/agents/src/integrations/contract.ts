// Contract of an outgoing integration (V3-20; D77_v3 (15), D37): the subset of OpenAPI 3.1 a system's integration
// code is generated from — one base URL, the allowed hosts (egress of the integration functions, nothing else), the
// key only as secret://name with where it goes (header or query), the chosen operations with their parameters, JSON
// body and response schemas, the safe operation of the key check and the mapping of the brief's data fields onto the
// API. Stored by the platform in versions (platform.system_integration_contracts); the brief keeps only its reference
// contract://<integration>@<version>#<sha> (contractRef).
import { createHash } from "node:crypto";
import { EGRESS_HOST_RE, IDENT_RE, SECRET_REF_RE } from "@wizard/appspec";
import { canonical } from "@wizard/modules";
import { z } from "zod";
import { type ApiSchema, apiSchemaSchema, isPropName } from "./schema.js";

export const CONTRACT_FORMAT = "wizard.integration/1" as const;

/** Caps of a contract (a document of hundreds of operations is reduced to what the brief needs). */
export const CONTRACT_LIMITS = {
  operations: 30,
  params: 30,
  hosts: 5,
  mapping: 100,
  /** The whole contract as JSON, UTF-8 bytes. */
  bytes: 256 * 1024,
} as const;

export const CONTRACT_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type ContractMethod = (typeof CONTRACT_METHODS)[number];

/** Where the key goes: Authorization: Bearer, a named header, a query parameter; none — an open API. */
export const CONTRACT_AUTH_KINDS = ["none", "bearer", "header", "query"] as const;
/**
 * Every auth kind of a contract: the above and path (V3-22, API passports) — the key is a URL path segment right after
 * the base URL with the literal prefix `name` (Telegram /bot<token>/…; null — no prefix, Bitrix24 /rest/<user>/<code>/…).
 * The runtime egress client resolves secret://name in the path as in headers and the query.
 */
export const CONTRACT_KEY_KINDS = [...CONTRACT_AUTH_KINDS, "path"] as const;
/** Literal prefix of a path key (auth.name of kind path). */
const PATH_KEY_PREFIX_RE = /^[A-Za-z0-9_.-]{1,20}$/;

/** Operation ids are camelCase identifiers: they become parts of function names (functionSchema.name). */
export const OPERATION_ID_RE = /^[a-z][A-Za-z0-9]{0,39}$/;
/** Argument names of the generated functions. */
export const ARG_RE = /^[a-z][A-Za-z0-9]{0,39}$/;
const PATH_RE = /^\/[A-Za-z0-9_.~{}/%:@!$&'()*+,;=-]*$/;

const paramSchema = z.strictObject({
  /** Name in the API (path template, query or header). */
  name: z.string().min(1).max(64).refine(isPropName, "Недопустимое имя параметра"),
  in: z.enum(["path", "query", "header"]),
  required: z.boolean(),
  schema: apiSchemaSchema,
  /** Argument of the generated function. */
  arg: z.string().regex(ARG_RE),
});

const operationSchema = z.strictObject({
  id: z.string().regex(OPERATION_ID_RE),
  method: z.enum(CONTRACT_METHODS),
  path: z.string().max(300).regex(PATH_RE),
  summary: z.string().max(200),
  params: z.array(paramSchema).max(CONTRACT_LIMITS.params),
  /** application/json request body; null — none. */
  body: z.strictObject({ required: z.boolean(), schema: apiSchemaSchema }).nullable(),
  /** The success answer the client expects (the first 2xx of the document). */
  response: z.strictObject({
    status: z.number().int().min(200).max(299),
    schema: apiSchemaSchema,
    example: z.unknown().optional(),
  }),
});

const mappingSchema = z.strictObject({
  /** Entity or brief data name (Russian names of the brief are kept as is). */
  entity: z.string().min(1).max(120),
  field: z.string().min(1).max(120),
  operation: z.string().regex(OPERATION_ID_RE),
  /** JSON Pointer into the request (/body/name, /query/phone) or the response (/response/id). */
  pointer: z.string().regex(/^\/(body|query|path|response)(\/[^/]+)*$/),
  /** to_api — the system sends the field; from_api — the system takes it from the answer. */
  direction: z.enum(["to_api", "from_api"]),
  /** How the pair was found: by name (code) or by the model from prose documentation. */
  by: z.enum(["name", "model"]),
});

export const integrationContractSchema = z
  .strictObject({
    format: z.literal(CONTRACT_FORMAT),
    /** Integration id of the brief (IDENT_RE). */
    id: z.string().regex(IDENT_RE),
    name: z.string().min(1).max(120),
    source: z.strictObject({
      /** passport — a reviewed contract of a popular API (passports/, V3-22). */
      kind: z.enum(["openapi", "swagger", "prose", "passport"]),
      url: z.string().max(500).nullable(),
      sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .nullable(),
      title: z.string().max(200),
      version: z.string().max(60),
    }),
    /** https://host[/base path] without a trailing slash. */
    baseUrl: z
      .string()
      .max(300)
      .regex(/^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9_.~/-]*)?$/),
    /** Allowed hosts (D37): egress of the integration functions is exactly this list. */
    hosts: z.array(z.string().regex(EGRESS_HOST_RE)).min(1).max(CONTRACT_LIMITS.hosts),
    auth: z.strictObject({
      kind: z.enum(CONTRACT_KEY_KINDS),
      /** Header or query parameter name (header, query); literal prefix of the key segment or null (path). */
      name: z.string().max(64).nullable(),
      /** secret://name of the key; null only for kind none. */
      secret: z.string().regex(SECRET_REF_RE).nullable(),
    }),
    operations: z.array(operationSchema).min(1).max(CONTRACT_LIMITS.operations),
    /** Safe read-only operation the key check calls; null — the check calls nothing (open API). */
    check: z.strictObject({ operation: z.string().regex(OPERATION_ID_RE) }).nullable(),
    mapping: z.array(mappingSchema).max(CONTRACT_LIMITS.mapping),
    /** Russian notes of the importer (operations left out, unsupported auth or schema parts). */
    notes: z.array(z.string().max(300)).max(20),
  })
  .superRefine((c, ctx) => {
    const host = new URL(c.baseUrl).hostname;
    if (!c.hosts.includes(host))
      ctx.addIssue({
        code: "custom",
        path: ["hosts"],
        message: `Хост ${host} базового адреса не в списке хостов`,
      });
    const ids = new Set<string>();
    c.operations.forEach((op, i) => {
      if (ids.has(op.id))
        ctx.addIssue({
          code: "custom",
          path: ["operations", i, "id"],
          message: `Операция ${op.id} повторяется`,
        });
      ids.add(op.id);
      const args = new Set<string>(op.body ? ["body"] : []);
      for (const [j, p] of op.params.entries()) {
        if (args.has(p.arg))
          ctx.addIssue({
            code: "custom",
            path: ["operations", i, "params", j, "arg"],
            message: `Аргумент ${p.arg} повторяется`,
          });
        args.add(p.arg);
        if (p.in === "path" && !op.path.includes(`{${p.name}}`))
          ctx.addIssue({
            code: "custom",
            path: ["operations", i, "params", j],
            message: `Параметра пути {${p.name}} нет в ${op.path}`,
          });
      }
      for (const m of op.path.matchAll(/\{([^}]+)\}/g))
        if (!op.params.some((p) => p.in === "path" && p.name === m[1]))
          ctx.addIssue({
            code: "custom",
            path: ["operations", i, "path"],
            message: `Для {${m[1]}} нет параметра пути`,
          });
    });
    if (c.check && !c.operations.some((o) => o.id === c.check?.operation && o.method === "GET"))
      ctx.addIssue({
        code: "custom",
        path: ["check"],
        message: "Проверка ключа — только GET-операция контракта",
      });
    if (c.auth.kind === "none" ? c.auth.secret !== null : c.auth.secret === null)
      ctx.addIssue({
        code: "custom",
        path: ["auth", "secret"],
        message: "Ключ нужен для всех видов авторизации, кроме none",
      });
    if ((c.auth.kind === "header" || c.auth.kind === "query") && !c.auth.name)
      ctx.addIssue({
        code: "custom",
        path: ["auth", "name"],
        message: "Нужно имя заголовка или параметра ключа",
      });
    if (c.auth.kind === "path" && c.auth.name !== null && !PATH_KEY_PREFIX_RE.test(c.auth.name))
      ctx.addIssue({
        code: "custom",
        path: ["auth", "name"],
        message: "Префикс ключа в пути — латиница, цифры, _ . - (до 20 символов)",
      });
    for (const [i, m] of c.mapping.entries())
      if (!ids.has(m.operation))
        ctx.addIssue({
          code: "custom",
          path: ["mapping", i, "operation"],
          message: `Операции ${m.operation} нет в контракте`,
        });
    const bytes = Buffer.byteLength(JSON.stringify(c));
    if (bytes > CONTRACT_LIMITS.bytes)
      ctx.addIssue({
        code: "custom",
        path: [],
        message: `Контракт больше ${CONTRACT_LIMITS.bytes / 1024} КБ`,
      });
  });

export type IntegrationContract = z.output<typeof integrationContractSchema>;
export type ContractOperation = IntegrationContract["operations"][number];
export type ContractParam = ContractOperation["params"][number];
export type ContractMapping = IntegrationContract["mapping"][number];
export type { ApiSchema };

export class ContractInvalidError extends Error {
  constructor(readonly issues: { path: string; message_ru: string }[]) {
    super(`contract invalid: ${issues.map((i) => `${i.path} ${i.message_ru}`).join("; ")}`);
  }
}

/** Parses a contract; throws ContractInvalidError with Russian issues. */
export function parseContract(raw: unknown): IntegrationContract {
  const r = integrationContractSchema.safeParse(raw);
  if (r.success) return r.data;
  throw new ContractInvalidError(
    r.error.issues.slice(0, 20).map((i) => ({ path: `/${i.path.join("/")}`, message_ru: i.message })),
  );
}

/** sha256 of the canonical JSON of a contract (the version's fingerprint). */
export function contractHash(c: IntegrationContract): string {
  return createHash("sha256")
    .update(canonical(c) ?? "null")
    .digest("hex");
}

const REF_RE = /^contract:\/\/([a-z][a-z0-9_]{0,39})@(\d{1,6})#([0-9a-f]{12})$/;

/** contractRef of the brief: contract://<integration>@<version>#<first 12 hex of the sha256>. */
export function contractRef(id: string, version: number, sha256: string): string {
  return `contract://${id}@${version}#${sha256.slice(0, 12)}`;
}

/** contract://… → {id, version, sha12}; anything else (a repository file, a documentation URL) → null. */
export function parseContractRef(
  ref: string | undefined | null,
): { id: string; version: number; sha12: string } | null {
  const m = REF_RE.exec(ref ?? "");
  return m ? { id: m[1] as string, version: Number(m[2]), sha12: m[3] as string } : null;
}

/** secret://name → name. */
export const secretName = (ref: string): string => ref.slice("secret://".length);

/** Default key name of an integration: <id>_key (secret://<id>_key). */
export const defaultSecretRef = (id: string): string => `secret://${id}_key`;
