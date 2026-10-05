// S-welcome (M2-09, D24_pilot_free): the first screen of a design partner after the founder's invitation (the letter
// links to /login?email=…&next=/welcome). Explains the pilot — what is free, the plan limits (billing.yaml#plans.pilot),
// that the first prod publication is reviewed (abuse.yaml#identification.founder_review) — and starts a system from a
// template (S1 with ?template=<id>) or the owner's own words. Orgs on other plans go straight to S1. D70: the pilot
// limit in words (builds and edits in 30 days), no credits.
import { Button } from "@wizard/ui-kit";
import { type ReactNode, useEffect, useState } from "react";
import { usePlatform } from "../../app/context.js";
import { navigate } from "../../app/router.js";
import { useUsage } from "../../features/pricing/Usage.js";
import { pricing } from "../../i18n/ru/pricing.js";
import { ru } from "../../i18n/ru.js";
import s from "./Welcome.module.css";

export function Welcome(): ReactNode {
  const { api, orgId, me } = usePlatform();
  const [org, setOrg] = useState<{ name: string; plan: string } | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getOrg(orgId)
      .then((o) => {
        if (!live) return;
        if (o.plan !== "pilot") navigate("/", { replace: true });
        else setOrg({ name: o.name, plan: o.plan });
      })
      .catch(() => live && navigate("/", { replace: true }));
    return () => {
      live = false;
    };
  }, [api, orgId]);

  const usage = useUsage(api, orgId);
  const name = org?.name ?? me?.memberships.find((m) => m.orgId === orgId)?.orgName ?? "";

  if (!org)
    return (
      <main aria-busy="true" style={{ padding: 24 }}>
        {ru.code.loading}
      </main>
    );

  return (
    <div className={s.page}>
      <main className={s.main}>
        <h1 className={s.title} data-testid="welcome-title">
          {ru.welcome.title}
        </h1>
        <p className={s.lead}>
          <span data-testid="welcome-org">{ru.welcome.org(name)}</span> {ru.welcome.lead}
        </p>
        <section className={s.grid}>
          <article className={s.card} data-testid="welcome-free">
            <h2 className={s.cardTitle}>{ru.welcome.freeTitle}</h2>
            <p>{ru.welcome.free}</p>
            <p data-testid="welcome-usage">
              {usage?.builds.limit != null && usage.edits.limit != null
                ? `${pricing.window(usage.builds.limit, usage.edits.limit)} ${pricing.more}`
                : ru.welcome.usageUnknown}
            </p>
          </article>
          <article className={s.card} data-testid="welcome-limits">
            <h2 className={s.cardTitle}>{ru.welcome.limitsTitle}</h2>
            <p>{ru.welcome.limits}</p>
          </article>
          <article className={s.card} data-testid="welcome-review">
            <h2 className={s.cardTitle}>{ru.welcome.reviewTitle}</h2>
            <p>{ru.welcome.review}</p>
          </article>
          <article className={s.card}>
            <h2 className={s.cardTitle}>{ru.welcome.dataTitle}</h2>
            <p>{ru.welcome.data}</p>
          </article>
        </section>
        <section className={s.start} aria-labelledby="welcome-start-title">
          <h2 id="welcome-start-title" className={s.cardTitle}>
            {ru.welcome.startTitle}
          </h2>
          <p className={s.muted}>{ru.welcome.startHint}</p>
          <div className={s.chips}>
            {ru.templates
              .filter((t) => t.id !== "custom")
              .map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={s.chip}
                  data-testid={`welcome-template-${t.id}`}
                  onClick={() => navigate(`/?template=${encodeURIComponent(t.id)}`)}
                >
                  {t.label}
                </button>
              ))}
          </div>
          <div>
            <Button variant="primary" data-testid="welcome-start" onClick={() => navigate("/")}>
              {ru.welcome.start}
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}
