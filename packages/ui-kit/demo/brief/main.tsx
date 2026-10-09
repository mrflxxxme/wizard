/// <reference types="vite/client" />
// Demo of the «Бриф» components (V3-06): the short brief in the chat and the panel with versions, difference, diagrams,
// the editor and the session feed, on the test briefs of V3-02. URL: ?theme=auto|light|dark&part=all|summary|panel
// &tab=brief|diagrams|versions|sessions&brief=dental|shop&motion=off. Saves of the editor become new versions here and
// are recorded in window.__wz.saves for the browser test.
import "../../src/v2/theme.css";
import {
  BRIEF_DIAGRAM_TITLES,
  type BriefVersion,
  briefDiagrams,
  briefDiff,
  type SystemBrief,
  systemBriefSchema,
} from "@wizard/appspec";
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { dentalBrief, scenario, shopBrief } from "../../../appspec/test/brief-fixtures.js";
import {
  BriefDiagram,
  type BriefDiagramKey,
  BriefPanel,
  type BriefPanelTab,
  type BriefSession,
  BriefSummary,
  type PlatformThemeMode,
  ThemeRoot,
} from "../../src/v2/index.js";
import s from "./demo.module.css";

const params = new URLSearchParams(window.location.search);
const part = params.get("part") ?? "all";
const parse = (b: unknown): SystemBrief => systemBriefSchema.parse(b);

type Saved = { brief: SystemBrief; baseVersion: number };
const harness = window as unknown as { __wz: { ready: boolean; saves: Saved[] } };
harness.__wz = { ready: false, saves: [] };

/** Three versions: the interview (agent), the owner's panel edit, the agent after a chat edit. */
function history(name: string): BriefVersion[] {
  const first = parse(name === "shop" ? shopBrief() : dentalBrief());
  const second = parse({
    ...first,
    goals: first.goals.map((g, i) => (i === 0 ? { ...g, success: "Не меньше 40 записей в месяц" } : g)),
    outOfScope: [...first.outOfScope, { text: "Программа лояльности", substitute: "Скидка в первый визит" }],
  });
  const third = parse({
    ...second,
    scenarios: [
      ...second.scenarios,
      scenario({ id: "s_review", actor: "client", when: "клиент оставляет отзыв после визита" }, [
        "публикует отзыв после проверки администратором",
      ]),
    ],
  });
  const at = (h: number) => new Date(Date.UTC(2026, 9, 8, h, 5)).toISOString();
  return [
    { version: 1, brief: first, diff: briefDiff(null, first), author: "agent", createdAt: at(9) },
    { version: 2, brief: second, diff: briefDiff(first, second), author: "owner", createdAt: at(10) },
    { version: 3, brief: third, diff: briefDiff(second, third), author: "agent", createdAt: at(11) },
  ];
}

const SESSIONS: BriefSession[] = [
  {
    id: "edit:chat",
    kind: "edit",
    source: "chat",
    status: "done",
    startedAt: "2026-10-08T11:03:00Z",
    finishedAt: "2026-10-08T11:05:00Z",
    briefVersions: [3],
    changes: ["Сценарии: добавлено «Когда клиент оставляет отзыв после визита»"],
    changesTotal: 1,
  },
  {
    id: "brief:2",
    kind: "edit",
    source: "panel",
    status: "done",
    startedAt: "2026-10-08T10:05:00Z",
    finishedAt: "2026-10-08T10:05:00Z",
    briefVersions: [2],
    changes: [
      "Цели, «Получать записи на приём с сайта»: изменено «Признак успеха»",
      "Не входит: добавлено «Программа лояльности»",
    ],
    changesTotal: 2,
  },
  {
    id: "build:1",
    kind: "build",
    status: "failed",
    startedAt: "2026-10-08T09:40:00Z",
    finishedAt: "2026-10-08T09:52:00Z",
    build: {
      mode: "create",
      revision: null,
      failure: "Сборка остановилась: кончилось время на этап проверки.",
    },
  },
  {
    id: "interview:1",
    kind: "interview",
    status: "done",
    startedAt: "2026-10-08T09:00:00Z",
    finishedAt: "2026-10-08T09:06:00Z",
    briefVersions: [1],
    changes: ["Цели: добавлено «Получать записи на приём с сайта»", "Цели: добавлено «Меньше неявок»"],
    changesTotal: 24,
  },
];

function Demo() {
  const theme = (params.get("theme") as PlatformThemeMode | null) ?? "auto";
  const [versions, setVersions] = useState<BriefVersion[]>(() => history(params.get("brief") ?? "dental"));
  const [open, setOpen] = useState<{ tab: BriefPanelTab; diagram: BriefDiagramKey | null } | null>(null);
  const latest = versions[versions.length - 1] as BriefVersion;
  const diagrams = useMemo(() => briefDiagrams(latest.brief), [latest]);
  const infos = useMemo(() => [...versions].reverse().map(({ brief: _b, ...v }) => v), [versions]);

  function save(brief: SystemBrief, baseVersion: number) {
    harness.__wz.saves.push({ brief, baseVersion });
    setVersions((vs) => {
      const last = vs[vs.length - 1] as BriefVersion;
      const diff = briefDiff(last.brief, brief);
      if (diff.length === 0) return vs;
      return [
        ...vs,
        { version: last.version + 1, brief, diff, author: "owner", createdAt: new Date().toISOString() },
      ];
    });
  }

  const panel = (
    <BriefPanel
      key={`${open?.tab ?? params.get("tab") ?? "brief"}-${open?.diagram ?? ""}`}
      brief={latest.brief}
      diagrams={diagrams}
      version={latest.version}
      author={latest.author}
      createdAt={latest.createdAt}
      versions={infos}
      sessions={SESSIONS}
      initialTab={open?.tab ?? (params.get("tab") as BriefPanelTab | null) ?? "brief"}
      initialDiagram={open?.diagram ?? null}
      onSave={save}
      onAskInChat={() => setOpen(null)}
    />
  );
  return (
    <ThemeRoot theme={theme} motion={params.get("motion") !== "off"} className={s.page} testId="demo-root">
      {part !== "panel" && (
        <section className={s.chat} aria-label="Чат">
          <BriefSummary
            brief={latest.brief}
            diagrams={diagrams}
            version={latest.version}
            onOpen={(diagram) => setOpen({ tab: diagram ? "diagrams" : "brief", diagram: diagram ?? null })}
          />
        </section>
      )}
      {part === "all" && (
        <section className={s.diagrams} aria-label="Схемы по отдельности">
          {(["journey", "dataRoles", "integrations"] as const).map((k) => (
            <BriefDiagram
              key={k}
              graph={diagrams[k]}
              title={BRIEF_DIAGRAM_TITLES[k]}
              testId={`demo-diagram-${k}`}
            />
          ))}
        </section>
      )}
      {(part === "panel" || part === "all" || open) && (
        <section
          className={part === "panel" ? s.full : s.box}
          aria-label="Панель «Бриф»"
          data-testid="demo-panel"
        >
          {panel}
        </section>
      )}
    </ThemeRoot>
  );
}

const el = document.getElementById("root");
if (el)
  createRoot(el).render(
    <StrictMode>
      <Demo />
    </StrictMode>,
  );
// Ready flag of the demo harness (test/helpers/demo.ts).
harness.__wz.ready = true;
