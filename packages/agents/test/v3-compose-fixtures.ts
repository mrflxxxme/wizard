// V3-12 fixtures: a dental clinic compiled in backend mode (mvp-01 plan: landing, catalog, leads, notify) with the
// owner's photos, the operator data and a brief with scenarios; the client's design system; the answers of a signature
// section. The pages are composed on the real pattern library (V3-08). Shared by the composer tests and the browser
// test of @wizard/build.
import { type SystemBrief, systemBriefSchema } from "@wizard/appspec";
import { compilePlan } from "@wizard/modules";
import { designSystemV3 } from "@wizard/ui-kit/v3/design";
import { mvp01Plan } from "../../modules/test/backend-fixtures.js";
import type { V3BuildContext } from "../src/builder/v3/contract.js";
import { DEFAULT_REGISTRY } from "../src/planner/index.js";

export const BRIEF: SystemBrief = systemBriefSchema.parse({
  goals: [
    {
      id: "leads",
      text: "Пациенты оставляют заявки на сайте, и мы их не теряем",
      success: "Заявка видна в кабинете",
    },
  ],
  audience: "Взрослые пациенты района, которые боятся лечить зубы",
  scenarios: [
    {
      id: "lead",
      actor: "visitor",
      when: "посетитель хочет записаться на приём",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1 («Когда…, система…»)
      then: ["показывает форму заявки", "принимает имя и телефон с согласием"],
      goalId: "leads",
      moduleHint: "leads",
    },
    {
      id: "prices",
      actor: "visitor",
      when: "посетитель смотрит цены",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1 («Когда…, система…»)
      then: ["показывает каталог услуг с ценами"],
      moduleHint: "catalog",
    },
    {
      id: "owner_sees",
      actor: "owner",
      when: "приходит заявка",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1 («Когда…, система…»)
      then: ["показывает её в кабинете"],
      moduleHint: "leads",
    },
  ],
});

const PHOTOS = ["top", "top-2", "top-3"].map((slot, i) => ({
  slot,
  file: `0000000${i}-0000-4000-8000-00000000000${i}`,
  alt: [
    "Светлый кабинет клиники с креслом у окна",
    "Врач показывает пациенту снимок на экране",
    "Стойка администратора в холле клиники",
  ][i] as string,
  provider: "pexels" as const,
  stockId: `10${i}`,
  author: "Автор",
  pageUrl: "https://www.pexels.com/photo/1",
  license: "Pexels License",
  licenseUrl: "https://www.pexels.com/license",
  width: 1600,
  height: 1067,
  pickedAt: "2026-10-08",
}));

/** A build context of the fixture system; `photos: false` — the owner has no photos. */
/**
 * The clinic site's build context. `contact` — the operator's phone (a probe passes the stand-in of the record redaction,
 * «+7 900 000-00-00», so a recorded answer that quotes it still matches the facts on replay).
 */
export function composeContext(
  o: { photos?: boolean; systemId?: string; contact?: string } = {},
): V3BuildContext {
  const plan = mvp01Plan();
  const r = compilePlan(
    { ...plan, design: { ...plan.design, ...(o.photos === false ? {} : { photos: PHOTOS }) } },
    DEFAULT_REGISTRY,
    { appName: "Белая линия", front: "backend" },
  );
  if (!r.ok || !r.publicFront) throw new Error(JSON.stringify(r.ok ? "no public front" : r.errors));
  const spec = {
    ...r.spec,
    compliance: {
      ...r.spec.compliance,
      operatorName: "ООО «Белая линия»",
      operatorContact: o.contact ?? "+7 843 200-40-50",
      operatorAddress: "Казань, ул. Баумана, 15",
    },
  };
  return {
    systemId: o.systemId ?? "sys-white-line",
    brief: BRIEF,
    briefVersion: 1,
    plan: r.plan,
    spec,
    publicFront: r.publicFront,
    design: designSystemV3({ archetype: "calm_medical", brandColor: "#2a7f9e", seed: 7, niche: plan.niche }),
    files: new Map(Object.entries(r.files)),
    route: async () => {
      throw new Error("model is not connected in this test");
    },
    // V4-05: a page call is bounded by Kimi K3 now (≈ 30 ₽): room for the three attempts of a scenario.
    budgetRub: 100,
  };
}

/** A signature section that passes every check: the clinic's first visit in three real steps of the brief. */
export const SIGNATURE_OK = {
  name: "first-visit",
  title: "Как проходит первый приём",
  props: {
    title: "Первый приём без спешки",
    steps: [
      { title: "Заявка", text: "Вы оставляете имя и телефон на сайте." },
      { title: "Звонок администратора", text: "Администратор перезванивает и подбирает время." },
    ],
  },
  source: `// Signature section «Как проходит первый приём»: the visit as a path with large step titles.
type Step = { title: string; text: string };

export default function FirstVisit({ title, steps }: { title: string; steps: Step[] }) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="max-w-text font-display text-h2 font-bold text-balance wrap-break-word">{title}</h2>
        <ol className="mt-10 grid gap-8 border-t border-border pt-8 md:grid-cols-2">
          {steps.map((s) => (
            <li key={s.title} className="min-w-0">
              <h3 className="font-display text-h3 font-bold wrap-break-word">{s.title}</h3>
              <p className="mt-3 max-w-text text-body text-muted-foreground">{s.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
`,
};

/** V4-06: the first screen written as code (the one h1 of the page), its props from the facts. */
export const HERO_CODE = {
  title: "Первый экран: оффер и запись",
  props: {
    title: "Лечим зубы без боли и очередей",
    lead: "Оставьте заявку на сайте — администратор перезвонит за 15 минут и подберёт время приёма.",
    action: { label: "Записаться на приём", href: "#form" },
    image: {
      src: "/_wizard/photos/00000000-0000-4000-8000-000000000000/1600",
      alt: "Светлый кабинет клиники с креслом у окна",
    },
  },
  source: `// First screen: the offer on the left, a tall photo on the right, one action.
type Action = { label: string; href: string };
type Image = { src: string; alt: string };

export default function Hero({ title, lead, action, image }: { title: string; lead: string; action: Action; image: Image }) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto grid w-full max-w-page gap-10 px-gutter py-section md:grid-cols-[1.2fr_1fr] md:items-end">
        <div className="min-w-0">
          <h1 className="font-display text-hero font-bold text-balance wrap-break-word">{title}</h1>
          <p className="mt-6 max-w-text text-lead text-muted-foreground">{lead}</p>
          <a href={action.href} className="mt-8 inline-flex min-h-11 items-center rounded-control bg-primary px-6 font-bold text-primary-foreground">
            {action.label}
          </a>
        </div>
        <img src={image.src} alt={image.alt} className="aspect-[4/5] w-full rounded-lg object-cover" />
      </div>
    </section>
  );
}
`,
};
