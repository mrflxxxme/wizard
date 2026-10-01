// S-invite «Принятие приглашения» (/invite/:token): not signed in → S-auth with a return here; «Принять» →
// POST /invites/:token/accept → the organization becomes current and S1 shows its systems with the invited role.
import { Button } from "@wizard/ui-kit";
import { type ReactNode, useState } from "react";
import { ApiError } from "../../api/client.js";
import { usePlatform } from "../../app/context.js";
import { navigate } from "../../app/router.js";
import { ru } from "../../i18n/ru.js";
import s from "./Auth.module.css";

export function InviteScreen({ token }: { token: string }): ReactNode {
  const { api, auth, me, reloadMe, setOrg } = usePlatform();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const here = `/invite/${token}`;

  async function accept() {
    setBusy(true);
    setError(null);
    const before = new Set((me?.memberships ?? []).map((m) => m.orgId));
    try {
      const member = await api.acceptInvite(token);
      const after = await reloadMe();
      const joined =
        after?.memberships.find((m) => !before.has(m.orgId)) ??
        after?.memberships.find((m) => m.role === member.role);
      if (joined) setOrg(joined.orgId);
      navigate("/", { replace: true });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 410 || e.code === "INVITE_EXPIRED"))
        setError(ru.invite.expired);
      else setError(e instanceof Error ? e.message : ru.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={s.page}>
      <section className={s.card} data-testid="invite-card" aria-labelledby="invite-title">
        <span className={s.logo} aria-hidden="true">
          W
        </span>
        <h1 id="invite-title" className={s.title}>
          {ru.invite.title}
        </h1>
        <p className={s.muted}>{ru.invite.text}</p>
        {auth === "anon" ? (
          <Button
            variant="primary"
            data-testid="invite-login"
            onClick={() => navigate(`/login?next=${encodeURIComponent(here)}`)}
          >
            {ru.invite.login}
          </Button>
        ) : (
          <div className={s.row}>
            <Button
              variant="primary"
              data-testid="invite-accept"
              loading={busy}
              disabled={auth === "loading"}
              onClick={() => void accept()}
            >
              {ru.invite.accept}
            </Button>
            {me && <span className={s.muted}>{me.user.email}</span>}
          </div>
        )}
        {error && (
          <p className={s.formError} role="alert" data-testid="invite-error">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
