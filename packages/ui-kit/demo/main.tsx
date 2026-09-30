/// <reference types="vite/client" />
// ui-kit demo (ui-kit.yaml#demo): every component on the «форум»/«кондитерская» specs via createMemoryDataSource.
// URL: ?story=<Component>&role=<role>&spec=forum|bakery&accent=%23RRGGBB&font=&radius=&density=&mode=
import type { Theme } from "@wizard/appspec";
import { StrictMode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { applyTokens, toRoleSpec, WzProvider } from "../src/index.js";
import { createMemoryDataSource, type MemoryDataSource } from "../src/testing/index.js";
import styles from "./demo.module.css";
import { FIXTURES, SPECS, type SpecKey } from "./fixtures.js";
import type { Story } from "./story.js";

const modules = import.meta.glob<{ default: Story }>("./stories/*.tsx", { eager: true });
export const STORIES: Story[] = Object.values(modules)
  .map((m) => m.default)
  .sort((a, b) => a.component.localeCompare(b.component));

const FONTS = ["Onest", "Inter Tight", "Manrope", "PT Sans", "IBM Plex Sans"] as const;
const params = new URLSearchParams(window.location.search);

function readTheme(spec: SpecKey): Theme {
  const base: Theme = { ...(SPECS[spec].theme ?? {}) };
  const accent = params.get("accent");
  if (accent) base.accent = accent;
  const font = params.get("font");
  if (font) base.font = font as Theme["font"];
  const radius = params.get("radius");
  if (radius) base.radius = Number(radius) as Theme["radius"];
  const density = params.get("density");
  if (density) base.density = density as Theme["density"];
  const mode = params.get("mode");
  if (mode) base.mode = mode as Theme["mode"];
  return base;
}

declare global {
  interface Window {
    __wz: { applyTokens(theme: Theme): number; ready: boolean };
    /** Memory data sources per story (Playwright inspects calls and rows, injects failures). */
    __wzDemo: Record<string, MemoryDataSource>;
  }
}

function StoryHost({ story, roleOverride }: { story: Story; roleOverride: string | null | undefined }) {
  const spec = SPECS[story.spec];
  const role = roleOverride !== undefined ? roleOverride : story.role;
  const ds = useMemo(() => {
    const f = FIXTURES[story.spec]();
    return createMemoryDataSource(spec, f.rows, {
      users: f.users,
      functions: f.functions,
      userId: role ? `u_${role}` : null,
    });
  }, [spec, story.spec, role]);
  const [path, setPath] = useState(story.path ?? "/");
  useEffect(() => {
    window.__wzDemo ??= {};
    window.__wzDemo[story.component] = ds;
  }, [ds, story.component]);
  const userRole = useSyncExternalStore(ds.subscribe, () => ds.getUser()?.role ?? "");
  useSyncExternalStore(ds.subscribe, ds.version);
  const roleSpec = useMemo(
    () => toRoleSpec(spec, userRole || null, { policyVersion: "demo-1", consentTextHash: "demo" }),
    [spec, userRole],
  );
  const code = ds.outbox.at(-1);
  return (
    <WzProvider spec={roleSpec} dataSource={ds} applyTheme={false} navigate={setPath} pathname={path}>
      <div className={styles.meta}>
        <span data-testid="demo-path">{path}</span>
        {code && <span data-testid="demo-outbox">{`Код для ${code.destination}: ${code.code}`}</span>}
      </div>
      {story.render({ ds })}
    </WzProvider>
  );
}

function Demo() {
  const [specKey, setSpecKey] = useState<SpecKey>((params.get("spec") as SpecKey) ?? "forum");
  const [theme, setTheme] = useState<Theme>(() => readTheme(specKey));
  const only = params.get("story");
  const roleParam = params.has("role") ? params.get("role") || null : undefined;
  useEffect(() => applyTokens(document.documentElement, theme), [theme]);
  useEffect(() => {
    window.__wz = {
      applyTokens: (t) => {
        const t0 = performance.now();
        applyTokens(document.documentElement, t);
        return performance.now() - t0;
      },
      ready: true,
    };
  }, []);
  const set = (patch: Partial<Theme>) => setTheme((t) => ({ ...t, ...patch }));
  const stories = STORIES.filter((s) => !only || s.component === only);
  return (
    <div className={styles.page}>
      <header className={styles.controls}>
        <h1 className={styles.title}>Wizard ui-kit</h1>
        <label>
          Спека
          <select
            value={specKey}
            onChange={(e) => {
              const k = e.target.value as SpecKey;
              setSpecKey(k);
              setTheme(SPECS[k].theme ?? {});
            }}
          >
            <option value="forum">Форум</option>
            <option value="bakery">Кондитерская</option>
          </select>
        </label>
        <label>
          Акцент
          <input
            type="color"
            value={theme.accent ?? "#2F46D8"}
            onChange={(e) => set({ accent: e.target.value })}
          />
        </label>
        <label>
          Шрифт
          <select
            value={theme.font ?? "Onest"}
            onChange={(e) => set({ font: e.target.value as Theme["font"] })}
          >
            {FONTS.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
        <label>
          Скругление
          <select
            value={theme.radius ?? 8}
            onChange={(e) => set({ radius: Number(e.target.value) as Theme["radius"] })}
          >
            {[0, 4, 8, 12, 16].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label>
          Плотность
          <select
            value={theme.density ?? "regular"}
            onChange={(e) => set({ density: e.target.value as Theme["density"] })}
          >
            <option value="regular">Обычная</option>
            <option value="compact">Компактная</option>
          </select>
        </label>
        <label>
          Тема
          <select
            value={theme.mode ?? "auto"}
            onChange={(e) => set({ mode: e.target.value as Theme["mode"] })}
          >
            <option value="auto">Как в системе</option>
            <option value="light">Светлая</option>
            <option value="dark">Тёмная</option>
          </select>
        </label>
        <nav className={styles.toc} aria-label="Компоненты">
          {STORIES.map((s) => (
            <a key={s.component} href={`?story=${s.component}`}>
              {s.component}
            </a>
          ))}
        </nav>
      </header>
      <main className={styles.stories}>
        {stories.map((s) => (
          <section
            key={s.component}
            className={styles.story}
            data-story={s.component}
            aria-label={s.component}
          >
            <h2 className={styles.storyTitle}>{s.component}</h2>
            <StoryHost story={s} roleOverride={roleParam} />
          </section>
        ))}
      </main>
    </div>
  );
}

const el = document.getElementById("root");
if (el)
  createRoot(el).render(
    <StrictMode>
      <Demo />
    </StrictMode>,
  );
