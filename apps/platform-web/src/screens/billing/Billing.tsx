// S-billing «Тариф, баланс и карта» (/billing, platform-screens.yaml S-billing, M2-11): plan with limits and login
// methods, subscription change/cancel, balance with buckets, the ledger by runs, «Докупить» packs of 60 credits and
// «Привязать карту РФ» through the platform's YooKassa shop (billing.yaml#card_binding). Money actions are owner-only;
// editor/viewer see the plan and the balance without buttons (the server answers 403 NOT_OWNER anyway). The YooKassa
// return URL is /billing?payment=<id>: the page polls GET billing until the card binding is no longer pending.
// M2-15 (WIZARD_PAYMENTS=off, Org.paymentsEnabled = false): no plan change, cancel, card or top-up — the plan, the
// balance and the ledger stay; the money controls appear only once GET /orgs/:orgId has answered (no flash).
// D70 (M2-56 mvp_scope): on the pilot plan or with payments off the client sees «На пилоте бесплатно» and what is left
// of the pilot limit in words (GET /orgs/:id/usage) — no balance, ledger or credits; «Написать команде» for more.
import { Button } from "@wizard/ui-kit";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { Billing, CreditBalance, LedgerEntry, Org, PlanId } from "../../api/types.js";
import { canOwn, usePlatform } from "../../app/context.js";
import { goExternal, navigate, setQueryParam, useRoute } from "../../app/router.js";
import { Alert, Pill } from "../../components/ui.js";
import { UsageDetails, useUsage } from "../../features/pricing/Usage.js";
import { TeamButton } from "../../features/support/SupportWidget.js";
import { pricing } from "../../i18n/ru/pricing.js";
import { fmtCredits, ru } from "../../i18n/ru.js";
import s from "../settings/Settings.module.css";
import { Rail } from "../workspace/Rail.js";
import b from "./Billing.module.css";

/** billing.yaml#plans (prices, limits, monthly grants, login methods by plan — F4); the API returns only the current. */
export const PLANS: Record<
  PlanId,
  { priceRub: number; prod: number; members: number; credits: number; phone: boolean }
> = {
  free: { priceRub: 0, prod: 1, members: 3, credits: 25, phone: false },
  pilot: { priceRub: 0, prod: 5, members: 30, credits: 0, phone: false },
  start: { priceRub: 1990, prod: 2, members: 10, credits: 50, phone: true },
  business: { priceRub: 6990, prod: 5, members: 30, credits: 230, phone: true },
};
/** billing.yaml#plans.topup */
export const TOPUP = { priceRub: 990, credits: 60, maxPacks: 20 } as const;

const PAID: ("start" | "business")[] = ["start", "business"];
const POLL_MS = 1000;
const POLL_TRIES = 40;

const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtCredits(Math.abs(n))}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : ru.errors.generic);
const planName = (p: string) => ru.billing.planName[p] ?? p;

export function BillingScreen(): ReactNode {
  const { api, me, orgId, roleIn, setOrg } = usePlatform();
  const { search } = useRoute();
  const role = roleIn(orgId);
  const owner = canOwn(role);
  const [org, setOrgView] = useState<Org | null>(null);
  // GET /orgs/:orgId answered (or failed): only then is Org.paymentsEnabled known.
  const [orgReady, setOrgReady] = useState(false);
  // undefined — loading; null — not available (not an owner, or the request failed).
  const [billing, setBilling] = useState<Billing | null | undefined>(undefined);
  const [credits, setCredits] = useState<CreditBalance | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [packs, setPacks] = useState(1);
  const [plansOpen, setPlansOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const usage = useUsage(api, orgId);
  const returned = useRef(search.get("payment"));
  const [checking, setChecking] = useState(returned.current !== null);

  const loadMoney = useCallback(async () => {
    const [c, l] = await Promise.all([
      api.getCredits(orgId).catch(() => null),
      api.listLedger(orgId).catch(() => null),
    ]);
    setCredits(c);
    setLedger(l?.items ?? []);
    setCursor(l?.nextCursor ?? null);
  }, [api, orgId]);

  const loadBilling = useCallback(async (): Promise<Billing | null> => {
    if (!owner) {
      setBilling(null);
      return null;
    }
    const v = await api.getBilling(orgId).catch(() => null);
    setBilling(v);
    return v;
  }, [api, orgId, owner]);

  useEffect(() => {
    let live = true;
    api
      .getOrg(orgId)
      .then((o) => live && setOrgView(o))
      .catch(() => live && setOrgView(null))
      .finally(() => live && setOrgReady(true));
    void loadMoney();
    void loadBilling();
    return () => {
      live = false;
    };
  }, [api, orgId, loadMoney, loadBilling]);

  // Back from the YooKassa page: the notification may still be on its way — re-read until nothing is pending.
  useEffect(() => {
    if (returned.current === null) return;
    let live = true;
    void (async () => {
      for (let i = 0; i < POLL_TRIES && live; i++) {
        const v = await loadBilling();
        await loadMoney();
        if (v?.cardBinding?.status !== "pending") break;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      if (!live) return;
      returned.current = null;
      setChecking(false);
      setQueryParam("payment", null);
    })();
    return () => {
      live = false;
    };
  }, [loadBilling, loadMoney]);

  async function act(name: string, fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function bindCard() {
    await act("bind", async () => {
      const r = await api.startCardBinding(orgId);
      if (!goExternal(r.confirmationUrl)) throw new ApiError(500, null);
    });
  }

  async function topup() {
    await act("topup", async () => {
      const r = await api.createTopup(orgId, packs);
      // Without a bound card the payment goes through the YooKassa page.
      if (r.confirmationUrl) {
        if (!goExternal(r.confirmationUrl)) throw new ApiError(500, null);
        return;
      }
      // Paid by the bound card: the credits are already granted.
      await loadMoney();
      setNotice(ru.billing.topupDone(packs * TOPUP.credits));
    });
  }

  async function changePlan(plan: "start" | "business") {
    await act(`plan:${plan}`, async () => {
      const r = await api.changeSubscription(orgId, plan);
      if (r.confirmationUrl) {
        if (!goExternal(r.confirmationUrl)) throw new ApiError(500, null);
        return;
      }
      setBilling(r);
      setPlansOpen(false);
      await loadMoney();
      api
        .getOrg(orgId)
        .then(setOrgView)
        .catch(() => {});
      setNotice(r.plan === plan ? ru.billing.changed(planName(plan)) : ru.billing.scheduled(planName(plan)));
    });
  }

  async function cancelSubscription() {
    setConfirmCancel(false);
    await act("cancel", async () => {
      setBilling(await api.cancelSubscription(orgId));
      setNotice(ru.billing.cancelled);
    });
  }

  async function moreLedger() {
    if (!cursor) return;
    const page = await api.listLedger(orgId, cursor).catch(() => null);
    if (!page) return;
    setLedger((prev) => [...(prev ?? []), ...page.items]);
    setCursor(page.nextCursor);
  }

  const plan: PlanId = billing?.plan ?? org?.plan ?? "free";
  const def = PLANS[plan] ?? PLANS.free;
  const limits = billing?.limits ?? {
    prodSystems: def.prod,
    members: def.members,
    monthlyCredits: def.credits,
  };
  const payments = orgReady && org?.paymentsEnabled !== false && billing?.paymentsEnabled !== false;
  // D70: credits are the internal guard — shown only to paying plans with payments on (after the pilot).
  const showCredits = payments && plan !== "pilot";
  const active = billing?.status === "active";
  const renewing = active && !billing?.cancelAtPeriodEnd;
  const memberships = me?.memberships ?? [];
  const binding = billing?.cardBinding ?? null;
  const cardState = billing?.card
    ? "bound"
    : binding?.status === "pending"
      ? "pending"
      : billing === undefined
        ? "loading"
        : "none";

  return (
    <div className={s.shell}>
      <Rail />
      <main className={s.page}>
        <header className={s.head}>
          <h1 className={s.title}>{ru.billing.title}</h1>
          {memberships.length > 1 ? (
            <label className={s.field}>
              <span className={s.muted}>{ru.billing.org}</span>
              <select value={orgId} onChange={(e) => setOrg(e.target.value)} data-testid="billing-org">
                {memberships.map((m) => (
                  <option key={m.orgId} value={m.orgId}>
                    {ru.start.orgOption(m.orgName, ru.roles[m.role] ?? m.role)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            org && <Pill tone="neutral">{org.name}</Pill>
          )}
          <span className={s.spacer} />
          <Button variant="secondary" size="sm" onClick={() => navigate("/")}>
            {ru.billing.back}
          </Button>
        </header>
        {error && <Alert testId="billing-error">{error}</Alert>}
        {notice && (
          <p className={s.notice} role="status" data-testid="billing-notice">
            {notice}
          </p>
        )}
        {checking && (
          <p className={s.notice} role="status" aria-busy="true" data-testid="billing-checking">
            {ru.billing.returned}
          </p>
        )}
        {orgReady && !payments && (
          <p className={s.notice} data-testid="billing-payments-off">
            {ru.billing.paymentsOff}
          </p>
        )}
        {!owner && payments && <p className={s.hint}>{ru.billing.ownerOnly}</p>}

        <div className={s.grid}>
          <section
            className={s.block}
            data-testid="billing-plan"
            data-plan={plan}
            aria-labelledby="plan-title"
          >
            <h2 id="plan-title" className={s.blockTitle}>
              {ru.billing.plan}
            </h2>
            <p className={b.planLine}>
              <b className={b.big}>{planName(plan)}</b>
              <span className={s.muted}>{ru.billing.planPrice(def.priceRub)}</span>
            </p>
            {billing && billing.status !== "none" && (
              <p className={s.small} data-testid="billing-plan-status" data-status={billing.status}>
                {[
                  ru.billing.status[billing.status],
                  billing.periodEnd && renewing ? ru.billing.paidUntil(fmtDay(billing.periodEnd)) : "",
                  billing.periodEnd && active && billing.cancelAtPeriodEnd
                    ? ru.billing.endsAt(fmtDay(billing.periodEnd))
                    : "",
                  billing.nextPlan && billing.periodEnd
                    ? ru.billing.nextPlan(planName(billing.nextPlan), fmtDay(billing.periodEnd))
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
            <p className={s.small}>{ru.billing.limits(limits.prodSystems, limits.members)}</p>
            <p className={s.small}>{ru.billing.loginMethods(def.phone)}</p>
            {owner && payments && (
              <div className={s.row}>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-expanded={plansOpen}
                  disabled={busy !== null || billing === null}
                  onClick={() => setPlansOpen(!plansOpen)}
                  data-testid="billing-change-plan"
                >
                  {ru.billing.changePlan}
                </Button>
                {billing && (renewing || billing.status === "past_due") && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    loading={busy === "cancel"}
                    onClick={() => setConfirmCancel(true)}
                    data-testid="billing-cancel"
                  >
                    {ru.billing.cancel}
                  </Button>
                )}
              </div>
            )}
            {payments && confirmCancel && billing && (
              <div className={b.confirm} data-testid="billing-cancel-confirm">
                <p className={s.small}>
                  {ru.billing.cancelConfirm(
                    billing.periodEnd && billing.status === "active" ? fmtDay(billing.periodEnd) : null,
                  )}
                </p>
                <div className={s.row}>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setConfirmCancel(false)}
                    data-testid="billing-cancel-no"
                  >
                    {ru.billing.cancelNo}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => void cancelSubscription()}
                    data-testid="billing-cancel-yes"
                  >
                    {ru.billing.cancelYes}
                  </Button>
                </div>
              </div>
            )}
            {payments && plansOpen && billing && (
              <ul className={s.list} data-testid="billing-plans">
                {PAID.map((p) => {
                  const d = PLANS[p];
                  const current = plan === p;
                  const resume = current && active && (billing.cancelAtPeriodEnd || !!billing.nextPlan);
                  const scheduled = billing.nextPlan === p;
                  return (
                    <li key={p} className={b.planOption} data-testid={`billing-plan-${p}`}>
                      <span>
                        <b>{ru.billing.choosePlan(planName(p), ru.billing.planPrice(d.priceRub))}</b>
                        <br />
                        <span className={s.muted}>{ru.billing.limits(d.prod, d.members)}</span>
                      </span>
                      {current && renewing && !billing.nextPlan ? (
                        <Pill tone="ok">{ru.billing.current}</Pill>
                      ) : (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busy !== null || scheduled}
                          loading={busy === `plan:${p}`}
                          onClick={() => void changePlan(p)}
                          data-testid={`billing-plan-${p}-submit`}
                        >
                          {resume ? ru.billing.resume : ru.billing.toPlan(planName(p))}
                        </Button>
                      )}
                    </li>
                  );
                })}
                <li className={s.hint}>
                  {active ? `${ru.billing.downgradeNote}. ${ru.billing.upgradeNote}` : ru.billing.bindHint}
                </li>
              </ul>
            )}
          </section>

          {payments && (
            <section className={s.block} data-testid="billing-card" aria-labelledby="card-title">
              <h2 id="card-title" className={s.blockTitle}>
                {ru.billing.card}
              </h2>
              {owner && (
                <p
                  className={cardState === "bound" ? b.ok : s.small}
                  data-testid="billing-card-status"
                  data-status={cardState}
                >
                  {cardState === "bound" && billing?.card
                    ? `${ru.billing.cardBound} · ${ru.billing.cardNumber(billing.card.last4, billing.card.cardType)}`
                    : cardState === "pending"
                      ? ru.billing.cardPending
                      : cardState === "loading"
                        ? ru.code.loading
                        : ru.billing.cardNone}
                </p>
              )}
              {owner && binding?.status === "rejected" && (
                <Alert testId="billing-card-error">
                  {binding.code === "CARD_NOT_RU" ? ru.billing.cardNotRu : ru.billing.cardRejected}
                </Alert>
              )}
              {!owner && (
                <p className={org?.cardBound ? b.ok : s.small} data-testid="billing-card-status">
                  {org?.cardBound ? ru.billing.cardBound : ru.billing.cardNone}
                </p>
              )}
              <p className={s.hint}>{ru.billing.bindHint}</p>
              <div>
                <Button
                  size="sm"
                  variant={billing?.card ? "secondary" : "primary"}
                  disabled={!owner || busy !== null || billing === undefined}
                  loading={busy === "bind"}
                  title={owner ? undefined : ru.billing.ownerOnly}
                  onClick={() => void bindCard()}
                  data-testid="billing-card-bind"
                >
                  {billing?.card ? ru.billing.rebind : ru.billing.bind}
                </Button>
              </div>
            </section>
          )}

          {usage?.pilot && (
            <section className={s.block} data-testid="billing-usage" aria-labelledby="usage-title">
              <h2 id="usage-title" className={s.blockTitle}>
                {pricing.free}
              </h2>
              <UsageDetails usage={usage} />
              <div>
                <TeamButton testId="billing-team" />
              </div>
            </section>
          )}

          {showCredits && (
            <section className={s.block} data-testid="billing-balance" aria-labelledby="balance-title">
              <h2 id="balance-title" className={s.blockTitle}>
                {ru.billing.balance}
              </h2>
              {credits ? (
                <>
                  <p className={b.big} data-testid="billing-available" data-value={credits.available}>
                    {ru.billing.available(credits.available)}
                  </p>
                  <p className={s.small}>{ru.billing.total(credits.balance, credits.held)}</p>
                  <ul className={s.list}>
                    {(credits.buckets ?? [])
                      .filter((x) => x.remaining > 0)
                      .map((x) => (
                        <li
                          key={`${x.source}|${x.expiresAt}`}
                          className={s.small}
                          data-testid="billing-bucket"
                          data-source={x.source}
                        >
                          {ru.billing.bucketLine(
                            ru.billing.bucket[x.source] ?? x.source,
                            fmtCredits(x.remaining),
                            x.expiresAt ? fmtDay(x.expiresAt) : null,
                          )}
                        </li>
                      ))}
                  </ul>
                </>
              ) : (
                <p className={s.small}>{ru.code.loading}</p>
              )}
              {/* billing.yaml#plans.topup.available_on: no top-up on pilot (the whole block is hidden there, D70). */}
              {payments && (
                <div className={s.sub}>
                  <h3 className={s.subTitle}>{ru.billing.topup}</h3>
                  <div className={s.row}>
                    <label className={s.field}>
                      <span className={s.muted}>{ru.billing.topupPacks}</span>
                      <select
                        value={packs}
                        disabled={!owner || busy !== null}
                        onChange={(e) => setPacks(Number(e.target.value))}
                        data-testid="billing-topup-packs"
                      >
                        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!owner || busy !== null}
                      loading={busy === "topup"}
                      title={owner ? undefined : ru.billing.ownerOnly}
                      onClick={() => void topup()}
                      data-testid="billing-topup"
                    >
                      {ru.billing.topupButton(packs, packs * TOPUP.priceRub)}
                    </Button>
                  </div>
                  <p className={s.hint}>{ru.billing.topupHint}</p>
                </div>
              )}
            </section>
          )}

          {showCredits && (
            <section
              className={`${s.block} ${s.wide}`}
              data-testid="billing-ledger"
              aria-labelledby="ledger-title"
            >
              <h2 id="ledger-title" className={s.blockTitle}>
                {ru.billing.ledger}
              </h2>
              <p className={s.hint}>{ru.billing.ledgerHint}</p>
              {ledger === null ? (
                <p className={s.small}>{ru.code.loading}</p>
              ) : ledger.length === 0 ? (
                <p className={s.small}>{ru.billing.ledgerEmpty}</p>
              ) : (
                <ul className={s.list}>
                  {ledger.map((x) => (
                    <li key={x.id} className={s.logRow} data-testid="billing-ledger-row" data-kind={x.kind}>
                      <span className={s.muted}>{fmtTime(x.createdAt)}</span>
                      <b className={x.amount > 0 ? b.plus : b.minus}>{signed(x.amount)}</b>
                      <span>{ru.billing.ledgerKind[x.kind] ?? x.kind}</span>
                      {x.note_ru && <span>{x.note_ru}</span>}
                      {x.systemId && (
                        <a
                          href={`/s/${x.systemId}`}
                          className={s.link}
                          onClick={(e) => {
                            e.preventDefault();
                            navigate(`/s/${x.systemId}`);
                          }}
                        >
                          {ru.billing.ledgerSystem}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {cursor && (
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void moreLedger()}
                    data-testid="billing-ledger-more"
                  >
                    {ru.billing.ledgerMore}
                  </Button>
                </div>
              )}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
