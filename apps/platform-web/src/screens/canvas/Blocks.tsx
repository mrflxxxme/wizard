// Content of the canvas blocks (B2-25): a recognisable picture of each module screen and landing section, drawn with
// SketchText so the sketch shows skeleton bars and the built system shows the words. Texts come from the plan; data
// rows are neutral samples (the frame says «пример данных»).
import { SketchText, Tag } from "@wizard/ui-kit/v2";
import type { ReactNode } from "react";
import { canvas } from "../../i18n/ru/canvas.js";
import s from "./Blocks.module.css";
import type { CanvasBlockModel } from "./model.js";

const T = SketchText;
const D = canvas.sampleData;
const B = canvas.blocks;

const str = (v: unknown, fallback = ""): string => (typeof v === "string" && v ? v : fallback);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function Head({ b, title }: { b: CanvasBlockModel; title?: string }): ReactNode {
  return (
    <div className={s.mh}>
      <h3 className={s.lbl}>{title ?? b.title}</h3>
      <Tags b={b} />
    </div>
  );
}

export function Tags({ b }: { b: CanvasBlockModel }): ReactNode {
  if (b.tags.length === 0) return null;
  return (
    <span className={s.tags}>
      {b.tags.map((t) => (
        <Tag
          key={`${t.kind}:${t.label}`}
          kind={t.kind}
          testId={t.kind === "goal" ? "canvas-tag-goal" : t.kind === "out" ? "canvas-tag-out" : "canvas-tag"}
          {...(t.note ? { note: t.note } : {})}
        >
          {t.label}
        </Tag>
      ))}
    </span>
  );
}

function Btn({ children, soft = false }: { children: ReactNode; soft?: boolean }): ReactNode {
  return <span className={`${s.btn} ${s.sf} ${soft ? s.soft : s.biz}`}>{children}</span>;
}

function Photo({ children }: { children?: ReactNode }): ReactNode {
  return (
    <span className={s.ph}>
      <span className={s.art} />
      {children}
    </span>
  );
}

function Nav({ b }: { b: CanvasBlockModel }): ReactNode {
  const links = list(b.data.links).slice(0, 3);
  const cta = str(b.data.cta);
  return (
    <div className={s.nav}>
      <span className={`${s.logo} ${s.sf} ${s.biz}`} />
      <span className={s.navName}>
        <T>{str(b.data.name, b.title)}</T>
      </span>
      <span className={s.links}>
        {links.map((l) => (
          <T key={l}>{l}</T>
        ))}
      </span>
      {cta && <Btn>{cta}</Btn>}
      <Tags b={b} />
    </div>
  );
}

function Hero({ b }: { b: CanvasBlockModel }): ReactNode {
  const cta = str(b.data.cta, B.cta);
  return (
    <>
      <Tags b={b} />
      <div className={s.hero} data-variant={str(b.data.variant)}>
        <div className={s.copy}>
          <h2 className={s.h}>
            <T lines>{str(b.data.title, b.title)}</T>
          </h2>
          <p className={s.p}>
            <T lines>{canvas.sampleData.features.join(". ")}.</T>
          </p>
          <Btn>{cta}</Btn>
        </div>
        <Photo>
          <span className={`${s.slot} ${s.sf} ${s.card}`}>
            <T className={s.k}>{D.nearest}</T>
            <T className={s.v}>{D.nearestAt}</T>
          </span>
        </Photo>
      </div>
    </>
  );
}

function Services({ b }: { b: CanvasBlockModel }): ReactNode {
  return (
    <>
      <Head b={b} title={str(b.data.title, b.title)} />
      <div className={s.svcList} data-variant={str(b.data.variant)}>
        {D.services.map((x) => (
          <div key={x.n} className={`${s.svc} ${s.sf}`}>
            <span className={s.svcN}>
              <T>{x.n}</T>
            </span>
            <span className={s.svcD}>
              <T>{x.d}</T>
            </span>
            <span className={s.svcP}>
              <T>{x.p}</T>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function Numbered({ b, items }: { b: CanvasBlockModel; items: readonly string[] }): ReactNode {
  return (
    <>
      <Head b={b} title={str(b.data.title, b.title)} />
      <ol className={s.steps} data-variant={str(b.data.variant)}>
        {items.map((x, i) => (
          <li key={x} className={`${s.stepItem} ${s.sf}`}>
            <span className={`${s.num} ${s.sf} ${s.biz}`}>{i + 1}</span>
            <T>{x}</T>
          </li>
        ))}
      </ol>
    </>
  );
}

function Cta({ b }: { b: CanvasBlockModel }): ReactNode {
  return (
    <div className={`${s.cta} ${s.sf} ${s.wash}`} data-variant={str(b.data.variant)}>
      <h3 className={s.ctaH}>
        <T lines>{str(b.data.title, b.title)}</T>
      </h3>
      <Btn>{str(b.data.cta, B.cta)}</Btn>
      <Tags b={b} />
    </div>
  );
}

function LeadForm({ b }: { b: CanvasBlockModel }): ReactNode {
  return (
    <>
      <Head b={b} title={str(b.data.title, b.title)} />
      <div className={s.form}>
        {[B.name, B.phone].map((f) => (
          <span key={f} className={`${s.field} ${s.sf} ${s.card}`}>
            <T>{f}</T>
          </span>
        ))}
        <Btn>{B.send}</Btn>
      </div>
    </>
  );
}

function Booking({ b }: { b: CanvasBlockModel }): ReactNode {
  const people = list(b.data.specialists);
  return (
    <>
      <Head b={b} />
      <div className={s.book}>
        <div className={s.row}>
          {D.days.map((d, i) => (
            <span key={d} className={`${s.day} ${s.sf} ${i === 0 ? s.on : ""}`}>
              <T>{d}</T>
            </span>
          ))}
        </div>
        {people.length > 0 && (
          <div className={s.row}>
            {people.map((p, i) => (
              <span key={p} className={`${s.pick} ${s.sf} ${i === 0 ? s.pickOn : ""}`}>
                <span className={`${s.av} ${s.sf}`}>{initials(p)}</span>
                <T>{p.split(" ")[0] ?? p}</T>
              </span>
            ))}
          </div>
        )}
        <div className={s.row}>
          {D.slots.map((t) => (
            <span key={t} className={`${s.sl} ${s.sf} ${t === "11:00" ? s.slOn : ""}`}>
              <T>{t}</T>
            </span>
          ))}
        </div>
        <Btn>{B.bookAt("11:00")}</Btn>
      </div>
    </>
  );
}

function Section({ b, items }: { b: CanvasBlockModel; items?: readonly string[] }): ReactNode {
  return (
    <>
      <Head b={b} title={str(b.data.title, b.title)} />
      {items ? (
        <div className={s.grid} data-variant={str(b.data.variant)}>
          {items.map((x) => (
            <span key={x} className={`${s.cell} ${s.sf}`}>
              <T>{x}</T>
            </span>
          ))}
        </div>
      ) : (
        <p className={s.p}>
          <T lines>{str(b.data.label)}</T>
        </p>
      )}
    </>
  );
}

const initials = (n: string) =>
  n
    .split(" ")
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2);

function ring(fill: number) {
  const off = (100 - Math.max(0, Math.min(100, fill))).toFixed(1);
  return (
    <svg className={s.ring} viewBox="0 0 48 48" aria-hidden="true">
      <circle className={s.tr} cx="24" cy="24" r="19" />
      <circle
        className={s.fg}
        cx="24"
        cy="24"
        r="19"
        pathLength="100"
        strokeDasharray="100"
        strokeDashoffset={off}
      />
    </svg>
  );
}

/** Sample values of the goal panel: percentages fill the ring, counts show a number on a calm ring. */
const SAMPLE_PERCENT = [78, 4, 37];
const SAMPLE_COUNT = [42, 18, 7];

function Goals({ b }: { b: CanvasBlockModel }): ReactNode {
  const metrics = (Array.isArray(b.data.metrics) ? b.data.metrics : []) as { label: string; unit: string }[];
  return (
    <>
      <Head b={b} />
      <div className={s.goals}>
        {metrics.map((m, i) => {
          const pct = m.unit === "percent";
          const v = (pct ? SAMPLE_PERCENT : SAMPLE_COUNT)[i % 3] ?? 0;
          return (
            <div key={m.label} className={`${s.g} ${s.sf}`}>
              <span className={s.gRing}>{ring(pct ? v : 66)}</span>
              <span className={s.gV}>
                <T>{pct ? `${v}%` : String(v)}</T>
              </span>
              <span className={s.gL}>
                <T>{m.label}</T>
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Schedule({ b }: { b: CanvasBlockModel }): ReactNode {
  const spec = str(b.data.specialist);
  const rem = b.data.reminders === true;
  return (
    <>
      <div className={s.mh}>
        <h3 className={s.lbl}>{b.title}</h3>
        <span className={s.k}>
          <T>{B.rows(D.clients.length)}</T>
        </span>
        <Tags b={b} />
      </div>
      <div className={s.tblWrap}>
        <table className={s.tbl}>
          <thead>
            <tr>
              <th>{B.time}</th>
              <th>{B.who}</th>
              <th className={s.wide}>{B.what}</th>
              {spec && <th className={s.wide}>{spec}</th>}
              {rem && <th>{B.status}</th>}
            </tr>
          </thead>
          <tbody>
            {D.clients.map((r, i) => (
              <tr key={r.t}>
                <td>
                  <T>{r.t}</T>
                </td>
                <td>
                  <T>{r.n}</T>
                </td>
                <td className={s.wide}>
                  <T>{r.s}</T>
                </td>
                {spec && (
                  <td className={s.wide}>
                    <T>{(D.people[i % D.people.length] ?? "").split(" ")[0] ?? ""}</T>
                  </td>
                )}
                {rem && (
                  <td>
                    <span className={`${s.st} ${s[r.st] ?? ""}`}>
                      <T>{r.l}</T>
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Client({ b }: { b: CanvasBlockModel }): ReactNode {
  return (
    <>
      <Head b={b} />
      <div className={`${s.cl} ${s.sf} ${s.card}`}>
        <div className={s.clHead}>
          <span className={`${s.clAv} ${s.sf} ${s.biz}`}>{initials(D.client)}</span>
          <span className={s.clWho}>
            <T>{D.client}</T>
            <T className={s.k}>{D.phone}</T>
          </span>
        </div>
        <dl className={s.dl}>
          <dt>{D.today}</dt>
          <dd>
            <T>{D.todayAt}</T>
          </dd>
          <dt>{D.last}</dt>
          <dd>
            <T>{D.lastAt}</T>
          </dd>
        </dl>
        <div className={s.row}>
          <Btn soft>{D.offer}</Btn>
          <span className={`${s.btn} ${s.sf}`}>{D.note}</span>
        </div>
      </div>
    </>
  );
}

function Leads({ b }: { b: CanvasBlockModel }): ReactNode {
  return (
    <>
      <Head b={b} />
      <ul className={s.plain}>
        {D.leads.map((l) => (
          <li key={l.n} className={`${s.lead} ${s.sf}`}>
            <T>{l.n}</T>
            <span className={s.k}>
              <T>{l.s}</T>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Deals({ b }: { b: CanvasBlockModel }): ReactNode {
  return (
    <>
      <Head b={b} />
      <div className={s.board}>
        {D.stages.map((st, i) => (
          <div key={st} className={`${s.col} ${s.sf}`}>
            <span className={s.k}>
              <T>{st}</T>
            </span>
            <span className={`${s.dealCard} ${s.sf} ${s.card}`}>
              <T>{D.leads[i]?.n ?? ""}</T>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function Staff({ b }: { b: CanvasBlockModel }): ReactNode {
  return (
    <>
      <Head b={b} />
      <ul className={s.plain}>
        {D.people.map((p) => (
          <li key={p} className={s.person}>
            <span className={`${s.av} ${s.sf}`}>{initials(p)}</span>
            <T>{p}</T>
          </li>
        ))}
      </ul>
    </>
  );
}

function ModuleBlock({ b }: { b: CanvasBlockModel }): ReactNode {
  return (
    <>
      <Head b={b} />
      <p className={s.p}>
        <T lines>{str(b.data.summary, b.title)}</T>
      </p>
    </>
  );
}

function Notifications({ b }: { b: CanvasBlockModel }): ReactNode {
  const ch = list(b.data.channels);
  const name = str(b.data.name);
  return (
    <div className={s.ntfs}>
      <Tags b={b} />
      {ch.includes("telegram") && (
        <div className={`${s.ntf} ${s.sf} ${s.card}`}>
          <span className={`${s.nIc} ${s.sf} ${s.biz}`} aria-hidden="true">
            ✈
          </span>
          <div>
            <div className={s.nH}>
              <T>{name}</T>
              <span className={s.nT}>Телеграм</span>
            </div>
            <p className={s.nP}>
              <T lines>{D.reminder(name)}</T>
            </p>
            <div className={s.row}>
              <span className={`${s.nB} ${s.sf} ${s.soft}`}>
                <T>{D.yes}</T>
              </span>
              <span className={`${s.nB} ${s.sf}`}>
                <T>{D.move}</T>
              </span>
            </div>
          </div>
        </div>
      )}
      {(ch.includes("email") || ch.length === 0) && (
        <div className={`${s.ntf} ${s.sf} ${s.card}`}>
          <span className={`${s.nIc} ${s.sf}`} aria-hidden="true">
            @
          </span>
          <div>
            <div className={s.nH}>
              <T>Почта</T>
              <span className={s.nT}>письмо</span>
            </div>
            <p className={s.nP}>
              <T lines>{D.mail}</T>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function Mobile({ b }: { b: CanvasBlockModel }): ReactNode {
  return (
    <div className={`${s.mSite} ${s.sf} ${s.card}`}>
      <div className={s.mNav}>
        <span className={`${s.logo} ${s.sf} ${s.biz}`} />
        <T>{str(b.data.name)}</T>
      </div>
      <h4 className={s.mH}>
        <T lines>{canvas.sampleData.features[0] ?? ""}</T>
      </h4>
      {b.data.booking === true && (
        <div className={s.row}>
          {D.slots.slice(0, 4).map((t) => (
            <span key={t} className={`${s.sl} ${s.sf} ${t === "11:00" ? s.slOn : ""}`}>
              <T>{t}</T>
            </span>
          ))}
        </div>
      )}
      <Btn>{B.cta}</Btn>
    </div>
  );
}

/** Body of one canvas block by its kind. */
export function BlockBody({ b }: { b: CanvasBlockModel }): ReactNode {
  switch (b.kind) {
    case "nav":
      return <Nav b={b} />;
    case "hero":
      return <Hero b={b} />;
    case "services":
      return <Services b={b} />;
    case "steps":
      return <Numbered b={b} items={D.steps} />;
    case "features":
      return <Section b={b} items={D.features} />;
    case "faq":
      return <Section b={b} items={D.faq} />;
    case "cta":
      return <Cta b={b} />;
    case "lead_form":
      return <LeadForm b={b} />;
    case "booking":
      return <Booking b={b} />;
    case "goals":
      return <Goals b={b} />;
    case "schedule":
      return <Schedule b={b} />;
    case "client":
      return <Client b={b} />;
    case "leads":
      return <Leads b={b} />;
    case "deals":
      return <Deals b={b} />;
    case "staff":
      return <Staff b={b} />;
    case "notifications":
      return <Notifications b={b} />;
    case "mobile":
      return <Mobile b={b} />;
    case "module":
      return <ModuleBlock b={b} />;
    default:
      return <Section b={b} />;
  }
}
