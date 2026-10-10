// S1 «Старт» (platform-screens.yaml#screens S1) on the design system v2 (B2-33, prototype E): a serif greeting and one
// input row in the middle of the screen; the first phrase creates the system and opens it (/s/:id — the canvas for the
// modules pipeline). Examples under the row fill it in; below the fold — «Ваши системы». M1 — current organization,
// «только РФ» (owner → PATCH settings), the team size on system cards, sign out. M2-09: `/?template=<id>` preselects a
// template (from S-welcome); pilot orgs get a link back to the pilot onboarding. D70: no credits — «На пилоте бесплатно»
// and what is left in words; a limit error offers «Написать команде» (D68).
import { Chip, Serif } from "@wizard/ui-kit/v2";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { ApiError, newIdempotencyKey } from "../api/client.js";
import type { DemoScenario, System } from "../api/types.js";
import { canEdit, canOwn, usePlatform } from "../app/context.js";
import { navigate, useRoute } from "../app/router.js";
import { Alert, Pill } from "../components/ui.js";
import { Button } from "../components/v2/Button.js";
import { AppLink, PlatformPage } from "../components/v2/Shell.js";
import { DemoBanner } from "../features/demo/DemoBanner.js";
import { needsTeam, usageText, useUsage } from "../features/pricing/Usage.js";
import { TeamButton } from "../features/support/SupportWidget.js";
import { demo } from "../i18n/ru/demo.js";
import { pricing } from "../i18n/ru/pricing.js";
import { shell } from "../i18n/ru/shell.js";
import { ru } from "../i18n/ru.js";
import s from "./Start.module.css";

export function Start(): ReactNode {
  const { api, settings, setSettings, auth, me, orgId, roleIn, setOrg } = usePlatform();
  const role = roleIn(orgId);
  const [team, setTeam] = useState<number | null>(null);
  const [ruBusy, setRuBusy] = useState(false);
  const { search } = useRoute();
  const preset = ru.templates.find((t) => t.id === search.get("template"));
  const [prompt, setPrompt] = useState<string>(preset?.prompt ?? "");
  const [templateId, setTemplateId] = useState<string | undefined>(preset?.id);
  const [pilot, setPilot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [systems, setSystems] = useState<System[]>([]);
  /** «Ваши системы» did not load: said in words with «Повторить» (not an empty list). */
  const [listFailed, setListFailed] = useState(false);
  const [listTry, setListTry] = useState(0);
  const keyRef = useRef<string | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  // B2-02: demo replay of a staff org — only recorded scenarios can start, offered as briefs.
  const [demoScenarios, setDemoScenarios] = useState<DemoScenario[] | null>(null);
  const [greeting] = useState(() => shell.greeting(new Date().getHours()));

  const signedIn = auth === "ready";
  // orgId only when it matters (api.yaml createSystem: required for members of several organizations); the server
  // defaults to the user's organization otherwise — and the seeded M0 id is not an RFC 4122 uuid for z.uuid().
  const orgParam = signedIn && (me?.memberships.length ?? 0) > 1 ? orgId : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: listTry is the «Повторить» signal
  useEffect(() => {
    let live = true;
    api
      .listSystems(orgParam)
      .then((r) => {
        if (!live) return;
        setSystems(r.items);
        setListFailed(false);
      })
      .catch(() => {
        if (!live) return;
        setSystems([]);
        setListFailed(true);
      });
    return () => {
      live = false;
    };
  }, [api, orgParam, listTry]);
  useEffect(() => {
    let live = true;
    if (signedIn)
      api
        .listMembers(orgId)
        .then((r) => live && setTeam(r.items.length))
        .catch(() => live && setTeam(null));
    if (signedIn && typeof api.getOrg === "function")
      api
        .getOrg(orgId)
        .then((o) => {
          if (!live) return;
          setPilot(o.plan === "pilot");
          setPlan(ru.billing.planName[o.plan] ?? o.plan);
          setDemoScenarios(o.demoReplay ? (o.demoScenarios ?? []) : null);
        })
        .catch(() => {
          if (!live) return;
          setPlan(null);
          setDemoScenarios(null);
        });
    return () => {
      live = false;
    };
  }, [api, orgId, signedIn]);
  const usage = useUsage(api, orgId, signedIn);
  const usageLine = usageText(usage);

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
  const allowed = canEdit(role, auth);

  async function submit() {
    if (empty || busy || !allowed) return;
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

  /** Enter sends (prototype E), Shift+Enter — a new line; Ctrl/Cmd+Enter sends too. */
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (e.shiftKey && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    void submit();
  }

  const actions = (
    <>
      {/* D70: «На пилоте бесплатно · ещё 2 сборки · ещё 15 правок» (GET /orgs/:id/usage), no credits; S-billing. */}
      {(usageLine || plan) && (
        <AppLink to="/billing" testId="start-usage" className={s.usage} label={pricing.pillTitle}>
          <Pill tone={usageLine ? "ok" : "neutral"}>{usageLine ?? pricing.plan(plan ?? "")}</Pill>
        </AppLink>
      )}
      {signedIn && (
        <Button size="sm" variant="ghost" onClick={() => void logout()} data-testid="start-logout">
          {ru.start.logout}
        </Button>
      )}
    </>
  );

  return (
    <PlatformPage actions={actions} testId="start">
      <main className={s.main}>
        <section className={`${s.hero} ${busy ? s.leaving : ""}`} aria-labelledby="start-hello">
          {demoScenarios && <DemoBanner testId="start-demo-replay" />}
          <Serif as="h1" size="xl" className={s.hello}>
            <span id="start-hello">{greeting}</span>
          </Serif>
          <p className={s.lead}>{shell.start.lead}</p>
          <form
            className={`${s.composer} ${busy ? s.thinking : ""}`}
            aria-busy={busy || undefined}
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            autoComplete="off"
          >
            <label className={s.srOnly} htmlFor="start-prompt">
              {ru.start.promptLabel}
            </label>
            <textarea
              id="start-prompt"
              className={s.input}
              data-testid="start-prompt"
              value={prompt}
              maxLength={8000}
              rows={1}
              placeholder={shell.start.placeholder}
              enterKeyHint="send"
              aria-describedby="start-send-hint"
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKey}
            />
            <button
              type="submit"
              className={s.send}
              data-testid="start-submit"
              aria-label={shell.start.send}
              title={shell.start.sendHint}
              disabled={empty || !allowed || busy}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 19V5M6 11l6-6 6 6" />
              </svg>
            </button>
            <span id="start-send-hint" className={s.srOnly}>
              {shell.start.sendHint}
            </span>
          </form>
          <ul className={s.examples} aria-label={shell.start.examples}>
            {ru.templates.map((t) => (
              <li key={t.id}>
                <Chip
                  tone="outline"
                  testId={`start-template-${t.id}`}
                  pressed={templateId === t.id}
                  onClick={() => {
                    setTemplateId(t.id);
                    setPrompt(t.prompt);
                  }}
                >
                  {t.label}
                </Chip>
              </li>
            ))}
          </ul>
          {demoScenarios && demoScenarios.length > 0 && (
            <ul className={s.examples} aria-label={demo.scenarios}>
              {demoScenarios.map((d) => (
                <li key={d.name}>
                  <Chip
                    tone="outline"
                    testId={`start-demo-${d.name}`}
                    pressed={prompt === d.brief}
                    onClick={() => {
                      setTemplateId(undefined);
                      setPrompt(d.brief);
                    }}
                  >
                    {d.title}
                  </Chip>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <Alert>
              {error.message} {needsTeam(error.code) && <TeamButton />}
            </Alert>
          )}
          <div className={s.meta}>
            <span data-testid="start-policy">{ru.start.policy(settings?.buildModelLabel)}</span>
            <span className={s.metaRow}>
              {signedIn && (me?.memberships.length ?? 0) > 1 && (
                <label className={s.metaItem}>
                  <span>{ru.start.org}</span>
                  <select
                    className={s.select}
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
                <span className={s.metaItem} data-testid="start-org">
                  {ru.start.orgOption(me?.memberships[0]?.orgName ?? "", ru.roles[role] ?? role)}
                </span>
              )}
              <label
                className={s.metaItem}
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
                  className={s.checkbox}
                  data-testid="start-ru-only"
                  checked={settings?.ruOnly === true || settings?.t1Restricted === true}
                  disabled={!settings || settings.t1Restricted === true || !canOwn(role) || ruBusy}
                  onChange={(e) => void toggleRuOnly(e.target.checked)}
                />
                {ru.start.ruOnly}
              </label>
              {pilot && (
                <AppLink to="/welcome" className={s.metaLink} testId="start-pilot-about">
                  {ru.start.pilotAbout}
                </AppLink>
              )}
            </span>
          </div>
        </section>

        {listFailed && (
          <section className={s.systems} aria-labelledby="start-systems" data-testid="start-systems-error">
            <h2 id="start-systems" className={s.systemsTitle}>
              {ru.start.systems}
            </h2>
            <Alert>
              {ru.start.systemsFailed}{" "}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setListTry((n) => n + 1)}
                data-testid="start-systems-retry"
              >
                {ru.errors.retry}
              </Button>
            </Alert>
          </section>
        )}
        {systems.length > 0 && (
          <section className={s.systems} aria-labelledby="start-systems">
            <h2 id="start-systems" className={s.systemsTitle}>
              {ru.start.systems}
            </h2>
            <ul className={s.systemsList}>
              {systems.map((sys) => (
                <li key={sys.id} className={s.systemItem}>
                  <AppLink to={`/s/${sys.id}`} className={s.systemCard} testId="start-system-card">
                    <Serif as="span" size="md" className={s.systemName}>
                      {sys.name}
                    </Serif>
                    <span className={s.systemMeta}>
                      <span title={sys.prodRevision ? ru.start.prodTitle : ru.start.draftTitle}>
                        <Pill tone={sys.prodRevision ? "ok" : "neutral"}>
                          {sys.prodRevision ? ru.start.stageProd : ru.start.stageDraft}
                        </Pill>
                      </span>
                      <span className={s.systemStage}>{ru.workspace.stage[sys.stage] ?? sys.stage}</span>
                    </span>
                  </AppLink>
                  {team !== null && (
                    <span className={s.systemTeam}>
                      {ru.start.team(team)}
                      {canOwn(role) && (
                        <>
                          {" · "}
                          <AppLink to={`/s/${sys.id}/settings`}>{ru.start.invite}</AppLink>
                        </>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </PlatformPage>
  );
}
