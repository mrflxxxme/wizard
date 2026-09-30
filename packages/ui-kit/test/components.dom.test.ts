// @vitest-environment happy-dom
// vitest+DOM acceptance of M0 components (ui-kit.yaml#components.*.acceptance) on the memory DataSource.
import jsQR from "jsqr";
import { createElement as h, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { forum, forumFixture } from "../demo/fixtures.js";
import { unwrapDefault } from "../src/components/QrScanner.js";
import {
  ConsentCheckbox,
  ItemCard,
  type OptionGroup,
  QrTicket,
  RecordForm,
  StatsReport,
  toRoleSpec,
} from "../src/index.js";
import { qrMatrix, qrPath } from "../src/qr/encode.js";
import { createMemoryDataSource } from "../src/testing/index.js";
import { click, flush, type Rendered, render, type } from "./helpers/dom.js";

let r: Rendered | undefined;
afterEach(() => {
  r?.unmount();
  r = undefined;
});
const text = (el: Element) => (el.textContent ?? "").replace(/\s/g, " ");
const ds = (userId: string | null) => {
  const f = forumFixture();
  return createMemoryDataSource(forum, f.rows, { users: f.users, functions: f.functions, userId });
};

describe("ItemCard", () => {
  test("remaining 18 → «Осталось 18 мест», 1 → «Осталось 1 место», 0 → CTA disabled «Мест нет»", async () => {
    const card = (remaining: number) =>
      h(ItemCard, { id: "t", title: "Билет", price: 9900, remaining, onCta: () => {} });
    r = await render(card(18), { app: forum });
    expect(text(r.$("wz-itemcard-remaining"))).toBe("Осталось 18 мест");
    expect(text(r.$("wz-itemcard-price"))).toBe("9 900 ₽");
    await r.rerender(card(1));
    expect(text(r.$("wz-itemcard-remaining"))).toBe("Осталось 1 место");
    expect((r.$("wz-itemcard-cta") as HTMLButtonElement).disabled).toBe(false);
    await r.rerender(card(0));
    expect(text(r.$("wz-itemcard-remaining"))).toBe("Мест нет");
    expect((r.$("wz-itemcard-cta") as HTMLButtonElement).disabled).toBe(true);
    await r.rerender(card(40));
    expect(r.$$("wz-itemcard-remaining")).toHaveLength(0);
  });

  test("single option group never has two selected choices; multi toggles; delta «+600 ₽»", async () => {
    const groups: OptionGroup[] = [
      {
        id: "w",
        label: "Вес",
        kind: "single",
        choices: [
          { id: "a", label: "1 кг" },
          { id: "b", label: "2 кг", priceDelta: 600 },
        ],
      },
      {
        id: "d",
        label: "Декор",
        kind: "multi",
        choices: [
          { id: "x", label: "Ягоды" },
          { id: "y", label: "Цветы" },
        ],
      },
    ];
    r = await render(
      h(ItemCard, { id: "c", title: "Торт", price: 4900, optionGroups: groups, onCta: () => {} }),
      {
        app: forum,
      },
    );
    const checked = (g: string) =>
      [...(r?.container.querySelectorAll(`[data-testid^="wz-itemcard-option-${g}-"]`) ?? [])].filter(
        (e) => e.getAttribute("aria-checked") === "true",
      ).length;
    await click(r.$("wz-itemcard-option-w-a"));
    await click(r.$("wz-itemcard-option-w-b"));
    expect(checked("w")).toBe(1);
    expect(r.$("wz-itemcard-option-w-b").getAttribute("role")).toBe("radio");
    expect(text(r.$("wz-itemcard-option-w-b"))).toContain("+600 ₽");
    await click(r.$("wz-itemcard-option-d-x"));
    await click(r.$("wz-itemcard-option-d-y"));
    expect(checked("d")).toBe(2);
    expect(text(r.container)).toContain("5 500 ₽");
  });
});

describe("ConsentCheckbox", () => {
  test("unchecked by default, click → onChange(true), text and link from RoleSpec, error → aria-invalid", async () => {
    const onChange = vi.fn();
    const spec = toRoleSpec(forum, "participant");
    r = await render(h(ConsentCheckbox, { checked: false, onChange }), { spec });
    const box = r.q<HTMLInputElement>('[data-testid="wz-consent"] input[type="checkbox"]');
    expect(box.checked).toBe(false);
    expect(text(r.$("wz-consent"))).toContain(spec.compliance?.consentText ?? "–");
    const link = r.$("wz-consent-policy-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/privacy");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener");
    await click(box);
    expect(onChange).toHaveBeenCalledWith(true);
    await r.rerender(h(ConsentCheckbox, { checked: false, onChange, error: "Нужно согласие" }));
    const b2 = r.q<HTMLInputElement>('[data-testid="wz-consent"] input');
    expect(b2.getAttribute("aria-invalid")).toBe("true");
    expect(
      r.container.querySelector(`#${CSS.escape(b2.getAttribute("aria-describedby") ?? "")}`)?.textContent,
    ).toBe("Нужно согласие");
  });

  test("never checks itself: re-render with checked=false keeps it unchecked after a click", async () => {
    r = await render(h(ConsentCheckbox, { checked: false, onChange: () => {} }), {
      app: forum,
      role: "participant",
    });
    const box = r.q<HTMLInputElement>('[data-testid="wz-consent"] input');
    await click(box);
    expect(box.checked).toBe(false);
  });
});

describe("StatsReport", () => {
  test("4 KPI and 3 bars from the fixture; money 4100000 → «4,1 млн ₽»; value/total «370 / 600»", async () => {
    const data = forumFixture().functions?.forumStats?.({}, { user: null, ds: ds(null) }) as never;
    r = await render(h(StatsReport, { data }), { app: forum });
    expect(r.container.querySelectorAll('[data-testid^="wz-stats-kpi-"]')).toHaveLength(4);
    expect(r.$$("wz-stats-bar")).toHaveLength(3);
    expect(text(r.$("wz-stats-kpi-revenue"))).toContain("4,1 млн ₽");
    expect(text(r.$("wz-stats-kpi-registered"))).toContain("370 / 600");
    const meter = r.$$("wz-stats-bar")[0]?.querySelector('[role="meter"]');
    expect(meter?.getAttribute("aria-valuenow")).toBe("156");
    expect(meter?.getAttribute("aria-valuemax")).toBe("200");
    expect(text(r.$$("wz-stats-bar")[0] as HTMLElement)).toContain("156/200");
  });

  test("fn → query function through DataSource.useFn", async () => {
    r = await render(h(StatsReport, { fn: "forumStats", title: "Сводка" }), {
      app: forum,
      role: "organizer",
      ds: ds("u_organizer"),
    });
    expect(r.container.querySelectorAll('[data-testid^="wz-stats-kpi-"]')).toHaveLength(4);
  });
});

describe("RecordForm", () => {
  test("entity without pii fields → no consent checkbox", async () => {
    const d = ds("u_moderator");
    r = await render(h(RecordForm, { entity: "session", fields: ["title", "room"] }), {
      app: forum,
      role: "moderator",
      ds: d,
    });
    expect(r.$("wz-recordform")).toBeTruthy();
    expect(r.$$("wz-consent--recordform")).toHaveLength(0);
  });

  test("pii entity: submit without consent → error and 0 create calls; with consent → create(opts.consent)", async () => {
    const d = ds("u_speaker");
    r = await render(h(RecordForm, { entity: "speaker_application" }), {
      app: forum,
      role: "speaker",
      ds: d,
    });
    const input = (name: string) =>
      r?.$(`wz-field-${name}`).querySelector("input, textarea") as HTMLInputElement;
    await type(input("full_name"), "Мария Ким");
    await type(input("email"), "maria@demo.example");
    await type(input("topic"), "Склад");
    await type(input("abstract"), "Кейс");
    await click(r.$("wz-recordform-submit"));
    const box = r.q<HTMLInputElement>('[data-testid="wz-consent--recordform"] input');
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(text(r.$("wz-consent--recordform"))).toContain("Нужно согласие на обработку персональных данных");
    expect(d.calls.filter((c) => c.op === "create")).toHaveLength(0);
    await click(box);
    await click(r.$("wz-recordform-submit"));
    await flush();
    const creates = d.calls.filter((c) => c.op === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.args[1]).toEqual({ consent: true });
    expect(d.rows("speaker_application").at(-1)?.speaker_user).toBe("u_speaker");
  });

  test("server VALIDATION_FAILED details.fields → error under the field", async () => {
    const d = ds("u_speaker");
    d.failNext("create", {
      code: "VALIDATION_FAILED",
      message: "Проверьте заполнение полей",
      status: 422,
      fields: [{ field: "email", code: "TAKEN", message: "Этот email уже подал заявку" }],
    });
    r = await render(
      h(RecordForm, { entity: "speaker_application", fields: ["full_name", "email", "topic", "abstract"] }),
      {
        app: forum,
        role: "speaker",
        ds: d,
      },
    );
    const input = (name: string) =>
      r?.$(`wz-field-${name}`).querySelector("input, textarea") as HTMLInputElement;
    await type(input("full_name"), "Мария Ким");
    await type(input("email"), "maria@demo.example");
    await type(input("topic"), "Склад");
    await type(input("abstract"), "Кейс");
    await click(r.q('[data-testid="wz-consent--recordform"] input'));
    await click(r.$("wz-recordform-submit"));
    await flush();
    expect(text(r.$("wz-field-email"))).toContain("Этот email уже подал заявку");
    expect(input("email").getAttribute("aria-invalid")).toBe("true");
    expect(r.$$("wz-recordform-error")).toHaveLength(0);
  });

  test("client validation: required and email format block the submit", async () => {
    const d = ds("u_speaker");
    function Wrap() {
      const [ok, setOk] = useState(false);
      return h(
        "div",
        null,
        h(RecordForm, { entity: "speaker_application", onSuccess: () => setOk(true) }),
        ok ? "ok" : "",
      );
    }
    r = await render(h(Wrap), { app: forum, role: "speaker", ds: d });
    const email = r.$("wz-field-email").querySelector("input") as HTMLInputElement;
    await type(email, "nope");
    await click(r.$("wz-recordform-submit"));
    expect(text(r.$("wz-field-full_name"))).toContain("Заполните поле");
    expect(text(r.$("wz-field-email"))).toContain("Введите email");
    expect(d.calls).toHaveLength(0);
  });
});

describe("QrTicket", () => {
  /** Rasterizes the SVG path (module units) into RGBA and decodes it with jsQR. */
  function decodeSvg(svg: SVGSVGElement): string | null {
    const size = Number(svg.getAttribute("viewBox")?.split(" ")[2]);
    const d = svg.querySelector("path")?.getAttribute("d") ?? "";
    const scale = 6;
    const px = size * scale;
    const data = new Uint8ClampedArray(px * px * 4).fill(255);
    for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
      for (let yy = y * scale; yy < (y + 1) * scale; yy++)
        for (let xx = x * scale; xx < (x + w) * scale; xx++) {
          const i = (yy * px + xx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
    }
    const decode =
      unwrapDefault<(d: Uint8ClampedArray, w: number, h: number) => { data: string } | null>(jsQR);
    return decode(data, px, px)?.data ?? null;
  }

  test("SVG decodes (jsQR) back to the stored token; the token text is not shown; white background", async () => {
    const d = ds("u_participant");
    const token = String(d.rows("ticket").find((t) => t.id === "ticket_001")?.qr_token);
    r = await render(
      h(QrTicket, {
        entity: "ticket",
        id: "ticket_001",
        tokenField: "qr_token",
        title: "Билет",
        hint: "Вход А",
      }),
      { app: forum, role: "participant", ds: d },
    );
    const svg = r.q<SVGSVGElement>('[data-testid="wz-qrticket-code"]');
    expect(decodeSvg(svg)).toBe(token);
    expect(r.container.textContent).not.toContain(token);
    expect(svg.querySelector("rect")?.getAttribute("fill")).toBe("#FFFFFF");
    expect(svg.querySelector("path")?.getAttribute("fill")).toBe("#000000");
  });

  test("quiet zone of 4 modules and level M matrix", () => {
    const m = qrMatrix("wzqr.v1.ticket_001.abc");
    const d = qrPath(m, 4);
    const xs = [...d.matchAll(/M(\d+) (\d+)/g)].flatMap((x) => [Number(x[1]), Number(x[2])]);
    expect(Math.min(...xs)).toBe(4);
    expect(m.length % 4).toBe(1); // 21 + 4k modules
  });
});
