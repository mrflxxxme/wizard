// Tabs of the main top bar (platform-screens.yaml#regions.main): Превью · Код (M1-08) · Данные (M2).
import type { ReactNode } from "react";
import { navigate } from "../../app/router.js";
import { ru } from "../../i18n/ru.js";
import s from "./Workspace.module.css";

export function MainTabs({ systemId, active }: { systemId: string; active: "preview" | "code" }): ReactNode {
  const tab = (id: "preview" | "code", label: string, to: string, title?: string) => (
    <a
      href={to}
      role="tab"
      aria-selected={active === id}
      className={active === id ? s.tabOn : s.tab}
      data-testid={`preview-tab-${id}`}
      title={title}
      onClick={(e) => {
        e.preventDefault();
        if (active !== id) navigate(to);
      }}
    >
      {label}
    </a>
  );
  return (
    <div className={s.tabs} role="tablist" aria-label={ru.preview.tabPreview}>
      {tab("preview", ru.preview.tabPreview, `/s/${systemId}`)}
      {tab("code", ru.preview.tabCode, `/s/${systemId}/code`, ru.preview.tabCodeHint)}
      <button
        type="button"
        role="tab"
        aria-selected="false"
        className={s.tab}
        disabled
        title={ru.preview.tabLater}
        data-testid="preview-tab-data"
      >
        {ru.preview.tabData}
      </button>
    </div>
  );
}
