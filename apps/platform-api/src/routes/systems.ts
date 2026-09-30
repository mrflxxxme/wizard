// /systems/* operations of specs/platform/api.yaml (x-milestone M0).
import { type AppSpec, applyOps } from "@wizard/appspec";
import { Hono } from "hono";
import type { Selectable } from "kysely";
import { z } from "zod";
import { json } from "../db/index.js";
import type { SystemsTable } from "../db/types.js";
import { ApiError, invalid, notFound } from "../errors.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid, type OrgRole } from "../http/auth.js";
import { type Deps, jsonBody, parseQuery } from "../http/util.js";
import { withTx } from "../runs/events.js";
import { latestGateReports } from "../runs/gates.js";
import { insertRun, TERMINAL_STATUSES } from "../runs/queue.js";
import { processLogo } from "../services/logo.js";
import { insertMessage } from "../services/messages.js";
import {
  applyOpsRevision,
  commitFilesRevision,
  isSafePath,
  loadManifest,
  loadRevision,
  loadSpec,
  lockSystem,
} from "../services/revisions.js";
import { toMessage, toRevisionSummary, toRun, toSystem } from "../services/serialize.js";
import { makeSlug, nameFromPrompt, randomKey } from "../services/slug.js";
import { assertTransition } from "../services/stage.js";

/** «Вопрос? — ответ» line of the user's answers message: no «?:» (FU-4). */
export function answerLine(question: string, answer: string): string {
  return `${question.trim().replace(/[\s:—-]+$/u, "")} — ${answer.trim()}`;
}

const limitQ = z.coerce.number().int().min(1).max(100).default(50);
const intQ = z.coerce.number().int();

interface Question {
  id: string;
  forkId: string;
  text?: string;
  allowCustom?: boolean;
  options: { id: string; label: string; recommended?: boolean }[];
}

export function systemRoutes(d: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const tx = <T>(fn: Parameters<typeof withTx<T>>[2]) => withTx(d.db, d.bus, fn);

  async function loadSystem(
    user: AuthUser,
    id: string | undefined,
    min: OrgRole,
  ): Promise<Selectable<SystemsTable>> {
    if (!isUuid(id)) throw notFound("Система");
    const s = await d.db
      .selectFrom("platform.systems")
      .selectAll()
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    checkOrgAccess(user, s.org_id, min, "Система");
    return s;
  }

  async function lockHeld(systemId: string): Promise<boolean> {
    const l = await d.db
      .selectFrom("platform.locks")
      .select("run_id")
      .where("system_id", "=", systemId)
      .where("lease_until", ">", new Date())
      .executeTakeFirst();
    if (l) return true;
    const active = await d.db
      .selectFrom("platform.runs")
      .select("id")
      .where("system_id", "=", systemId)
      .where("kind", "=", "build")
      .where("status", "not in", [...TERMINAL_STATUSES])
      .executeTakeFirst();
    return !!active;
  }

  // createSystem
  r.post("/systems", async (c) => {
    const b = await jsonBody(
      c,
      z.strictObject({
        prompt: z.string().min(3).max(8000),
        orgId: z.uuid().optional(),
        templateId: z.string().optional(),
      }),
    );
    const user = c.get("user");
    const orgId = b.orgId ?? user.defaultOrgId;
    if (!user.orgs.has(orgId)) throw new ApiError("FORBIDDEN", "Нет доступа к организации");
    checkOrgAccess(user, orgId, "editor", "Организация");
    const out = await tx(async (t) => {
      let slug = makeSlug(b.prompt);
      for (let i = 0; i < 5; i++) {
        const taken = await t.trx
          .selectFrom("platform.systems")
          .select("id")
          .where("slug", "=", slug)
          .executeTakeFirst();
        if (!taken) break;
        slug = makeSlug(b.prompt);
      }
      const system = await t.trx
        .insertInto("platform.systems")
        .values({
          org_id: orgId,
          slug,
          schema_key: randomKey(12),
          name: nameFromPrompt(b.prompt),
          pending_questions: json([]),
          created_by: user.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const run = await insertRun(t, {
        orgId,
        systemId: system.id,
        kind: "interview_turn",
        input: { trigger: "create", ...(b.templateId ? { templateId: b.templateId } : {}) },
        startedBy: user.id,
      });
      await insertMessage(t, {
        systemId: system.id,
        role: "user",
        kind: "text",
        text: b.prompt,
        runId: run.id,
        authorUserId: user.id,
      });
      return { system, run };
    });
    d.engine.enqueue(out.run);
    return c.json({ system: toSystem(out.system), run: toRun(out.run, 0) }, 201);
  });

  // listSystems
  r.get("/systems", async (c) => {
    const q = parseQuery(
      c,
      z.object({ orgId: z.uuid().optional(), limit: limitQ, cursor: z.string().max(200).optional() }),
    );
    const user = c.get("user");
    const orgId = q.orgId ?? user.defaultOrgId;
    if (!user.orgs.has(orgId)) throw new ApiError("FORBIDDEN", "Нет доступа к организации");
    let query = d.db
      .selectFrom("platform.systems")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null);
    if (q.cursor) {
      const [ts, id] = Buffer.from(q.cursor, "base64url").toString("utf8").split("|");
      const at = new Date(ts ?? "");
      if (!isUuid(id) || Number.isNaN(at.getTime())) throw invalid("Некорректный курсор");
      query = query.where((eb) =>
        eb.or([eb("created_at", "<", at), eb.and([eb("created_at", "=", at), eb("id", "<", id)])]),
      );
    }
    const rows = await query
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit);
    const lastRow = page[page.length - 1];
    const nextCursor =
      rows.length > q.limit && lastRow
        ? Buffer.from(`${new Date(lastRow.created_at).toISOString()}|${lastRow.id}`).toString("base64url")
        : null;
    return c.json({ items: page.map(toSystem), nextCursor });
  });

  // getSystem
  r.get("/systems/:id", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    const msgs = await d.db
      .selectFrom("platform.messages")
      .selectAll()
      .where("system_id", "=", s.id)
      .orderBy("seq", "desc")
      .limit(200)
      .execute();
    const active = await d.db
      .selectFrom("platform.runs")
      .select("id")
      .where("system_id", "=", s.id)
      .where("status", "not in", [...TERMINAL_STATUSES])
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    return c.json({
      system: toSystem(s),
      card: s.card ?? null,
      pendingQuestions: s.pending_questions,
      messages: msgs.reverse().map(toMessage),
      activeRunId: active?.id ?? null,
      publishBlockers: [],
    });
  });

  // postMessage
  r.post("/systems/:id/messages", async (c) => {
    const user = c.get("user");
    const s0 = await loadSystem(user, c.req.param("id"), "editor");
    const b = await jsonBody(c, z.strictObject({ text: z.string().min(1).max(8000) }));
    const out = await tx(async (t) => {
      const s = await lockSystem(t, s0.id);
      if (s.stage === "building") throw new ApiError("SYSTEM_LOCKED", "Идёт сборка — дождитесь её окончания");
      if (s.stage === "failed") {
        await t.trx
          .updateTable("platform.systems")
          .set({ stage: assertTransition(s.stage, "interview") })
          .where("id", "=", s.id)
          .execute();
      }
      await t.trx
        .updateTable("platform.systems")
        .set({ last_activity_at: new Date(), updated_at: new Date() })
        .where("id", "=", s.id)
        .execute();
      const run = await insertRun(t, {
        orgId: s.org_id,
        systemId: s.id,
        kind: "interview_turn",
        input: { trigger: "message" },
        startedBy: user.id,
      });
      const message = await insertMessage(t, {
        systemId: s.id,
        role: "user",
        kind: "text",
        text: b.text,
        runId: run.id,
        authorUserId: user.id,
      });
      return { run, message };
    });
    d.engine.enqueue(out.run);
    return c.json({ message: toMessage(out.message), run: toRun(out.run, 0) }, 202);
  });

  // listMessages
  r.get("/systems/:id/messages", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    const q = parseQuery(c, z.object({ limit: limitQ, beforeSeq: intQ.optional() }));
    let query = d.db.selectFrom("platform.messages").selectAll().where("system_id", "=", s.id);
    if (q.beforeSeq !== undefined) query = query.where("seq", "<", q.beforeSeq);
    const rows = await query.orderBy("seq", "desc").limit(q.limit).execute();
    return c.json({ items: rows.reverse().map(toMessage) });
  });

  // postAnswers
  r.post("/systems/:id/answers", async (c) => {
    const user = c.get("user");
    const s0 = await loadSystem(user, c.req.param("id"), "editor");
    const b = await jsonBody(
      c,
      z.strictObject({
        answers: z
          .array(
            z.strictObject({
              questionId: z.string(),
              optionId: z.string().optional(),
              text: z.string().max(500).optional(),
            }),
          )
          .optional(),
        restByRecommendation: z.boolean().default(false),
      }),
    );
    const out = await tx(async (t) => {
      const s = await lockSystem(t, s0.id);
      if (s.stage === "building") throw new ApiError("SYSTEM_LOCKED", "Идёт сборка — дождитесь её окончания");
      const pending = (s.pending_questions ?? []) as Question[];
      if (pending.length === 0) throw invalid("Нет вопросов, ожидающих ответа");
      const byId = new Map(pending.map((q) => [q.id, q]));
      const answers: Record<string, unknown>[] = [];
      const lines: string[] = [];
      const seen = new Set<string>();
      for (const a of b.answers ?? []) {
        const q = byId.get(a.questionId);
        if (!q) throw invalid(`Вопрос ${a.questionId} не найден`);
        if (seen.has(q.id)) throw invalid(`На вопрос ${q.id} дано несколько ответов`);
        if ((a.optionId === undefined) === (a.text === undefined))
          throw invalid("Нужен ровно один из вариантов: optionId или text");
        let label = a.text ?? "";
        if (a.optionId !== undefined) {
          const opt = q.options.find((o) => o.id === a.optionId);
          if (!opt) throw invalid(`Вариант ${a.optionId} не найден`);
          label = opt.label;
        } else if (q.allowCustom === false) throw invalid("На этот вопрос нельзя ответить своим текстом");
        seen.add(q.id);
        answers.push({ ...a, forkId: q.forkId, byRecommendation: false });
        lines.push(answerLine(q.text ?? q.id, label));
      }
      if (b.restByRecommendation) {
        for (const q of pending) {
          if (seen.has(q.id)) continue;
          const rec = q.options.find((o) => o.recommended) ?? q.options[0];
          if (!rec) continue;
          answers.push({ questionId: q.id, optionId: rec.id, forkId: q.forkId, byRecommendation: true });
          lines.push(answerLine(q.text ?? q.id, rec.label));
        }
      }
      if (answers.length === 0) throw invalid("Нет ни одного ответа");
      const run = await insertRun(t, {
        orgId: s.org_id,
        systemId: s.id,
        kind: "interview_turn",
        input: { trigger: "answers", answers },
        startedBy: user.id,
      });
      await insertMessage(t, {
        systemId: s.id,
        role: "user",
        kind: "answers",
        text: lines.join("\n"),
        payload: { answers },
        runId: run.id,
        authorUserId: user.id,
      });
      await t.trx
        .updateTable("platform.systems")
        .set({ last_activity_at: new Date(), updated_at: new Date() })
        .where("id", "=", s.id)
        .execute();
      return run;
    });
    d.engine.enqueue(out);
    return c.json({ run: toRun(out, 0) }, 202);
  });

  // approveCard
  r.post("/systems/:id/card/approve", async (c) => {
    const user = c.get("user");
    const s0 = await loadSystem(user, c.req.param("id"), "editor");
    const b = await jsonBody(
      c,
      z.strictObject({
        cardVersion: z.number().int().min(1),
        capCredits: z.number().int().min(1).optional(),
      }),
    );
    const run = await tx(async (t) => {
      const s = await lockSystem(t, s0.id);
      const card = s.card as Record<string, unknown> | null;
      if (!card || s.stage !== "card") throw new ApiError("NO_CARD", "Нет карточки, ожидающей согласования");
      if (b.cardVersion !== s.card_version)
        throw new ApiError("CARD_VERSION_STALE", "Карточка изменилась — посмотрите новую версию");
      const cardCap = Number((card.cap as { credits?: number }).credits);
      const expected = Number(
        ((card.estimate as { credits?: { expected?: number } } | undefined)?.credits?.expected ??
          0) as number,
      );
      let cap = cardCap;
      if (b.capCredits !== undefined) {
        if (b.capCredits > cardCap || b.capCredits < Math.ceil(expected))
          throw invalid(`Лимит можно только понизить, но не ниже ${Math.ceil(expected)} кр.`);
        cap = b.capCredits;
      }
      await t.trx
        .updateTable("platform.systems")
        .set({
          stage: assertTransition(s.stage, "building"),
          card_approved_version: s.card_version,
          updated_at: new Date(),
          last_activity_at: new Date(),
        })
        .where("id", "=", s.id)
        .execute();
      return insertRun(t, {
        orgId: s.org_id,
        systemId: s.id,
        kind: "build",
        mode: card.kind === "change" ? "change" : "create",
        input: { card },
        cardVersion: s.card_version,
        estimateMilli: Math.round(expected * 1000),
        capMilli: cap * 1000,
        startedBy: user.id,
      });
    });
    d.engine.enqueue(run);
    return c.json({ run: toRun(run, 0) }, 202);
  });

  // startFixBuild
  r.post("/systems/:id/fix", async (c) => {
    const user = c.get("user");
    const s0 = await loadSystem(user, c.req.param("id"), "editor");
    await jsonBody(c, z.strictObject({}));
    if (await lockHeld(s0.id)) throw new ApiError("SYSTEM_LOCKED", "Идёт сборка — дождитесь её окончания");
    const reports = await latestGateReports(d.db, s0.id);
    const lastBuild = await d.db
      .selectFrom("platform.runs")
      .select("status")
      .where("system_id", "=", s0.id)
      .where("kind", "=", "build")
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    const hasFailure = reports.some((g) => !g.passed) || lastBuild?.status === "failed";
    const run = await tx(async (t) => {
      const s = await lockSystem(t, s0.id);
      if (!hasFailure || (s.stage !== "ready" && s.stage !== "failed"))
        throw new ApiError("NO_GATE_FAILURE", "Последние проверки пройдены — исправлять нечего");
      const card = (s.card ?? {}) as Record<string, unknown>;
      const cardCap = Number((card.cap as { credits?: number } | undefined)?.credits ?? 0);
      const cap = Math.max(3, Math.ceil(0.25 * cardCap));
      await t.trx
        .updateTable("platform.systems")
        .set({
          stage: assertTransition(s.stage, "building"),
          updated_at: new Date(),
          last_activity_at: new Date(),
        })
        .where("id", "=", s.id)
        .execute();
      return insertRun(t, {
        orgId: s.org_id,
        systemId: s.id,
        kind: "build",
        mode: "fix",
        input: { card },
        cardVersion: s.card_approved_version,
        capMilli: cap * 1000,
        startedBy: user.id,
      });
    });
    d.engine.enqueue(run);
    return c.json({ run: toRun(run, 0) }, 202);
  });

  // listRevisions
  r.get("/systems/:id/revisions", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    const q = parseQuery(c, z.object({ limit: limitQ, beforeVersion: intQ.optional() }));
    let query = d.db
      .selectFrom("platform.revisions")
      .select([
        "system_id",
        "version",
        "parent_version",
        "kind",
        "author",
        "author_user_id",
        "run_id",
        "files_manifest_sha",
        "bundle_key",
        "g0_passed",
        "idempotency_key",
        "summary_ru",
        "created_at",
      ])
      .where("system_id", "=", s.id);
    if (q.beforeVersion !== undefined) query = query.where("version", "<", q.beforeVersion);
    const rows = await query.orderBy("version", "desc").limit(q.limit).execute();
    return c.json({ items: rows.map(toRevisionSummary) });
  });

  // getRevision
  r.get("/systems/:id/revisions/:v", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    const v = Number(c.req.param("v"));
    if (!Number.isInteger(v) || v < 1) throw invalid("Номер ревизии — целое число от 1");
    const rev = await loadRevision(d.db, s.id, v);
    if (!rev) throw notFound("Ревизия");
    const manifest = await loadManifest(d.db, d.blobs, s.id, v);
    const shas = [...new Set(Object.values(manifest))];
    const sizes = new Map<string, number>();
    if (shas.length > 0) {
      const rows = await d.db
        .selectFrom("platform.files")
        .select(["sha256", "size"])
        .where("sha256", "in", shas)
        .execute();
      for (const f of rows) sizes.set(f.sha256, Number(f.size));
    }
    return c.json({
      ...toRevisionSummary(rev),
      spec: rev.spec,
      ops: rev.ops,
      files: Object.entries(manifest)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, sha256]) => ({ path, sha256, size: sizes.get(sha256) ?? 0 })),
    });
  });

  // getFile
  r.get("/systems/:id/files/*", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    const rawPath = new URL(c.req.url).pathname;
    const marker = `/systems/${s.id}/files/`;
    const at = rawPath.indexOf(marker);
    let path: string;
    try {
      path = decodeURIComponent(rawPath.slice(at + marker.length));
    } catch {
      throw invalid("Некорректный путь файла");
    }
    if (at < 0 || !isSafePath(path)) throw invalid("Некорректный путь файла");
    const q = parseQuery(c, z.object({ rev: intQ.min(1).optional() }));
    const rev = q.rev ?? s.draft_revision;
    if (rev < 1 || rev > s.draft_revision) throw notFound("Файл");
    const sha = (await loadManifest(d.db, d.blobs, s.id, rev))[path];
    if (!sha) throw notFound("Файл");
    const data = await d.blobs.get(sha);
    let text = true;
    if (data.includes(0)) text = false;
    else {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        text = false;
      }
    }
    const headers: Record<string, string> = {
      "content-type": text ? "text/plain; charset=utf-8" : "application/octet-stream",
      etag: `"${sha}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    };
    if (!text) {
      const name = (path.split("/").pop() ?? "file").replace(/[^A-Za-z0-9._-]/g, "_");
      headers["content-disposition"] = `attachment; filename="${name}"`;
    }
    return c.body(new Uint8Array(data), 200, headers);
  });

  // setStyle
  r.post("/systems/:id/style", async (c) => {
    const user = c.get("user");
    const s0 = await loadSystem(user, c.req.param("id"), "editor");
    const b = await jsonBody(
      c,
      z.strictObject({ expectedVersion: z.number().int(), theme: z.record(z.string(), z.unknown()) }),
    );
    if (await lockHeld(s0.id))
      throw new ApiError("SYSTEM_LOCKED", "Идёт сборка — «Стиль» временно недоступен");
    const res = await tx(async (t) => {
      const s = await lockSystem(t, s0.id);
      if (b.expectedVersion !== s.draft_revision)
        throw new ApiError("VERSION_CONFLICT", "Система изменилась — обновите страницу", {
          currentVersion: s.draft_revision,
        });
      const r2 = await applyOpsRevision(t, d.blobs, {
        systemId: s.id,
        ops: [{ ...b.theme, op: "set_theme" }],
        expectedVersion: b.expectedVersion,
        kind: "style",
        author: "user",
        authorUserId: user.id,
      });
      if (!r2.ok) throw new ApiError("OPS_INVALID", "Оформление не применено", { errors: r2.errors });
      return loadRevision(t.trx, s.id, r2.version);
    });
    if (!res) throw new ApiError("INTERNAL", "Ревизия не сохранена");
    return c.json({ revision: toRevisionSummary(res) });
  });

  // uploadAsset
  r.post("/systems/:id/assets", async (c) => {
    const user = c.get("user");
    const s0 = await loadSystem(user, c.req.param("id"), "editor");
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > 2 * 1_048_576) throw new ApiError("PAYLOAD_TOO_LARGE", "Логотип больше 1 МБ");
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch {
      throw invalid("Ожидается multipart/form-data");
    }
    const file = form.file;
    const expected = Number(form.expectedVersion);
    if (!(file instanceof File)) throw invalid("Нет файла логотипа");
    if (!Number.isInteger(expected)) throw invalid("Нужен expectedVersion");
    if (form.purpose !== undefined && form.purpose !== "logo")
      throw invalid("purpose может быть только logo");
    if (file.size > 1_048_576) throw new ApiError("PAYLOAD_TOO_LARGE", "Логотип больше 1 МБ");
    const logo = processLogo(Buffer.from(await file.arrayBuffer()));
    if (await lockHeld(s0.id))
      throw new ApiError("SYSTEM_LOCKED", "Идёт сборка — «Стиль» временно недоступен");
    const path = `assets/logo.${logo.ext}`;
    const other = `assets/logo.${logo.ext === "png" ? "webp" : "png"}`;
    const out = await tx(async (t) => {
      const s = await lockSystem(t, s0.id);
      if (expected !== s.draft_revision)
        throw new ApiError("VERSION_CONFLICT", "Система изменилась — обновите страницу", {
          currentVersion: s.draft_revision,
        });
      const spec: AppSpec = await loadSpec(t.trx, s, s.draft_revision);
      const ops = [{ op: "set_theme", logoFile: path }];
      const applied = applyOps(spec, ops, s.draft_revision, {
        currentVersion: s.draft_revision,
        author: "user",
      });
      if (!applied.ok) throw new ApiError("OPS_INVALID", "Логотип не применён", { errors: applied.errors });
      const manifest = await loadManifest(t.trx, d.blobs, s.id, s.draft_revision);
      const committed = await commitFilesRevision(t, d.blobs, {
        systemId: s.id,
        kind: "style",
        author: "user",
        authorUserId: user.id,
        spec: applied.spec,
        ops,
        summaryRu: "Загружен логотип",
        changes: [{ path, content: logo.data }, ...(manifest[other] ? [{ path: other, content: null }] : [])],
      });
      const rev = await loadRevision(t.trx, s.id, committed.version);
      return { rev, sha: committed.written.find((w) => w.path === path)?.sha256 ?? manifest[path] };
    });
    if (!out.rev) throw new ApiError("INTERNAL", "Ревизия не сохранена");
    return c.json(
      { path, sha256: out.sha, width: logo.width, height: logo.height, revision: toRevisionSummary(out.rev) },
      201,
    );
  });

  // getPreviewUrl
  r.get("/systems/:id/preview-url", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    if (s.preview_revision === null)
      throw new ApiError("PREVIEW_NOT_READY", "Превью появится после первой успешной сборки");
    const spec = await loadSpec(d.db, s, s.preview_revision);
    const roles = spec.roles ?? [];
    const q = parseQuery(c, z.object({ role: z.string().max(64).optional() }));
    const role = q.role ?? (roles.find((x) => x.access === "public") ?? roles[0])?.name;
    if (!role || !roles.some((x) => x.name === role)) throw invalid("Такой роли нет в системе");
    // A public role has no login: runtime dev-login answers 404 for it, dev-logout drops the draft session instead.
    const isPublic = roles.find((x) => x.name === role)?.access === "public";
    const path = isPublic
      ? "/_wizard/dev-logout?next=/"
      : `/_wizard/dev-login?role=${encodeURIComponent(role)}&next=/`;
    const url = `http://${s.slug}--draft.localhost:${d.config.runtimePort}${path}`;
    return c.json({
      url,
      revision: s.preview_revision,
      roles: roles.map((x) => ({ name: x.name, label: x.label })),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
  });

  // getLatestGates
  r.get("/systems/:id/gates/latest", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    const rows = await latestGateReports(d.db, s.id);
    const top = rows.reduce<(typeof rows)[number] | undefined>(
      (m, x) => (!m || x.revision > m.revision ? x : m),
      undefined,
    );
    return c.json({
      revision: top?.revision ?? s.draft_revision,
      ...(top ? { runId: top.run_id } : {}),
      reports: rows.map((x) => x.report),
    });
  });

  return r;
}
