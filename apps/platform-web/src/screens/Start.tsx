// S1 «Старт» (platform-screens.yaml#screens S1): M1 — current organization, «только РФ» (owner → PATCH settings),
// the team size on system cards, sign out. M2-09: `/?template=<id>` preselects a template (from S-welcome); pilot
// orgs get a link back to the pilot onboarding.
import { Button } from "@wizard/ui-kit";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { ApiError, newIdempotencyKey } from "../api/client.js";
import type { System } from "../api/types.js";
import { canEdit, canOwn, usePlatform } from "../app/context.js";
import { navigate, useRoute } from "../app/router.js";
import { Alert, Pill } from "../components/ui.js";
import { ru } from "../i18n/ru.js";
import s from "./Start.module.css";

export function Start(): ReactNode {
  const { api, settings, setSettings, auth, me, orgId, roleIn, setOrg } = usePlatform();
  const role = roleIn(orgId);
  const [team, setTeam] = useState<number | null>(null);
  const [ruBusy, setRuBusy] = useState(false);
  const { search } = useRoute();
  const preset = ru.templates.find((t) => t.id === search.get("template"));
  const [prompt, setPrompt] = useState(preset?.prompt ?? "");
  const [templateId, setTemplateId] = useState<string | undefined>(preset?.id);
  const [pilot, setPilot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [systems, setSystems] = useState<System[]>([]);
  const keyRef = useRef<string | null>(null);
  const [money, setMoney] = useState<{ plan: string; available: number; until: string | null } | null>(null);

  const signedIn = auth === "ready";
  // orgId only when it matters (api.yaml createSystem: required for members of several organizations); the server
  // defaults to the user's organization otherwise — and the seeded M0 id is not an RFC 4122 uuid for z.uuid().
  const orgParam = signedIn && (me?.memberships.length ?? 0) > 1 ? orgId : undefined;
  useEffect(() => {
    let live = true;
    api
      .listSystems(orgParam)
      .then((r) => live && setSystems(r.items))
      .catch(() => live && setSystems([]));
    if (signedIn)
      api
        .listMembers(orgId)
        .then((r) => live && setTeam(r.items.length))
        .catch(() => live && setTeam(null));
    if (signedIn && typeof api.getCredits === "function")
      Promise.all([api.getCredits(orgId), api.getOrg(orgId)])
        .then(([c, o]) => {
          if (!live) return;
          setPilot(o.plan === "pilot");
          // The nearest expiry of a non-empty bucket (billing.yaml#ledger: credits burn bucket by bucket).
          const until = (c.buckets ?? [])
            .filter((x) => x.remaining > 0 && x.expiresAt)
            .map((x) => x.expiresAt as string)
            .sort()[0];
          setMoney({
            plan: ru.billing.planName[o.plan] ?? o.plan,
            available: c.available,
            until: until
              ? new Date(until).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })
              : null,
          });
        })
        .catch(() => live && setMoney(null));
    return () => {
      live = false;
    };
  }, [api, orgId, orgParam, signedIn]);

  /** Optimistic switch (owner): the box follows the click, a refusal puts the previous settings back. */
  async function toggleRuOnly(ruOnly: boolean) {
    if (!settings) return;
    const prev = settings;
    setSettings({ ...prev, ruOnly });
    setRuBusy(true);
    setError(null);
    try {
      setSettings(await api.updateOrgSettings(orgId, { ruOnly }));
    } catch (e) {
      setSettings(prev);
      setError(e instanceof ApiError ? e : new ApiError(0, null));
    } finally {
      setRuBusy(false);
    }
  }

  async function logout() {
    await api.logout().catch(() => {});
    window.location.assign("/login");
  }

  const empty = prompt.trim().length < 3;

  async function submit() {
    if (empty || busy) return;
    setBusy(true);
    setError(null);
    keyRef.current ??= newIdempotencyKey();
    try {
      const r = await api.createSystem(
        {
          prompt: prompt.trim(),
          ...(templateId && templateId !== "custom" ? { templateId } : {}),
          ...(orgParam ? { orgId: orgParam } : {}),
        },
        keyRef.current,
      );
      keyRef.current = null;
      navigate(`/s/${r.system.id}`);
    } catch (e) {
      keyRef.current = null;
      setError(e instanceof ApiError ? e : new ApiError(0, null));
      setBusy(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className={s.page}>
      <header className={s.topbar}>
        <a
          className={s.logo}
          href="/"
          aria-label={ru.rail.home}
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          W
        </a>
        <span className={s.policy} data-testid="start-policy">
          {ru.start.policy(settings?.buildModelLabel)}
        </span>
        <span className={s.spacer} />
        {signedIn && (me?.memberships.length ?? 0) > 1 && (
          <label className={s.ruOnly}>
            <span>{ru.start.org}</span>
            <select
              className={s.orgSelect}
              value={orgId}
              onChange={(e) => setOrg(e.target.value)}
              data-testid="start-org"
            >
              {me?.memberships.map((m) => (
                <option key={m.orgId} value={m.orgId}>
                  {ru.start.orgOption(m.orgName, ru.roles[m.role] ?? m.role)}
                </option>
              ))}
            </select>
          </label>
        )}
        {signedIn && (me?.memberships.length ?? 0) <= 1 && role && (
          <span className={s.policy} data-testid="start-org">
            {ru.start.orgOption(me?.memberships[0]?.orgName ?? "", ru.roles[role] ?? role)}
          </span>
        )}
        <label
          className={s.ruOnly}
          title={
            settings?.t1Restricted
              ? ru.start.ruOnlyRestricted
              : canOwn(role)
                ? ru.start.ruOnlyHint
                : ru.start.ruOnlyOwner
          }
        >
          <input
            type="checkbox"
            data-testid="start-ru-only"
            checked={settings?.ruOnly === true || settings?.t1Restricted === true}
            disabled={!settings || settings.t1Restricted === true || !canOwn(role) || ruBusy}
            onChange={(e) => void toggleRuOnly(e.target.checked)}
          />
          {ru.start.ruOnly}
        </label>
        {/* «Free · N кредитов до <дата>»: GET /orgs/:orgId/credits + plan (M1); a link to S-billing (M2-11). */}
        {money ? (
          <a
            href="/billing"
            data-testid="start-credits"
            className={s.creditsLink}
            title={ru.start.creditsTitle}
            onClick={(e) => {
              e.preventDefault();
              navigate("/billing");
            }}
          >
            <Pill tone="neutral">{ru.start.creditsPill(money.plan, money.available, money.until)}</Pill>
          </a>
        ) : (
          <span data-testid="start-credits" title={ru.start.creditsHint}>
            <Pill tone="neutral">{ru.start.credits}: —</Pill>
          </span>
        )}
        {pilot && (
          <a
            href="/welcome"
            className={s.creditsLink}
            data-testid="start-pilot-about"
            onClick={(e) => {
              e.preventDefault();
              navigate("/welcome");
            }}
          >
            {ru.start.pilotAbout}
          </a>
        )}
        {signedIn && (
          <Button size="sm" variant="ghost" onClick={() => void logout()} data-testid="start-logout">
            {ru.start.logout}
          </Button>
        )}
      </header>

      <main className={s.hero}>
        <h1 className={s.title}>{ru.start.title}</h1>
        <p className={s.subtitle}>{ru.start.subtitle}</p>
        <label className={s.promptLabel} htmlFor="start-prompt">
          {ru.start.promptLabel}
        </label>
        <textarea
          id="start-prompt"
          className={s.prompt}
          data-testid="start-prompt"
          value={prompt}
          maxLength={8000}
          rows={6}
          placeholder={ru.start.promptPlaceholder}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKey}
        />
        <fieldset className={s.templates}>
          <legend className={s.templatesLabel}>{ru.start.templates}:</legend>
          {ru.templates.map((t) => (
            <button
              key={t.id}
              type="button"
              className={s.chip}
              data-testid={`start-template-${t.id}`}
              aria-pressed={templateId === t.id}
              onClick={() => {
                setTemplateId(t.id);
                setPrompt(t.prompt);
              }}
            >
              {t.label}
            </button>
          ))}
        </fieldset>
        <div className={s.actions}>
          <span className={s.uploadHint}>
            <Button variant="ghost" size="sm" data-testid="start-upload" disabled title={ru.start.uploadHint}>
              {ru.start.upload}
            </Button>
            <span>{ru.start.uploadHint}</span>
          </span>
          <Button
            variant="primary"
            data-testid="start-submit"
            disabled={empty || !canEdit(role, auth)}
            loading={busy}
            onClick={() => void submit()}
            title={ru.start.submitHint}
          >
            {ru.start.submit}
          </Button>
        </div>
        {error && (
          <Alert>
            {error.message}{" "}
            {error.code === "INSUFFICIENT_CREDITS" && (
              <Button size="sm" variant="secondary" disabled={!signedIn} onClick={() => navigate("/billing")}>
                {ru.errors.topUp}
              </Button>
            )}
          </Alert>
        )}
      </main>

      {systems.length > 0 && (
        <section className={s.systems} aria-label={ru.start.systems}>
          <h2 className={s.systemsTitle}>{ru.start.systems}</h2>
          <ul className={s.systemsList}>
            {systems.map((sys) => (
              <li key={sys.id} className={s.systemItem}>
                <a
                  href={`/s/${sys.id}`}
                  className={s.systemCard}
                  data-testid="start-system-card"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/s/${sys.id}`);
                  }}
                >
                  <span className={s.systemName}>{sys.name}</span>
                  <span title={sys.prodRevision ? ru.start.prodTitle : ru.start.draftTitle}>
                    <Pill tone={sys.prodRevision ? "ok" : "neutral"}>
                      {sys.prodRevision ? ru.start.stageProd : ru.start.stageDraft}
                    </Pill>
                  </span>
                  <span className={s.systemStage}>{ru.workspace.stage[sys.stage] ?? sys.stage}</span>
                </a>
                {team !== null && (
                  <span className={s.systemTeam}>
                    {ru.start.team(team)}
                    {canOwn(role) && (
                      <>
                        {" · "}
                        <a
                          href={`/s/${sys.id}/settings`}
                          onClick={(e) => {
                            e.preventDefault();
                            navigate(`/s/${sys.id}/settings`);
                          }}
                        >
                          {ru.start.invite}
                        </a>
                      </>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
