// @vitest-environment happy-dom
// a11y primitives Button/Badge/Field, states and wz attributes (ui-kit.yaml#a11y, #states, #wz_id).
import { createElement as h, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { forum } from "../demo/fixtures.js";
import { Badge, Button, ErrorState, Field, formatMoney, Loading, pluralRu, ru } from "../src/index.js";
import { click, flush, type Rendered, render, type } from "./helpers/dom.js";

let r: Rendered | undefined;
afterEach(() => {
  r?.unmount();
  r = undefined;
});

describe("Button", () => {
  test("wz attributes, default type=button, loading → disabled + aria-busy + spinner", async () => {
    const onClick = vi.fn();
    r = await render(h(Button, { variant: "primary", loading: true, onClick }, "Сохранить"), { app: forum });
    const b = r.$("wz-button") as HTMLButtonElement;
    expect(b.getAttribute("data-wz-component")).toBe("Button");
    expect(b.getAttribute("data-wz-id")).toMatch(/^demo:Button:\d+$/);
    expect(b.type).toBe("button");
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
    await click(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("href renders a link; testId suffixes data-testid; explicit wzId wins", async () => {
    r = await render(h(Button, { href: "/program", testId: "prog", wzId: "abcd1234:3" }, "Программа"), {
      app: forum,
    });
    const a = r.$("wz-button--prog");
    expect(a.tagName).toBe("A");
    expect(a.getAttribute("href")).toBe("/program");
    expect(a.getAttribute("data-wz-id")).toBe("abcd1234:3");
  });
});

describe("Badge", () => {
  test("text is always rendered with the tone as data attribute", async () => {
    r = await render(h(Badge, { tone: "bad", children: "Отклонено" }), { app: forum });
    expect(r.$("wz-badge").textContent).toBe("Отклонено");
    expect(r.$("wz-badge").getAttribute("data-tone")).toBe("bad");
  });
});

describe("Field", () => {
  test("visible label for the input, «обязательно» as text, hint and error via aria-describedby", async () => {
    r = await render(
      h(Field, {
        name: "email",
        label: "Email",
        type: "email",
        value: "x",
        onChange: () => {},
        required: true,
        hint: "Для билета",
        error: "Неверный email",
      }),
      { app: forum },
    );
    const input = r.q<HTMLInputElement>("input");
    const label = r.q<HTMLLabelElement>(`label[for="${input.id}"]`);
    expect(label.textContent).toContain("Email");
    expect(label.textContent).toContain(ru.field.required);
    expect(input.type).toBe("email");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(described).toHaveLength(2);
    expect(described.map((id) => r?.container.querySelector(`#${CSS.escape(id)}`)?.textContent)).toEqual([
      "Для билета",
      "Неверный email",
    ]);
    expect(input.id).toMatch(/^wz-demo:Field:\d+-email$/);
    expect(r.$("wz-field-email")).toBeTruthy();
  });

  test("enum ≤ 5 → radiogroup, > 5 → select; phone mask stores E.164; money parses decimal comma", async () => {
    const seen: Record<string, unknown> = {};
    function Form() {
      const [v, setV] = useState<Record<string, unknown>>({});
      const set = (k: string) => (x: unknown) => {
        seen[k] = x;
        setV((o) => ({ ...o, [k]: x }));
      };
      const opts = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `Вариант ${i}` }));
      return h(
        "div",
        null,
        h(Field, {
          name: "few",
          label: "Мало",
          type: "enum",
          value: v.few,
          onChange: set("few"),
          enumOptions: opts(3),
        }),
        h(Field, {
          name: "many",
          label: "Много",
          type: "enum",
          value: v.many,
          onChange: set("many"),
          enumOptions: opts(6),
        }),
        h(Field, { name: "phone", label: "Телефон", type: "phone", value: v.phone, onChange: set("phone") }),
        h(Field, { name: "price", label: "Цена", type: "money", value: v.price, onChange: set("price") }),
      );
    }
    r = await render(h(Form), { app: forum });
    expect(r.$("wz-field-few").querySelectorAll('input[type="radio"]')).toHaveLength(3);
    expect(r.$("wz-field-few").querySelector('[role="radiogroup"]')).toBeTruthy();
    expect(r.$("wz-field-many").querySelector("select")?.options).toHaveLength(7);
    const phone = r.$("wz-field-phone").querySelector("input") as HTMLInputElement;
    await type(phone, "8 900 123 45 10");
    expect(seen.phone).toBe("+79001234510");
    expect(phone.value).toBe("+7 (900) 123-45-10");
    const price = r.$("wz-field-price").querySelector("input") as HTMLInputElement;
    expect(price.getAttribute("inputmode")).toBe("decimal");
    await type(price, "600,5");
    expect(seen.price).toBe(600.5);
    expect(r.$("wz-field-price").textContent).toContain("₽");
  });

  test("readOnly shows «Только просмотр»", async () => {
    r = await render(
      h(Field, { name: "n", label: "Номер", type: "int", value: 5, onChange: () => {}, readOnly: true }),
      {
        app: forum,
      },
    );
    expect(r.container.textContent).toContain(ru.field.readOnly);
  });
});

describe("states", () => {
  test("loading skeleton is aria-busy and appears after 150 ms", async () => {
    r = await render(h(Loading), { app: forum });
    const s = r.$("wz-loading");
    expect(s.getAttribute("aria-busy")).toBe("true");
    expect(s.innerHTML).not.toContain("bar_");
    await flush(200);
    expect(s.children.length).toBeGreaterThan(1);
  });

  test("error: message + «Повторить»; 401 → login; 403 → «Нет доступа»", async () => {
    const retry = vi.fn();
    r = await render(
      h(ErrorState, { error: { code: "INTERNAL", message: "Сбой", status: 500 }, onRetry: retry }),
      {
        app: forum,
      },
    );
    expect(r.$("wz-error").getAttribute("role")).toBe("alert");
    await click(r.$("wz-error-retry"));
    expect(retry).toHaveBeenCalledOnce();
    await r.rerender(
      h(ErrorState, { error: { code: "FORBIDDEN", message: "x", status: 403 }, onRetry: retry }),
    );
    expect(r.$("wz-error").textContent).toBe(ru.states.forbidden);
    await r.rerender(
      h(ErrorState, { error: { code: "UNAUTHENTICATED", message: "x", status: 401 }, onLogin: () => {} }),
    );
    expect(r.$("wz-error").textContent).toContain(ru.states.unauthenticated);
    expect(r.$("wz-error-login")).toBeTruthy();
  });
});

describe("format", () => {
  test("RUB and plural via Intl ru-RU", () => {
    expect(formatMoney(9900).replace(/\s/g, " ")).toBe("9 900 ₽");
    const f = { one: "место", few: "места", many: "мест", other: "места" };
    expect([1, 2, 5, 21].map((n) => pluralRu(n, f))).toEqual(["место", "места", "мест", "место"]);
  });
});
