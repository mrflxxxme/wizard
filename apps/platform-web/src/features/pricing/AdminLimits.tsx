// /admin «Пилот» → organizations (D70, M2-34 mvp_scope): the pilot limit of an org — builds and edits used in 30 days
// out of the limit — and the founder's raise (PUT /admin/pilot/orgs/:orgId/limits; empty field — the default).
import { Button } from "@wizard/ui-kit";
import { type ReactNode, useState } from "react";
import type { PilotUsage } from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import { ru } from "../../i18n/ru.js";
import f from "../../screens/abuse/Abuse.module.css";
import st from "../../screens/settings/Settings.module.css";

const limitsRu = {
  builds: "Сборки",
  edits: "Правки",
  used: (used: number, limit: number | null) => `${used} из ${limit ?? "—"}`,
  save: "Сохранить лимит",
  saved: "Лимит сохранён",
  invalid: "Лимит — целое число от 0 до 1000 или пусто (по умолчанию)",
};

const parse = (v: string): number | null | undefined => {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : null;
};

export function AdminLimits({
  orgId,
  usage,
  onChanged,
}: {
  orgId: string;
  usage: PilotUsage | undefined;
  onChanged(): Promise<void>;
}): ReactNode {
  const { api } = usePlatform();
  const [builds, setBuilds] = useState("");
  const [edits, setEdits] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function save() {
    const b = parse(builds);
    const e = parse(edits);
    if (b === null || e === null) return setNote(limitsRu.invalid);
    setBusy(true);
    setNote(null);
    try {
      await api.adminSetPilotLimits(orgId, {
        ...(b !== undefined ? { builds: b } : {}),
        ...(e !== undefined ? { edits: e } : {}),
      });
      setBuilds("");
      setEdits("");
      setNote(limitsRu.saved);
      await onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : ru.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="admin-pilot-limits">
      {usage && (
        <p className={st.small} data-testid="admin-pilot-limits-usage">
          {limitsRu.builds}: {limitsRu.used(usage.builds.used, usage.builds.limit)} · {limitsRu.edits}:{" "}
          {limitsRu.used(usage.edits.used, usage.edits.limit)}
        </p>
      )}
      <div className={st.inviteForm}>
        <input
          className={f.control}
          inputMode="numeric"
          placeholder={limitsRu.builds}
          aria-label={limitsRu.builds}
          value={builds}
          onChange={(e) => setBuilds(e.target.value.replace(/[^\d]/g, ""))}
          data-testid="admin-pilot-limit-builds"
        />
        <input
          className={f.control}
          inputMode="numeric"
          placeholder={limitsRu.edits}
          aria-label={limitsRu.edits}
          value={edits}
          onChange={(e) => setEdits(e.target.value.replace(/[^\d]/g, ""))}
          data-testid="admin-pilot-limit-edits"
        />
        <Button
          variant="secondary"
          size="sm"
          loading={busy}
          disabled={builds === "" && edits === ""}
          onClick={() => void save()}
          data-testid="admin-pilot-limit-save"
        >
          {limitsRu.save}
        </Button>
      </div>
      {note && (
        <p className={st.small} role="status" data-testid="admin-pilot-limits-note">
          {note}
        </p>
      )}
    </div>
  );
}
