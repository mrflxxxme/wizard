// /admin «Пилот» → «Режим показа» (B2-02, D76 (12)): the staff user's own organizations with a switch each
// (PUT /admin/orgs/:id/flags {demoReplay}); a client or eval org is refused by the API (403) and its text is shown.
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError } from "../../api/client.js";
import { usePlatform } from "../../app/context.js";
import { Alert } from "../../components/ui.js";
import { demo } from "../../i18n/ru/demo.js";
import { ru } from "../../i18n/ru.js";
import st from "../../screens/settings/Settings.module.css";

interface Row {
  orgId: string;
  orgName: string;
  on: boolean;
}

export function AdminDemoReplay({ onMfaRequired }: { onMfaRequired(): void }): ReactNode {
  const { api, me } = usePlatform();
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const memberships = me?.memberships;

  const load = useCallback(async () => {
    if (!memberships || typeof api.getOrg !== "function") return;
    const out = await Promise.all(
      memberships.map(async (m) => {
        const o = await api.getOrg(m.orgId).catch(() => null);
        return { orgId: m.orgId, orgName: m.orgName, on: o?.demoReplay === true };
      }),
    );
    setRows(out);
  }, [api, memberships]);
  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(r: Row, on: boolean) {
    setBusy(r.orgId);
    setError(null);
    try {
      await api.adminSetOrgDemoReplay(r.orgId, on);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === "MFA_REQUIRED") onMfaRequired();
      else setError(e instanceof Error ? e.message : ru.errors.generic);
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) return null;
  return (
    <section className={st.block} data-testid="admin-demo-replay">
      <h2 className={st.blockTitle}>{demo.adminTitle}</h2>
      <p className={st.small}>{demo.adminLead}</p>
      {error && <Alert testId="admin-demo-replay-error">{error}</Alert>}
      {rows.map((r) => (
        <label key={r.orgId} className={st.small}>
          <input
            type="checkbox"
            checked={r.on}
            disabled={busy !== null}
            onChange={(e) => void toggle(r, e.target.checked)}
            data-testid={`admin-demo-replay-${r.orgId}`}
          />{" "}
          {demo.adminToggle(r.orgName)} — {r.on ? demo.adminOn : demo.adminOff}
        </label>
      ))}
    </section>
  );
}
