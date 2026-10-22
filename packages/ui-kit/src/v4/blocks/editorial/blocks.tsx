// Blocks of the direction «Редакция» (V5-09, grill-12 (2)): an expert or a studio of services. Grammar of a newspaper
// page: a nameplate over a double rule, columns split by vertical hairlines, a big serif headline, prices as a table of
// contents with dot leaders, photos in black and white with captions. The signature is the editor's second reading:
// red-pencil corrections drawn over a translated page.
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { Credit, focus, Img, type Photo, rub, useStill } from "../kit.js";
import type { BlockProps } from "../types.js";

const cta = `inline-flex min-h-12 items-center justify-center bg-primary px-6 text-base font-semibold text-primary-foreground hover:bg-accent-strong ${focus}`;
const kicker = "text-[0.75rem] font-semibold uppercase tracking-[0.16em]";
const serif = "font-display font-semibold leading-[0.95] tracking-[-0.01em] lining-nums";
const h2 = `${serif} text-[calc(var(--ds-text-display)*0.95)] lg:text-[calc(var(--ds-text-display)*1.4)]`;
const bw = "grayscale contrast-[1.08]";

export type NavLink = { id: string; label: string };

/** Content of redaktsiya.header. */
export type EdHeaderContent = {
  name: string;
  logo?: ReactNode;
  /** The dateline over the nameplate: city, address, hours. */
  dateline: readonly string[];
  /** One line next to the nameplate: what the business is and since when. */
  motto: string;
  nav: readonly NavLink[];
  phone: string;
  phoneHref: string;
};

/** Nameplate: dateline, the name set large over a double rule, sections as a newspaper index. */
export function EdHeader({ content: c }: BlockProps<EdHeaderContent>) {
  return (
    <header className="px-gutter pt-3">
      <div className="flex flex-wrap justify-between gap-x-6 gap-y-1 border-b border-foreground pb-2 text-[0.75rem] lg:text-sm">
        {c.dateline.map((d) => (
          <span key={d}>{d}</span>
        ))}
        <a href={c.phoneHref} className={`font-semibold ${focus}`}>
          {c.phone}
        </a>
      </div>
      <div className="flex flex-col gap-2 py-4 lg:flex-row lg:items-end lg:justify-between">
        {c.logo ?? (
          <span
            className={`${serif} text-[calc(var(--ds-text-display)*1.1)] lg:text-[calc(var(--ds-text-display)*1.7)]`}
          >
            {c.name}
          </span>
        )}
        <p className="max-w-xs text-sm lg:text-right">{c.motto}</p>
      </div>
      <nav
        aria-label="Разделы"
        className="flex gap-6 overflow-x-auto border-y-4 border-double border-foreground py-2 text-sm font-semibold"
      >
        {c.nav.map((n) => (
          <a key={n.id} href={`#${n.id}`} className={`shrink-0 hover:text-accent-text ${focus}`}>
            {n.label}
          </a>
        ))}
      </nav>
    </header>
  );
}

export type TocRow = { name: string; price: number; plus?: string; term: string };

/** Content of redaktsiya.hero. */
export type EdHeroContent = {
  header: EdHeaderContent;
  kicker: string;
  /** Offer with a price, 3–8 words. */
  title: string;
  /** The lead paragraph; its first letter is set as a drop cap. */
  lead: string;
  cta: string;
  ctaHref: string;
  /** The quieter second way to send a document (text link). */
  alt: string;
  altHref: string;
  tocTitle: string;
  toc: readonly TocRow[];
  tocNote: string;
  photo: Photo;
  caption: string;
  facts: readonly { value: string; label: string }[];
};

/** Front page: headline with the price, lead with a drop cap, one action; prices as a table of contents. */
export function EdHero({ content: c }: BlockProps<EdHeroContent>) {
  return (
    <section className="bg-background">
      <EdHeader content={c.header} />
      <div className="grid px-gutter lg:grid-cols-12">
        <div className="pt-8 pb-10 lg:col-span-7 lg:border-r lg:border-foreground lg:pt-12 lg:pr-10 lg:pb-14">
          <p className={`${kicker} text-accent-text`}>{c.kicker}</p>
          <h1
            className={`${serif} mt-3 text-[calc(var(--ds-text-display)*1.25)] lg:text-[calc(var(--ds-text-display)*2.2)]`}
          >
            {c.title}
          </h1>
          <p className="mt-6 max-w-text text-lg first-letter:float-left first-letter:mr-2 first-letter:font-display first-letter:text-[3.6em] first-letter:leading-[0.8] first-letter:font-semibold first-letter:text-accent-text">
            {c.lead}
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            <a href={c.ctaHref} className={cta}>
              {c.cta}
            </a>
            <a
              href={c.altHref}
              className={`min-h-12 content-center text-base underline underline-offset-4 ${focus}`}
            >
              {c.alt}
            </a>
          </div>
          <dl className="mt-10 grid grid-cols-2 border-t border-foreground sm:grid-cols-4">
            {c.facts.map((f) => (
              <div
                key={f.label}
                className="border-foreground py-3 pr-3 sm:border-r sm:pl-3 sm:first:pl-0 sm:last:border-0"
              >
                <dt className="sr-only">{f.label}</dt>
                <dd className={`m-0 ${serif} text-[calc(var(--ds-text-display)*0.8)] tabular-nums`}>
                  {f.value}
                </dd>
                <dd className="m-0 mt-1 text-sm">{f.label}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="border-t border-foreground pt-6 pb-12 lg:col-span-5 lg:border-0 lg:pt-12 lg:pl-10">
          <h2 className={`${kicker}`}>{c.tocTitle}</h2>
          <ul className="mt-3 list-none p-0">
            {c.toc.map((r) => (
              <li key={r.name} className="border-b border-line py-2">
                <p className="m-0 flex items-baseline gap-2 text-base">
                  <span>{r.name}</span>
                  <span
                    aria-hidden="true"
                    className="flex-1 translate-y-[-0.25em] border-b border-dotted border-foreground"
                  />
                  <span className="font-semibold tabular-nums">{rub(r.price)}</span>
                </p>
                <p className="m-0 text-sm text-muted-foreground">
                  {r.term}
                  {r.plus ? `, ${r.plus}` : ""}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm">{c.tocNote}</p>
          <figure className="m-0 mt-8">
            <div className="aspect-[3/2] overflow-hidden">
              <Img photo={c.photo} className={bw} />
            </div>
            <figcaption className="mt-2 border-b border-foreground pb-2 text-sm italic">
              {c.caption}
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}

export type Fix = { wrong: string; right: string; note: string };

/** Content of redaktsiya.proof (the signature). */
export type EdProofContent = {
  anchor: string;
  kicker: string;
  title: string;
  lead: string;
  figure: { value: string; label: string };
  sheet: {
    head: string;
    /** Lines of the page: plain text, or a line with a correction `fix` (text before and after it). */
    lines: readonly ({ label: string; text: string } | { label: string; before?: string; fix: Fix })[];
    sign: string;
  };
};

/** «Вторая читка»: the red pencil strikes the translator's word, writes the right one and leaves a margin note. */
export function EdProof({ content: c }: BlockProps<EdProofContent>) {
  const still = useStill();
  let n = 0;
  const at = (i: number) => 0.5 + i * 1.1;
  const anim = (delay: number, from: Record<string, number>, to: Record<string, number>) =>
    still
      ? {}
      : {
          initial: from,
          whileInView: to,
          viewport: { once: true, amount: 0.5 },
          transition: { delay, duration: 0.45, ease: "easeOut" as const },
        };
  return (
    <section
      id={c.anchor}
      aria-labelledby={`${c.anchor}-h`}
      className="grid gap-10 border-t-4 border-double border-foreground px-gutter py-16 lg:grid-cols-12 lg:py-24"
    >
      <div className="lg:col-span-4">
        <p className={`${kicker} text-accent-text`}>{c.kicker}</p>
        <h2 id={`${c.anchor}-h`} className={`${h2} mt-3`}>
          {c.title}
        </h2>
        <p className="mt-5 max-w-text text-lg">{c.lead}</p>
        <p className="mt-8 border-t border-foreground pt-3">
          <span
            className={`${serif} block text-[calc(var(--ds-text-display)*1.2)] tabular-nums text-accent-text`}
          >
            {c.figure.value}
          </span>
          <span className="text-base">{c.figure.label}</span>
        </p>
      </div>
      <div className="bg-card p-5 shadow-md lg:col-span-8 lg:p-10">
        <p className={`${kicker} border-b border-foreground pb-3 text-muted-foreground`}>{c.sheet.head}</p>
        <ul className="m-0 list-none p-0">
          {c.sheet.lines.map((l) => {
            if (!("fix" in l))
              return (
                <li key={l.label} className="grid gap-x-6 border-b border-line py-3 md:grid-cols-[11rem_1fr]">
                  <span className="text-sm text-muted-foreground">{l.label}</span>
                  <span className="font-mono text-base">{l.text}</span>
                </li>
              );
            const i = n++;
            return (
              <li
                key={`${l.label}-${still}`}
                className="grid gap-x-6 border-b border-line py-3 md:grid-cols-[11rem_1fr_15rem]"
              >
                <span className="text-sm text-muted-foreground">{l.label}</span>
                <span className="font-mono text-base">
                  {l.before}
                  <span className="relative inline-block">
                    <span className="text-muted-foreground">{l.fix.wrong}</span>
                    <motion.span
                      aria-hidden="true"
                      className="absolute top-1/2 right-0 left-0 h-0.5 origin-left -rotate-3 bg-accent"
                      {...anim(at(i), { scaleX: 0 }, { scaleX: 1 })}
                    />
                  </span>{" "}
                  <motion.ins
                    className="font-display text-xl font-semibold text-accent-text italic no-underline"
                    {...anim(at(i) + 0.35, { opacity: 0, y: -6 }, { opacity: 1, y: 0 })}
                  >
                    {l.fix.right}
                  </motion.ins>
                </span>
                <motion.span
                  className="mt-2 border-l-2 border-accent pl-3 text-sm md:mt-0"
                  {...anim(at(i) + 0.6, { opacity: 0, x: 8 }, { opacity: 1, x: 0 })}
                >
                  {l.fix.note}
                </motion.span>
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-right font-display text-lg italic">{c.sheet.sign}</p>
      </div>
    </section>
  );
}

export type Lang = { name: string; doc: number; page: number; term: string };

/** Content of redaktsiya.prices. */
export type EdPricesContent = {
  anchor: string;
  title: string;
  lead: string;
  langs: readonly Lang[];
  heads: { lang: string; doc: string; page: string; term: string };
  notes: readonly string[];
};

/** Prices by language: a ruled table like a newspaper exchange-rate column, notes under it. */
export function EdPrices({ content: c }: BlockProps<EdPricesContent>) {
  return (
    <section
      id={c.anchor}
      aria-labelledby={`${c.anchor}-h`}
      className="grid gap-10 bg-surface-alt px-gutter py-16 lg:grid-cols-12 lg:py-24"
    >
      <div className="lg:col-span-4">
        <h2 id={`${c.anchor}-h`} className={h2}>
          {c.title}
        </h2>
        <p className="mt-5 max-w-text text-lg">{c.lead}</p>
      </div>
      <div className="lg:col-span-8">
        <table className="w-full border-collapse text-left text-base">
          <thead>
            <tr className="border-b-2 border-foreground text-sm">
              <th scope="col" className="py-2 pr-3 font-semibold">
                {c.heads.lang}
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-semibold">
                {c.heads.doc}
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-semibold">
                {c.heads.page}
              </th>
              <th scope="col" className="hidden py-2 text-right font-semibold sm:table-cell">
                {c.heads.term}
              </th>
            </tr>
          </thead>
          <tbody>
            {c.langs.map((l) => (
              <tr key={l.name} className="border-b border-line">
                <th scope="row" className={`py-3 pr-3 ${serif} text-2xl`}>
                  {l.name}
                </th>
                <td className="py-3 pr-3 text-right tabular-nums">{rub(l.doc)}</td>
                <td className="py-3 pr-3 text-right tabular-nums">{rub(l.page)}</td>
                <td className="hidden py-3 text-right sm:table-cell">{l.term}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="mt-6 list-none space-y-2 p-0 text-sm">
          {c.notes.map((n) => (
            <li key={n} className="border-l-2 border-foreground pl-3">
              {n}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Content of redaktsiya.steps. */
export type EdStepsContent = {
  anchor: string;
  title: string;
  items: readonly { title: string; text: string }[];
};

/** How it works: numbered columns split by vertical rules, big serif numerals. */
export function EdSteps({ content: c }: BlockProps<EdStepsContent>) {
  return (
    <section id={c.anchor} aria-labelledby={`${c.anchor}-h`} className="px-gutter py-16 lg:py-24">
      <h2 id={`${c.anchor}-h`} className={h2}>
        {c.title}
      </h2>
      <ol className="mt-10 grid list-none border-t border-foreground p-0 md:grid-cols-2 lg:grid-cols-4">
        {c.items.map((s, i) => (
          <li
            key={s.title}
            className="border-b border-line py-5 md:pr-6 lg:border-b-0 lg:border-r lg:border-foreground lg:pl-6 lg:first:pl-0 lg:last:border-r-0"
          >
            <span className={`${serif} block text-[calc(var(--ds-text-display)*1.2)] text-accent-text`}>
              {i + 1}
            </span>
            <h3 className="mt-3 text-lg font-semibold">{s.title}</h3>
            <p className="mt-2 text-base">{s.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Content of redaktsiya.people. */
export type EdPeopleContent = {
  anchor: string;
  quote: string;
  author: string;
  role: string;
  photo: Photo;
  bio: string;
  staffTitle: string;
  staff: readonly { lang: string; names: string }[];
};

/** The person behind the business: a pull quote in large serif, the portrait in black and white, the masthead. */
export function EdPeople({ content: c }: BlockProps<EdPeopleContent>) {
  return (
    <section
      id={c.anchor}
      aria-label={c.author}
      className="grid gap-10 border-t-4 border-double border-foreground px-gutter py-16 lg:grid-cols-12 lg:py-24"
    >
      <figure className="m-0 lg:col-span-4">
        <div className="aspect-[4/5] overflow-hidden">
          <Img photo={c.photo} className={bw} />
        </div>
        <figcaption className="mt-2 text-sm italic">
          {c.author}, {c.role}
        </figcaption>
      </figure>
      <div className="lg:col-span-8">
        <blockquote className="m-0">
          <p
            className={`${serif} text-[calc(var(--ds-text-display)*0.85)] lg:text-[calc(var(--ds-text-display)*1.15)]`}
          >
            <span className="text-accent-text">«</span>
            {c.quote}
            <span className="text-accent-text">»</span>
          </p>
        </blockquote>
        <p className="mt-6 max-w-text text-lg">{c.bio}</p>
        <h3 className={`${kicker} mt-10 border-b border-foreground pb-2`}>{c.staffTitle}</h3>
        <dl className="m-0 mt-2 grid gap-x-8 sm:grid-cols-2">
          {c.staff.map((s) => (
            <div
              key={s.lang}
              className="grid grid-cols-[7.5rem_1fr] gap-3 border-b border-line py-2 text-base"
            >
              <dt className="font-semibold">{s.lang}</dt>
              <dd className="m-0">{s.names}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/** Content of redaktsiya.reviews. */
export type EdReviewsContent = {
  anchor: string;
  title: string;
  rating: { value: string; source: string };
  items: readonly { name: string; doc: string; text: string }[];
};

/** Reviews as letters to the editor: three columns of text, the rating in the head. */
export function EdReviews({ content: c }: BlockProps<EdReviewsContent>) {
  return (
    <section
      id={c.anchor}
      aria-labelledby={`${c.anchor}-h`}
      className="bg-surface-alt px-gutter py-16 lg:py-24"
    >
      <div className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-foreground pb-4">
        <h2 id={`${c.anchor}-h`} className={h2}>
          {c.title}
        </h2>
        <p className="text-right">
          <span className={`${serif} text-[calc(var(--ds-text-display)*1.1)] tabular-nums`}>
            {c.rating.value}
          </span>
          <span className="block text-sm">{c.rating.source}</span>
        </p>
      </div>
      <ul className="mt-8 grid list-none gap-8 p-0 lg:grid-cols-3 lg:gap-0">
        {c.items.map((r) => (
          <li
            key={r.name}
            className="lg:border-r lg:border-foreground lg:px-8 lg:first:pl-0 lg:last:border-r-0"
          >
            <p className={`${kicker} text-accent-text`}>{r.doc}</p>
            <blockquote className="m-0 mt-3">
              <p className="text-lg">{r.text}</p>
            </blockquote>
            <p className="mt-3 font-display text-lg italic">{r.name}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Content of redaktsiya.contacts. */
export type EdContactsContent = {
  anchor: string;
  title: string;
  address: string;
  way: readonly string[];
  hours: readonly { who: string; time: string }[];
  cta: string;
  ctaHref: string;
  email: string;
  emailHref: string;
  photo: Photo;
  caption: string;
};

/** Address, the way in and hours (office and notary), a city photo with a caption. */
export function EdContacts({ content: c }: BlockProps<EdContactsContent>) {
  return (
    <section
      id={c.anchor}
      aria-labelledby={`${c.anchor}-h`}
      className="grid gap-10 px-gutter py-16 lg:grid-cols-12 lg:py-24"
    >
      <div className="lg:col-span-6">
        <h2 id={`${c.anchor}-h`} className={h2}>
          {c.title}
        </h2>
        <p className={`${serif} mt-6 text-3xl`}>{c.address}</p>
        <ul className="mt-4 list-none space-y-1 p-0 text-base">
          {c.way.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        <dl className="mt-8 max-w-md">
          {c.hours.map((h) => (
            <div key={h.who} className="flex justify-between gap-4 border-t border-foreground py-2 text-base">
              <dt>{h.who}</dt>
              <dd className="m-0 tabular-nums">{h.time}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-8 flex flex-wrap items-center gap-6">
          <a href={c.ctaHref} className={cta}>
            {c.cta}
          </a>
          <a href={c.emailHref} className={`min-h-12 content-center underline underline-offset-4 ${focus}`}>
            {c.email}
          </a>
        </div>
      </div>
      <figure className="m-0 lg:col-span-6">
        <div className="aspect-[4/3] overflow-hidden">
          <Img photo={c.photo} className={bw} />
        </div>
        <figcaption className="mt-2 text-sm italic">{c.caption}</figcaption>
      </figure>
    </section>
  );
}

/** Content of redaktsiya.footer. */
export type EdFooterContent = {
  name: string;
  logo?: ReactNode;
  legal: readonly string[];
  credits: readonly string[];
};

/** Footer: the nameplate small, legal lines, photo credits. */
export function EdFooter({ content: c }: BlockProps<EdFooterContent>) {
  return (
    <footer className="mx-gutter border-t-4 border-double border-foreground py-10">
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-4">{c.logo ?? <span className={`${serif} text-3xl`}>{c.name}</span>}</div>
        <ul className="m-0 list-none space-y-1 p-0 text-sm lg:col-span-8">
          {c.legal.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </div>
      <Credit list={c.credits} className="mt-6 text-muted-foreground" />
    </footer>
  );
}
