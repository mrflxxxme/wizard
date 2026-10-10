// PC-* probes through the data API from synthetic users (gates.yaml#G1 G1-PERM, qa.yaml#checks.permission_auto).
import { type AppSpec, type Entity, type Permission, USERS_ENTITY } from "@wizard/appspec";
import { type Actor, errorCode, type G1Env, type HttpResult } from "./env.js";
import { fieldPiiCategory, inUniqueIndex, userAttr, type ValueGen } from "./seed.js";
import type { PermissionProbe, QaCheck, Seed, SeedUser } from "./types.js";

export interface ProbeOutcome {
  status: "pass" | "fail" | "error";
  message_ru: string;
  evidence?: string;
  fixHint?: string;
  path?: string;
}

export interface ProbeDeps {
  seed: Seed;
  gen: ValueGen;
  consent: { policyVersion: string; textHash: string } | null;
  /** Two sessions (A, B) per login role; one anonymous actor per public role. */
  actors: Map<string, Actor[]>;
}

const USER_REF_RE = /^\$user\.([a-z_]+)$/;
const OP_RU: Record<string, string> = {
  read: "читать",
  create: "создавать",
  update: "изменять",
  delete: "удалять",
};

function got(r: HttpResult): string {
  const c = errorCode(r);
  return `HTTP ${r.status}${c ? ` ${c}` : ""}`;
}

export class Prober {
  private readonly spec: AppSpec;
  constructor(
    private readonly env: G1Env,
    private readonly d: ProbeDeps,
  ) {
    this.spec = env.spec;
  }

  private perm(role: string, entity: string): Permission | undefined {
    return this.spec.permissions.find((p) => p.role === role && p.entity === entity);
  }

  private seedUser(actor: Actor): SeedUser | undefined {
    return this.d.seed.users.find((u) => u.id === actor.id);
  }

  /** Seed row of `target` the role can reference: its own row under a rowFilter, else the first one. */
  private visibleRow(role: string, actor: Actor, target: string): string | null {
    const rows = this.d.seed.rows[target] ?? [];
    const p = this.perm(role, target);
    if (!p?.ops.includes("read")) return null;
    const me = this.seedUser(actor);
    const hit = rows.find((r) =>
      Object.entries(p.rowFilter ?? {}).every(([f, want]) => {
        const m = typeof want === "string" ? USER_REF_RE.exec(want) : null;
        const v = m ? (me ? userAttr(me, m[1] as string) : null) : want;
        return v !== null && String(r[f]) === String(v);
      }),
    );
    return (hit?.id as string | undefined) ?? null;
  }

  /** Fresh row inserted by the system, owned (rowFilter fields) by `owner`; refs point to seed rows. */
  async freshRow(e: Entity, role: string, owner: Actor | null): Promise<string> {
    const row = await this.buildRow(e, role, owner);
    await this.env.insertRow(e.name, row);
    return row.id as string;
  }

  /** Values of a fresh row (not inserted); unique refs get their own inserted target rows. */
  async buildRow(e: Entity, role: string, owner: Actor | null): Promise<Record<string, unknown>> {
    const n = this.d.gen.next();
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const row: Record<string, unknown> = { id };
    for (const f of e.fields) {
      if (f.type === "ref") {
        const target = f.ref?.entity as string;
        if (target === USERS_ENTITY) row[f.name] = owner?.id ?? this.d.seed.users[0]?.id ?? null;
        else if (target === e.name) continue;
        else if (f.unique) {
          // A unique ref (one checkin per ticket) needs a target row nobody points to yet.
          const te = this.spec.entities.find((x) => x.name === target);
          row[f.name] = te ? await this.freshRow(te, role, owner) : null;
        } else row[f.name] = (this.d.seed.rows[target]?.[0]?.id as string | undefined) ?? null;
        continue;
      }
      const v = this.d.gen.value(e, f, n);
      if (v !== undefined) row[f.name] = v;
    }
    const me = owner ? this.seedUser(owner) : undefined;
    for (const [f, want] of Object.entries(this.perm(role, e.name)?.rowFilter ?? {})) {
      const m = typeof want === "string" ? USER_REF_RE.exec(want) : null;
      row[f] = m ? (me ? userAttr(me, m[1] as string) : null) : want;
    }
    return row;
  }

  /** Minimal valid create body for the role, or the reason it cannot be built. */
  async createBody(
    e: Entity,
    role: string,
    actor: Actor,
  ): Promise<{ body: Record<string, unknown>; problem?: string }> {
    const p = this.perm(role, e.name);
    const skip = new Set([
      ...(p?.readonlyFields ?? []),
      ...(p?.hiddenFields ?? []),
      ...Object.keys(p?.rowFilter ?? {}),
    ]);
    const body: Record<string, unknown> = {};
    let problem: string | undefined;
    for (const f of e.fields) {
      if (f.type === "qr_token") continue;
      const needed = f.required === true && f.default === undefined;
      if (skip.has(f.name)) {
        if (needed && !Object.hasOwn(p?.rowFilter ?? {}, f.name))
          problem ??= `обязательное поле «${f.label}» недоступно роли для записи`;
        continue;
      }
      if (!needed) continue;
      if (f.type === "ref") {
        const target = f.ref?.entity as string;
        const te = this.spec.entities.find((x) => x.name === target);
        // A unique ref — or one of a unique index (one open issue per item) — needs a target nobody points to yet: a
        // fresh row the role can see. Created rows stay, so the first seed row would answer 409 to the second role's
        // create probe when the other fields of the index are defaults the role cannot set (V3-15).
        const ref =
          target === USERS_ENTITY
            ? actor.id
            : (f.unique || inUniqueIndex(e, f.name)) && te && this.perm(role, target)?.ops.includes("read")
              ? await this.freshRow(te, role, actor)
              : this.visibleRow(role, actor, target);
        if (!ref) problem ??= `роль не видит связанную запись для поля «${f.label}»`;
        else body[f.name] = ref;
        continue;
      }
      if (f.type === "file" || f.type === "image") {
        // A file or image value is an upload of the writer (runtime.yaml#files): seeds' placeholder keys are refused.
        const fileId = await this.env.upload(actor, e.name, f.name);
        if (fileId) body[f.name] = fileId;
        else problem ??= `роль не может загрузить файл в поле «${f.label}»`;
        continue;
      }
      const allowed = p?.allowedValues?.[f.name];
      const v = allowed?.length ? allowed[0] : this.d.gen.value(e, f, 0);
      if (v === undefined) problem ??= `для поля «${f.label}» нельзя сгенерировать синтетическое значение`;
      else body[f.name] = v;
    }
    return problem ? { body, problem } : { body };
  }

  /** One writable non-PII field changed to a valid value (empty patch when there is none). */
  private patchBody(e: Entity, role: string): Record<string, unknown> {
    const p = this.perm(role, e.name);
    const skip = new Set([
      ...(p?.readonlyFields ?? []),
      ...(p?.hiddenFields ?? []),
      ...Object.keys(p?.rowFilter ?? {}),
    ]);
    const f = e.fields.find(
      (x) =>
        !skip.has(x.name) &&
        !x.unique &&
        !inUniqueIndex(e, x.name) &&
        !["ref", "qr_token", "file", "image"].includes(x.type) &&
        fieldPiiCategory(x) === "none",
    );
    if (!f) return {};
    // V3-18: a role limited to some values of an enum (a visitor may only cancel a booking) writes one of those.
    const allowed = p?.allowedValues?.[f.name];
    if (allowed?.length) return { [f.name]: allowed[0] };
    const v = this.d.gen.value(e, f, 1);
    return v === undefined ? {} : { [f.name]: v };
  }

  async run(check: QaCheck): Promise<ProbeOutcome> {
    const role = this.spec.roles.find((r) => r.name === check.role);
    const e = this.spec.entities.find((x) => x.name === check.entity);
    const probe = check.probe as PermissionProbe | undefined;
    if (!role || !e || !probe) {
      return {
        status: "error",
        message_ru: `Проверка ${check.id} ссылается на неизвестную роль или сущность`,
      };
    }
    const [a, b] = this.d.actors.get(role.name) ?? [];
    if (!a) return { status: "error", message_ru: `Нет синтетического пользователя роли «${role.label}»` };
    const who = `Роль «${role.label}»`;
    const what = `«${e.label}»`;
    const path = `/permissions/${Math.max(
      0,
      this.spec.permissions.findIndex((p) => p.role === role.name && p.entity === e.name),
    )}`;
    const base = `/api/data/${encodeURIComponent(e.name)}`;
    const ops: readonly string[] = this.perm(role.name, e.name)?.ops ?? [];

    switch (probe.kind) {
      case "op": {
        let res: HttpResult;
        let problem: string | undefined;
        if (probe.op === "read") res = await this.env.request(a, "GET", `${base}?limit=1`);
        else if (probe.op === "create") {
          const cb = await this.createBody(e, role.name, a);
          problem = cb.problem;
          res = await this.env.request(
            a,
            "POST",
            base,
            this.d.consent ? { ...cb.body, _consent: this.d.consent } : cb.body,
          );
        } else {
          const id = await this.freshRow(e, role.name, a);
          res =
            probe.op === "update"
              ? await this.env.request(a, "PATCH", `${base}/${id}`, {
                  ...this.patchBody(e, role.name),
                  ...(this.d.consent ? { _consent: this.d.consent } : {}),
                })
              : await this.env.request(a, "DELETE", `${base}/${id}`);
        }
        const allowed =
          probe.op === "create"
            ? res.status === 201
            : probe.op === "delete"
              ? res.status === 204
              : res.status === 200;
        const denied = res.status === 401 || res.status === 403;
        if (probe.expect === "allow" && allowed)
          return { status: "pass", message_ru: `${who} может ${OP_RU[probe.op]} ${what}` };
        if (probe.expect === "deny" && denied)
          return { status: "pass", message_ru: `${who} не может ${OP_RU[probe.op]} ${what}` };
        if (probe.expect === "deny") {
          return {
            status: "fail",
            message_ru: `${who} не должна ${OP_RU[probe.op]} ${what}, но система это разрешает`,
            evidence: `${probe.op}: ожидался отказ 401/403, получено ${got(res)}`,
            fixHint: `Уберите ${probe.op} из прав роли ${role.name} на ${e.name} или ограничьте rowFilter`,
            path,
          };
        }
        return {
          status: "fail",
          message_ru: `${who} должна ${OP_RU[probe.op]} ${what}, но получает отказ`,
          evidence: `${probe.op}: ожидался успех, получено ${got(res)}${problem ? `; ${problem}` : ""}`,
          fixHint: problem
            ? "Проверьте обязательные поля, скрытые и только для чтения поля и доступ к связанным записям"
            : `Проверьте права роли ${role.name} на ${e.name}`,
          path,
        };
      }
      case "row": {
        if (!b) return { status: "error", message_ru: `Нужны два пользователя роли «${role.label}»` };
        const foreign = await this.freshRow(e, role.name, b);
        const leaks: string[] = [];
        if (ops.includes("read")) {
          const one = await this.env.request(a, "GET", `${base}/${foreign}`);
          if (one.status !== 404) leaks.push(`чтение по id: ${got(one)}`);
          const list = await this.env.request(a, "GET", `${base}?limit=100`);
          const items = (list.body as { items?: { id?: string }[] } | null)?.items ?? [];
          if (items.some((x) => x.id === foreign)) leaks.push("запись в списке");
        }
        if (ops.includes("update")) {
          const up = await this.env.request(a, "PATCH", `${base}/${foreign}`, {
            ...this.patchBody(e, role.name),
            ...(this.d.consent ? { _consent: this.d.consent } : {}),
          });
          if (up.status !== 404) leaks.push(`изменение: ${got(up)}`);
        }
        if (ops.includes("delete")) {
          const del = await this.env.request(a, "DELETE", `${base}/${foreign}`);
          if (del.status !== 404) leaks.push(`удаление: ${got(del)}`);
        }
        if (leaks.length === 0) return { status: "pass", message_ru: `${who} не видит чужие записи ${what}` };
        return {
          status: "fail",
          message_ru: `${who} получает доступ к чужим записям ${what}`,
          evidence: `пользователь A, запись пользователя B: ${leaks.join("; ")}`,
          fixHint: `Добавьте rowFilter в право роли ${role.name} на ${e.name}`,
          path,
        };
      }
      case "hidden": {
        const id = await this.freshRow(e, role.name, a);
        const one = await this.env.request(a, "GET", `${base}/${id}`);
        const list = await this.env.request(a, "GET", `${base}?limit=100`);
        if (one.status !== 200 || list.status !== 200)
          return {
            status: "fail",
            message_ru: `${who} не может прочитать ${what}`,
            evidence: `чтение: ${got(one)}`,
            path,
          };
        const docs = [
          (one.body as { item?: object }).item ?? {},
          ...((list.body as { items?: object[] }).items ?? []),
        ];
        const shown = probe.fields.filter((f) => docs.some((d) => Object.hasOwn(d, f)));
        if (shown.length === 0) return { status: "pass", message_ru: `${who} не видит скрытые поля ${what}` };
        return {
          status: "fail",
          message_ru: `${who} видит скрытые поля ${what}`,
          evidence: `в ответе есть поля: ${shown.join(", ")}`,
          fixHint: "Проверьте hiddenFields права",
          path,
        };
      }
      case "ro": {
        const bad: string[] = [];
        const field = (name: string) => e.fields.find((f) => f.name === name);
        for (const name of probe.fields) {
          const f = field(name);
          const value =
            f?.type === "ref"
              ? (this.d.seed.rows[f.ref?.entity as string]?.[0]?.id ?? a.id)
              : ((f ? this.d.gen.value(e, f, 2) : undefined) ?? "g1-readonly-probe");
          let res: HttpResult;
          if (ops.includes("update")) {
            const id = await this.freshRow(e, role.name, a);
            res = await this.env.request(a, "PATCH", `${base}/${id}`, {
              [name]: value,
              ...(this.d.consent ? { _consent: this.d.consent } : {}),
            });
          } else {
            const cb = await this.createBody(e, role.name, a);
            res = await this.env.request(a, "POST", base, {
              ...cb.body,
              [name]: value,
              ...(this.d.consent ? { _consent: this.d.consent } : {}),
            });
          }
          if (!(res.status === 422 && errorCode(res) === "FIELD_READONLY")) bad.push(`${name}: ${got(res)}`);
        }
        if (bad.length === 0)
          return { status: "pass", message_ru: `${who} не может менять защищённые поля ${what}` };
        return {
          status: "fail",
          message_ru: `${who} может менять поля ${what}, закрытые для записи`,
          evidence: bad.join("; "),
          fixHint: "Проверьте readonlyFields права",
          path,
        };
      }
      case "consent": {
        const cb = await this.createBody(e, role.name, a);
        const res = await this.env.request(a, "POST", base, cb.body);
        if (res.status === 422 && errorCode(res) === "CONSENT_REQUIRED")
          return {
            status: "pass",
            message_ru: `${who} не может создать ${what} без согласия на обработку ПДн`,
          };
        return {
          status: "fail",
          message_ru: `${who} создаёт ${what} с персональными данными без согласия`,
          evidence: `create без _consent: ожидалось 422 CONSENT_REQUIRED, получено ${got(res)}`,
          fixHint: "Согласие проверяет runtime; проверьте разметку pii полей и права",
          path,
        };
      }
    }
  }
}
