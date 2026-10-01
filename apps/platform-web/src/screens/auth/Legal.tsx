// Platform documents linked from S-auth (compliance.yaml#platform.documents): drafts until the lawyer's texts
// (PENDING E-LEGAL) — no text is published on behalf of the company before that.
import type { ReactNode } from "react";
import { ru } from "../../i18n/ru.js";
import s from "./Auth.module.css";

export function Legal({ doc }: { doc: string }): ReactNode {
  return (
    <main className={s.page}>
      <article className={`${s.card} ${s.wide}`} aria-labelledby="legal-title">
        <h1 id="legal-title" className={s.title}>
          {ru.legal.title[doc] ?? doc}
        </h1>
        <p className={s.docText}>{ru.legal.draft}</p>
      </article>
    </main>
  );
}
