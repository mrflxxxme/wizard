// The role pipeline (V5-03, D80 (6), grill-10 Р7): strategist → copywriter → editor → director → one signature section
// (two candidates of different model families and a judge) → critic on the 390/1440 screenshots, ≤ 2 rounds on slots.
// Every artifact is saved as a record (`save`) and reused when a repeat run has it. A role that fails stops the chain
// (the caller keeps the old path); the signature section and the critic degrade with a note.
import type { Registry } from "@wizard/llm";
import { callTool } from "../../core/loop.js";
import { SLOT_CRITIC_ROUNDS, setSlot, slotCritiqueMessages, slotCritiqueTool } from "../v3/critic/slots.js";
import type { CriticShot } from "../v3/critic/types.js";
import { homeSource, recordPath, V5_SIGNATURE_FILE } from "./page.js";
import type { RolesInput } from "./prompts.js";
import {
  avoiding,
  copywriter,
  director,
  editor,
  familyOf,
  judge,
  pageIssues,
  type RoleBase,
  resolveAfter,
  signatureCandidate,
  strategist,
  tracking,
} from "./roles.js";
import {
  type BlocksPage,
  blocksSchema,
  type Copy,
  copySchema,
  type Positioning,
  positioningSchema,
  type RoleArtifact,
  type RolesReport,
  type SignatureCandidate,
  signatureRecordSchema,
} from "./types.js";

/** What the critic's browser renders: the generated files of the page (the caller adds them to the system). */
export interface RolesRender {
  files: Readonly<Record<string, string>>;
}

export interface RolesDeps {
  base: RoleBase;
  registry: Registry;
  input: RolesInput;
  /** Snapshots 390/1440 of the page (the host's browser); absent or null — the critic round is skipped. */
  render?: (r: RolesRender) => Promise<readonly CriticShot[] | null>;
  /** Saves an artifact as a record. */
  save?: (name: RoleArtifact, value: unknown) => Promise<void>;
  /** Records of an earlier run; a valid one skips its role. */
  saved?: Partial<Record<RoleArtifact, unknown>>;
  maxCriticRounds?: number;
}

export interface RolesResult {
  positioning: Positioning;
  copy: Copy;
  edited: Copy;
  page: BlocksPage;
  signature: (SignatureCandidate & { winner: "A" | "B" | "only" }) | null;
  /** Files of the page: records, home page, signature section. */
  files: Record<string, string>;
  report: RolesReport;
}

/** The chain stopped at a role that gave nothing usable. */
export class RolesFailure extends Error {
  constructor(
    readonly role: string,
    message: string,
  ) {
    super(message);
    this.name = "RolesFailure";
  }
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

export function pageFiles(
  page: BlocksPage,
  sig: { source: string; after: string } | null,
  home: string,
): Record<string, string> {
  return {
    [recordPath("blocks")]: json(page),
    [home]: homeSource(page, sig?.after ?? null, home),
    ...(sig ? { [V5_SIGNATURE_FILE]: sig.source } : {}),
  };
}

export async function runRoles(deps: RolesDeps & { homeFile: string }): Promise<RolesResult> {
  const { registry, input } = deps;
  const notes: string[] = [];
  const artifacts: string[] = [];
  const models: Record<string, string> = {};
  const track = (role: string) => {
    const t = tracking(deps.base.route);
    return {
      base: { ...deps.base, route: t.route },
      done: () => (models[role] = t.model() ?? models[role] ?? ""),
    };
  };
  const keep = async (name: RoleArtifact, value: unknown) => {
    artifacts.push(name);
    await deps.save?.(name, value);
  };
  const reuse = <T>(
    name: RoleArtifact,
    schema: { safeParse(v: unknown): { success: boolean; data?: T } },
  ) => {
    const r = deps.saved?.[name] === undefined ? null : schema.safeParse(deps.saved[name]);
    return r?.success ? (r.data as T) : null;
  };

  // 1. Strategist.
  let positioning = reuse<Positioning>("positioning", positioningSchema);
  if (!positioning) {
    const t = track("strategist");
    positioning = await strategist(t.base, input);
    t.done();
    if (!positioning) throw new RolesFailure("strategist", "Стратег не дал позиционирования.");
  }
  await keep("positioning", positioning);

  // 2. Copywriter.
  let copy = reuse<Copy>("copy", copySchema);
  let copyModel: string | null = null;
  if (!copy) {
    const t = track("copywriter");
    copy = await copywriter(t.base, input, positioning);
    copyModel = t.done() ?? null;
    if (!copy) throw new RolesFailure("copywriter", "Копирайтер не дал текстов.");
  }
  await keep("copy", copy);

  // 3. Editor (a family other than the copywriter's).
  let edited = reuse<Copy>("copy-edited", copySchema);
  if (!edited) {
    const t = track("editor");
    const e = await editor(
      { ...t.base, route: avoiding(t.base.route, [familyOf(registry, models.copywriter ?? copyModel)]) },
      positioning,
      copy,
    );
    t.done();
    if (!e) throw new RolesFailure("editor", "Редактор не вернул исправленных текстов.");
    edited = e.copy;
    notes.push(...e.changes.slice(0, 5).map((c) => `Редактор: ${c}`));
  }
  await keep("copy-edited", edited);

  // 4. Director.
  let page = reuse<BlocksPage>("blocks", blocksSchema);
  if (!page) {
    const t = track("director");
    page = await director(t.base, input, positioning, edited);
    t.done();
    if (!page) throw new RolesFailure("director", "Режиссёр не собрал страницу из блоков каталога.");
  }
  await keep("blocks", page);

  // 5. Signature section: two candidates of different families, then the judge of a third.
  let signature: RolesResult["signature"] = null;
  const savedSig = reuse<SignatureCandidate & { winner: "A" | "B" | "only" }>(
    "signature",
    signatureRecordSchema,
  );
  if (savedSig) signature = savedSig;
  else {
    const ta = track("signature_a");
    const a = await signatureCandidate(ta.base, { stepName: "roles:signature:a" }, positioning, page).catch(
      () => null,
    );
    ta.done();
    const famA = familyOf(registry, models.signature_a ?? null);
    const tb = track("signature_b");
    const b = await signatureCandidate(
      { ...tb.base, route: avoiding(tb.base.route, [famA]) },
      { stepName: "roles:signature:b" },
      positioning,
      page,
    ).catch(() => null);
    tb.done();
    const famB = familyOf(registry, models.signature_b ?? null);
    if (a && b) {
      const tj = track("judge");
      const pick = await judge(
        { ...tj.base, route: avoiding(tj.base.route, [famA, famB]) },
        positioning,
        a,
        b,
      ).catch(() => null);
      tj.done();
      const win = pick ?? "A";
      if (!pick) notes.push("Судья секции не ответил — взят первый кандидат.");
      const won = win === "B" ? b : a;
      signature = { ...won, after: resolveAfter(page, won.after), winner: win };
      notes.push(`Фирменная секция: выбран вариант ${win} — «${signature.title}».`);
    } else if (a || b) {
      const only = (a ?? b) as SignatureCandidate;
      signature = { ...only, after: resolveAfter(page, only.after), winner: "only" };
      notes.push("Фирменная секция: второй кандидат не получился — остался единственный.");
    } else notes.push("Фирменная секция не получилась — страница из блоков без неё.");
  }
  if (signature) await keep("signature", signature);

  // 6. Critic on the screenshots, ≤ 2 rounds on slots.
  let rounds = 0;
  const maxRounds = Math.min(deps.maxCriticRounds ?? SLOT_CRITIC_ROUNDS, SLOT_CRITIC_ROUNDS);
  const history: string[] = [];
  if (!deps.render) notes.push("Критик по снимкам пропущен: нет браузера для снимков.");
  else
    for (let n = 1; n <= maxRounds; n++) {
      const shots = await deps.render({ files: pageFiles(page, signature, deps.homeFile) }).catch(() => null);
      if (!shots?.length) {
        notes.push("Критик по снимкам: снимки не получились.");
        break;
      }
      const tc = track("critic");
      const tool = slotCritiqueTool();
      const r = await callTool({
        ...tc.base,
        route: avoiding(tc.base.route, [familyOf(registry, models.director ?? null)]),
        callType: "critic_visual",
        stepName: `roles:critic:${n}`,
        messages: slotCritiqueMessages({
          name: input.name,
          tone: positioning.tone,
          blocks: page.blocks,
          shots,
          history,
        }),
        tool,
        maxRepairs: 1,
      }).catch(() => null);
      tc.done();
      if (!r?.ok) {
        notes.push("Критик по снимкам не ответил по форме.");
        break;
      }
      if (!r.value.edits.length) {
        notes.push(`Критик (раунд ${n}): правок нет — ${r.value.verdict}`);
        break;
      }
      const next: BlocksPage = structuredClone(page);
      const applied: string[] = [];
      for (const e of r.value.edits) {
        const b = next.blocks[e.block];
        if (!b) continue;
        if (e.path === "variant" && typeof e.value === "string") {
          b.variant = e.value;
          applied.push(`${b.id}.variant`);
        } else if (setSlot(b.content, e.path, e.value)) applied.push(`${b.id}.${e.path}`);
      }
      // A round that breaks the catalog or the bans is dropped whole: the page before it stays.
      const bad = pageIssues(next, input.photos, positioning);
      if (!applied.length || bad.length) {
        history.push(`Раунд ${n}: правки отклонены — ${bad[0]?.message ?? "ни один слот не найден"}`);
        notes.push(`Критик (раунд ${n}): правки отклонены кодом.`);
        continue;
      }
      page = next;
      rounds += 1;
      history.push(`Раунд ${n}: применено — ${applied.join(", ")}.`);
      notes.push(`Критик (раунд ${n}): ${applied.length} правок слотов — ${r.value.verdict}`);
      await keep("blocks", page);
    }

  const files = pageFiles(page, signature, deps.homeFile);
  for (const name of ["positioning", "copy", "copy-edited", "signature"] as const) {
    const v = { positioning, copy, "copy-edited": edited, signature }[name];
    if (v) files[recordPath(name)] = json(v);
  }
  return {
    positioning,
    copy,
    edited,
    page,
    signature,
    files,
    report: {
      costRub: 0,
      criticRounds: rounds,
      models: { ...models },
      artifacts: [...new Set(artifacts)],
      notes,
    },
  };
}
