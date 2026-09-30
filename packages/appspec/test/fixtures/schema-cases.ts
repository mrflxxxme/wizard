// Programmatic fixtures for the zod ⇔ JSON Schema agreement test (M0-02 acceptance: 40+ valid/invalid).
// Each case mutates a deep copy of the forum spec; `valid` is the expected structural verdict.
import forum from "./forum.json" with { type: "json" };

// biome-ignore lint/suspicious/noExplicitAny: fixtures deliberately build malformed specs
type Json = any;

export interface SchemaCase {
  name: string;
  valid: boolean;
  spec: unknown;
}

export function baseSpec(): Json {
  return structuredClone(forum);
}

const mutations: [string, boolean, (s: Json) => unknown][] = [
  ["forum as is", true, (s) => s],
  [
    "minimal spec",
    true,
    () => ({
      specVersion: "1",
      app: { name: "A", locale: "ru" },
      entities: [],
      roles: [{ name: "r", label: "Р", access: "login" }],
      permissions: [],
    }),
  ],
  [
    "specVersion 2",
    false,
    (s) => {
      s.specVersion = "2";
    },
  ],
  [
    "specVersion number",
    false,
    (s) => {
      s.specVersion = 1;
    },
  ],
  [
    "missing app",
    false,
    (s) => {
      delete s.app;
    },
  ],
  [
    "missing entities",
    false,
    (s) => {
      delete s.entities;
    },
  ],
  [
    "missing permissions",
    false,
    (s) => {
      delete s.permissions;
    },
  ],
  [
    "extra top-level key",
    false,
    (s) => {
      s.extra = true;
    },
  ],
  [
    "app locale en",
    false,
    (s) => {
      s.app.locale = "en";
    },
  ],
  [
    "app name empty",
    false,
    (s) => {
      s.app.name = "";
    },
  ],
  [
    "app name 80 code points (emoji)",
    true,
    (s) => {
      s.app.name = "😀".repeat(80);
    },
  ],
  [
    "app name 81 code points (emoji)",
    false,
    (s) => {
      s.app.name = "😀".repeat(81);
    },
  ],
  [
    "app description 2000",
    true,
    (s) => {
      s.app.description = "я".repeat(2000);
    },
  ],
  [
    "app description 2001",
    false,
    (s) => {
      s.app.description = "я".repeat(2001);
    },
  ],
  [
    "app template ok",
    true,
    (s) => {
      s.app.template = "forum";
    },
  ],
  [
    "app extra key",
    false,
    (s) => {
      s.app.owner = "x";
    },
  ],
  [
    "theme accent lower hex",
    true,
    (s) => {
      s.theme.accent = "#abcdef";
    },
  ],
  [
    "theme accent short",
    false,
    (s) => {
      s.theme.accent = "#abc";
    },
  ],
  [
    "theme font unknown",
    false,
    (s) => {
      s.theme.font = "Arial";
    },
  ],
  [
    "theme radius 4",
    true,
    (s) => {
      s.theme.radius = 4;
    },
  ],
  [
    "theme radius 5",
    false,
    (s) => {
      s.theme.radius = 5;
    },
  ],
  [
    "theme radius string",
    false,
    (s) => {
      s.theme.radius = "8";
    },
  ],
  [
    "theme extra",
    false,
    (s) => {
      s.theme.shadow = true;
    },
  ],
  [
    "no roles",
    false,
    (s) => {
      s.roles = [];
    },
  ],
  [
    "21 roles",
    false,
    (s) => {
      s.roles = Array.from({ length: 21 }, (_, i) => ({ name: `r${i}`, label: "Р", access: "login" }));
    },
  ],
  [
    "20 roles",
    true,
    (s) => {
      s.roles = Array.from({ length: 20 }, (_, i) => ({ name: `r${i}`, label: "Р", access: "login" }));
    },
  ],
  [
    "role access admin",
    false,
    (s) => {
      s.roles[0].access = "admin";
    },
  ],
  [
    "role loginMethods empty",
    false,
    (s) => {
      s.roles[1].loginMethods = [];
    },
  ],
  [
    "role loginMethods sms",
    false,
    (s) => {
      s.roles[1].loginMethods = ["sms"];
    },
  ],
  [
    "role name uppercase",
    false,
    (s) => {
      s.roles[0].name = "Guest";
    },
  ],
  [
    "role name 40 chars",
    true,
    (s) => {
      s.roles[0].name = `g${"x".repeat(39)}`;
    },
  ],
  [
    "role name 41 chars",
    false,
    (s) => {
      s.roles[0].name = `g${"x".repeat(40)}`;
    },
  ],
  [
    "role name starts with digit",
    false,
    (s) => {
      s.roles[0].name = "1guest";
    },
  ],
  [
    "role name trailing newline",
    false,
    (s) => {
      s.roles[0].name = "guest\n";
    },
  ],
  [
    "label empty",
    false,
    (s) => {
      s.roles[0].label = "";
    },
  ],
  [
    "label 80 cyrillic",
    true,
    (s) => {
      s.roles[0].label = "ж".repeat(80);
    },
  ],
  [
    "label 81 cyrillic",
    false,
    (s) => {
      s.roles[0].label = "ж".repeat(81);
    },
  ],
  [
    "61 entities",
    false,
    (s) => {
      s.entities = Array.from({ length: 61 }, (_, i) => ({
        name: `e${i}`,
        label: "Е",
        fields: [{ name: "a", label: "А", type: "int" }],
      }));
      s.permissions = [];
    },
  ],
  [
    "60 entities",
    true,
    (s) => {
      s.entities = Array.from({ length: 60 }, (_, i) => ({
        name: `e${i}`,
        label: "Е",
        fields: [{ name: "a", label: "А", type: "int" }],
      }));
      s.permissions = [];
    },
  ],
  [
    "entity without fields",
    false,
    (s) => {
      s.entities[0].fields = [];
    },
  ],
  [
    "81 fields",
    false,
    (s) => {
      s.entities[3].fields = Array.from({ length: 81 }, (_, i) => ({
        name: `f${i}`,
        label: "П",
        type: "int",
      }));
    },
  ],
  [
    "80 fields",
    true,
    (s) => {
      s.entities[3].fields = Array.from({ length: 80 }, (_, i) => ({
        name: `f${i}`,
        label: "П",
        type: "int",
      }));
    },
  ],
  [
    "entity extra key",
    false,
    (s) => {
      s.entities[0].color = "red";
    },
  ],
  [
    "field type unknown",
    false,
    (s) => {
      s.entities[0].fields[0].type = "varchar";
    },
  ],
  [
    "field extra key",
    false,
    (s) => {
      s.entities[0].fields[0].hidden = true;
    },
  ],
  [
    "field default any object",
    true,
    (s) => {
      s.entities[0].fields[1].default = { a: [1, null] };
    },
  ],
  [
    "field default null",
    true,
    (s) => {
      s.entities[0].fields[1].default = null;
    },
  ],
  [
    "field required string",
    false,
    (s) => {
      s.entities[0].fields[0].required = "yes";
    },
  ],
  [
    "field pii unknown",
    false,
    (s) => {
      s.entities[0].fields[0].pii = "secret";
    },
  ],
  [
    "field pii special (structurally ok)",
    true,
    (s) => {
      s.entities[0].fields[0].pii = "special";
    },
  ],
  [
    "field maxLength 0",
    false,
    (s) => {
      s.entities[0].fields[0].maxLength = 0;
    },
  ],
  [
    "field maxLength 100000",
    true,
    (s) => {
      s.entities[0].fields[0].maxLength = 100000;
    },
  ],
  [
    "field maxLength 100001",
    false,
    (s) => {
      s.entities[0].fields[0].maxLength = 100001;
    },
  ],
  [
    "field maxLength 1.5",
    false,
    (s) => {
      s.entities[0].fields[0].maxLength = 1.5;
    },
  ],
  [
    "field maxLength 2.0",
    true,
    (s) => {
      s.entities[0].fields[0].maxLength = 2.0;
    },
  ],
  [
    "field min float",
    true,
    (s) => {
      s.entities[0].fields[0].min = -1.5;
    },
  ],
  [
    "field min string",
    false,
    (s) => {
      s.entities[0].fields[0].min = "1";
    },
  ],
  [
    "enum empty",
    false,
    (s) => {
      s.entities[0].fields[3].enum = [];
    },
  ],
  [
    "enum option extra key (strict)",
    false,
    (s) => {
      s.entities[0].fields[3].enum[0].color = "red";
    },
  ],
  [
    "enum option missing label",
    false,
    (s) => {
      delete s.entities[0].fields[3].enum[0].label;
    },
  ],
  [
    "enum value not ident",
    false,
    (s) => {
      s.entities[0].fields[3].enum[0].value = "Open";
    },
  ],
  [
    "ref extra key (strict)",
    false,
    (s) => {
      s.entities[1].fields[0].ref.note = "x";
    },
  ],
  [
    "ref onDelete set_null",
    true,
    (s) => {
      s.entities[1].fields[0].ref.onDelete = "set_null";
    },
  ],
  [
    "ref onDelete nullify",
    false,
    (s) => {
      s.entities[1].fields[0].ref.onDelete = "nullify";
    },
  ],
  [
    "ref without entity",
    false,
    (s) => {
      s.entities[1].fields[0].ref = {};
    },
  ],
  [
    "index empty fields",
    false,
    (s) => {
      s.entities[0].indexes = [{ fields: [] }];
    },
  ],
  [
    "index extra key (strict)",
    false,
    (s) => {
      s.entities[0].indexes[0].method = "btree";
    },
  ],
  [
    "retention ok",
    true,
    (s) => {
      s.entities[2].retention = { deleteAfterDays: 30, mode: "anonymize" };
    },
  ],
  [
    "retention 0 days",
    false,
    (s) => {
      s.entities[2].retention = { deleteAfterDays: 0 };
    },
  ],
  [
    "retention 3651 days",
    false,
    (s) => {
      s.entities[2].retention = { deleteAfterDays: 3651 };
    },
  ],
  [
    "retention missing days",
    false,
    (s) => {
      s.entities[2].retention = { mode: "delete" };
    },
  ],
  [
    "retention extra (strict)",
    false,
    (s) => {
      s.entities[2].retention = { deleteAfterDays: 5, why: "x" };
    },
  ],
  [
    "permission ops duplicated",
    false,
    (s) => {
      s.permissions[0].ops = ["read", "read"];
    },
  ],
  [
    "permission ops unknown",
    false,
    (s) => {
      s.permissions[0].ops = ["write"];
    },
  ],
  [
    "permission ops empty",
    true,
    (s) => {
      s.permissions[0].ops = [];
    },
  ],
  [
    "permission missing ops",
    false,
    (s) => {
      delete s.permissions[0].ops;
    },
  ],
  [
    "rowFilter number and bool",
    true,
    (s) => {
      s.permissions[3].rowFilter = { author: "$user.id", n: 1, b: true };
    },
  ],
  [
    "rowFilter object value",
    false,
    (s) => {
      s.permissions[3].rowFilter = { author: { eq: 1 } };
    },
  ],
  [
    "rowFilter null value",
    false,
    (s) => {
      s.permissions[3].rowFilter = { author: null };
    },
  ],
  [
    "rowFilter array",
    false,
    (s) => {
      s.permissions[3].rowFilter = ["author"];
    },
  ],
  [
    "hiddenFields bad ident",
    false,
    (s) => {
      s.permissions[3].hiddenFields = ["Body"];
    },
  ],
  [
    "workflow no steps",
    false,
    (s) => {
      s.workflows[0].steps = [];
    },
  ],
  [
    "workflow 21 steps",
    false,
    (s) => {
      s.workflows[0].steps = Array.from({ length: 21 }, () => ({ type: "wait" }));
    },
  ],
  [
    "workflow step unknown type",
    false,
    (s) => {
      s.workflows[0].steps[0].type = "sleep";
    },
  ],
  [
    "workflow step params array",
    false,
    (s) => {
      s.workflows[0].steps[0].params = [1];
    },
  ],
  [
    "workflow trigger extra (strict)",
    false,
    (s) => {
      s.workflows[0].trigger.debounce = 5;
    },
  ],
  [
    "workflow trigger relative float offset",
    false,
    (s) => {
      s.workflows[0].trigger.relative = { field: "until", offsetMinutes: 1.5 };
    },
  ],
  [
    "workflow trigger equals anything",
    true,
    (s) => {
      s.workflows[0].trigger.equals = [1, "a", null];
    },
  ],
  [
    "101 workflows",
    false,
    (s) => {
      s.workflows = Array.from({ length: 101 }, (_, i) => ({
        name: `w${i}`,
        trigger: { type: "manual" },
        steps: [{ type: "wait" }],
      }));
    },
  ],
  [
    "integration ok",
    true,
    (s) => {
      s.integrations = [
        { name: "pay", connector: "yookassa", config: { shop: "1" }, secretRefs: ["secret://yk_key"] },
      ];
    },
  ],
  [
    "integration bad secretRef",
    false,
    (s) => {
      s.integrations = [{ name: "pay", connector: "yookassa", secretRefs: ["yk_key"] }];
    },
  ],
  [
    "integration unknown connector",
    false,
    (s) => {
      s.integrations = [{ name: "pay", connector: "stripe" }];
    },
  ],
  [
    "function name camelCase",
    true,
    (s) => {
      s.functions[0].name = "topicStatsV2";
    },
  ],
  [
    "function name snake",
    false,
    (s) => {
      s.functions[0].name = "topic_stats";
    },
  ],
  [
    "function file tsx",
    false,
    (s) => {
      s.functions[0].file = "functions/topicStats.tsx";
    },
  ],
  [
    "function file outside",
    false,
    (s) => {
      s.functions[0].file = "src/topicStats.ts";
    },
  ],
  [
    "function kind cron",
    false,
    (s) => {
      s.functions[0].kind = "cron";
    },
  ],
  [
    "201 functions",
    false,
    (s) => {
      s.functions = Array.from({ length: 201 }, (_, i) => ({
        name: `f${i}`,
        kind: "query",
        file: `functions/f${i}.ts`,
      }));
    },
  ],
  [
    "page route upper",
    false,
    (s) => {
      s.pages[0].route = "/Topics";
    },
  ],
  [
    "page route no slash",
    false,
    (s) => {
      s.pages[0].route = "topics";
    },
  ],
  [
    "page roles empty",
    false,
    (s) => {
      s.pages[0].roles = [];
    },
  ],
  [
    "page file ts",
    false,
    (s) => {
      s.pages[0].file = "ui/Topics.ts";
    },
  ],
  [
    "81 pages",
    false,
    (s) => {
      s.pages = Array.from({ length: 81 }, (_, i) => ({
        route: `/p${i}`,
        title: "С",
        file: "ui/P.tsx",
        roles: ["guest"],
      }));
    },
  ],
  [
    "aiAction ok",
    true,
    (s) => {
      s.aiActions = [
        {
          name: "summary",
          kind: "generate",
          input: { entity: "topic" },
          output: { field: "body" },
          tier: "T0",
          monthlyLimit: 10,
        },
      ];
    },
  ],
  [
    "aiAction tier T1",
    false,
    (s) => {
      s.aiActions = [{ name: "summary", kind: "generate", input: {}, output: {}, tier: "T1" }];
    },
  ],
  [
    "aiAction limit 0",
    false,
    (s) => {
      s.aiActions = [{ name: "summary", kind: "extract", input: {}, output: {}, monthlyLimit: 0 }];
    },
  ],
  [
    "acceptance id AC1000",
    false,
    (s) => {
      s.acceptance[0].id = "AC1000";
    },
  ],
  [
    "acceptance check expect maybe",
    false,
    (s) => {
      s.acceptance[0].check.expect = "maybe";
    },
  ],
  [
    "acceptance check extra (strict)",
    false,
    (s) => {
      s.acceptance[0].check.note = "x";
    },
  ],
  [
    "acceptance check steps not array",
    false,
    (s) => {
      s.acceptance[0].check.steps = {};
    },
  ],
  [
    "compliance extra (retentionWaiver not in M0 schema)",
    false,
    (s) => {
      s.compliance.retentionWaiver = true;
    },
  ],
  [
    "compliance full",
    true,
    (s) => {
      s.compliance = { consentText: "a", policyPage: "/privacy", operatorName: "ИП Иванов" };
    },
  ],
  [
    "field piiKind ok",
    true,
    (s) => {
      s.entities[0].fields[1].piiKind = "free_text";
    },
  ],
  [
    "field piiKind unknown",
    false,
    (s) => {
      s.entities[0].fields[1].piiKind = "dna";
    },
  ],
  [
    "compliance operatorInn 10 digits",
    true,
    (s) => {
      s.compliance.operatorInn = "7707083893";
    },
  ],
  [
    "compliance operatorInn 11 digits",
    false,
    (s) => {
      s.compliance.operatorInn = "77070838931";
    },
  ],
  [
    "compliance retentionWaiver ok",
    true,
    (s) => {
      s.compliance.retentionWaiver = { reason: "Храним до конца мероприятия" };
    },
  ],
  [
    "compliance retentionWaiver short reason",
    false,
    (s) => {
      s.compliance.retentionWaiver = { reason: "коротко" };
    },
  ],
  [
    "compliance retentionWaiver extra",
    false,
    (s) => {
      s.compliance.retentionWaiver = { reason: "Достаточно длинная причина", until: 1 };
    },
  ],
  [
    "acceptance scenario actors/seed/milestone",
    true,
    (s) => {
      s.acceptance[0].check = {
        type: "scenario",
        actors: { a: { role: "member", note: 1 } },
        seed: "none",
        milestone: "M1",
        steps: [{ call: "x" }],
      };
    },
  ],
  [
    "acceptance actor without role",
    false,
    (s) => {
      s.acceptance[0].check = { type: "scenario", actors: { a: {} } };
    },
  ],
  [
    "acceptance milestone M9",
    false,
    (s) => {
      s.acceptance[0].check.milestone = "M9";
    },
  ],
  [
    "acceptance steps item not object",
    false,
    (s) => {
      s.acceptance[0].check = { type: "scenario", steps: ["call"] };
    },
  ],
  [
    "workflow step extra key",
    false,
    (s) => {
      s.workflows[0].steps[0].retry = 3;
    },
  ],
  [
    "workflow trigger relative extra (loose)",
    true,
    (s) => {
      s.workflows[0].trigger.relative = { field: "until", offsetMinutes: -60, note: "x" };
    },
  ],
  ["spec is array", false, () => []],
  ["spec is null", false, () => null],
];

/** Deterministic PRNG (mulberry32) for fuzzed cases. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JUNK: unknown[] = [
  null,
  0,
  -1,
  1.5,
  1e21,
  "",
  "x",
  "Name",
  "😀",
  true,
  [],
  {},
  [1],
  { a: 1 },
  "#ffffff",
  "/a",
];

/** Replaces one random node of a deep copy of the forum spec with a junk value, or deletes it. */
export function fuzzCases(count: number, seed = 42): SchemaCase[] {
  const rand = rng(seed);
  const out: SchemaCase[] = [];
  for (let n = 0; n < count; n++) {
    const spec = baseSpec();
    const paths: (string | number)[][] = [];
    const walk = (v: unknown, p: (string | number)[]) => {
      paths.push(p);
      if (Array.isArray(v)) for (const [i, x] of v.entries()) walk(x, [...p, i]);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, [...p, k]);
    };
    walk(spec, []);
    const path = paths[1 + Math.floor(rand() * (paths.length - 1))] as (string | number)[];
    let parent: Json = spec;
    for (const seg of path.slice(0, -1)) parent = parent[seg];
    const last = path[path.length - 1] as string | number;
    const r = rand();
    if (r < 0.15 && !Array.isArray(parent)) delete parent[last];
    else if (r < 0.25 && !Array.isArray(parent)) parent[`x${n}`] = JUNK[Math.floor(rand() * JUNK.length)];
    else parent[last] = JUNK[Math.floor(rand() * JUNK.length)];
    out.push({ name: `fuzz#${n} ${path.join("/")}`, valid: false, spec });
  }
  return out;
}

export function schemaCases(): SchemaCase[] {
  return mutations.map(([name, valid, mutate]) => {
    const s = baseSpec();
    const r = mutate(s);
    return { name, valid, spec: r === undefined ? s : r };
  });
}
