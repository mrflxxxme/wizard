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
export function composeContext(o: { photos?: boolean; systemId?: string } = {}): V3BuildContext {
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
      operatorContact: "+7 843 200-40-50",
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
    budgetRub: 40,
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
