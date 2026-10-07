// B2-02: «Режим показа: ответы моделей записаны, расходов нет» on S1 and the workspace while the org replays recorded
// model answers (Org.demoReplay, getSystem.demoReplay); a quiet amber line of the design system v2 (B2-33).
import type { ReactNode } from "react";
import s from "../../components/ui.module.css";
import { demo } from "../../i18n/ru/demo.js";

export function DemoBanner({ testId = "demo-replay" }: { testId?: string }): ReactNode {
  return (
    <div role="status" className={s.demoBanner} data-testid={testId}>
      <span>{demo.banner}</span>
    </div>
  );
}
