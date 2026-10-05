// @vitest-environment happy-dom
// M2-43 / M2-47 (vitest+DOM): LeadForm over createMemoryDataSource — no create without consent, then create with
// {consent: true}; a role without create sees the form as unavailable; Image builds srcset from the runtime variants
// and needs alt; RecordForm maps image fields to ImageField; Footer links the personal data policy.
import { createElement as h } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { studio, studioFixture } from "../demo/fixtures.js";
import { Footer, Hero, Image, LeadForm, RecordForm, sdkDataSource, toRoleSpec } from "../src/index.js";
import { createMemoryDataSource } from "../src/testing/index.js";
import { click, type Rendered, render, type } from "./helpers/dom.js";

let r: Rendered | undefined;
afterEach(() => r?.unmount());

function ds(userId: string | null = null) {
  const f = studioFixture();
  return createMemoryDataSource(studio, f.rows, { users: f.users, userId });
}

describe("LeadForm", () => {
  test("public role: consent required; without it 0 creates; with it create(values, {consent: true}) and success", async () => {
    const d = ds();
    r = await render(h(LeadForm, { entity: "lead", fields: ["name", "phone"] }), {
      app: studio,
      role: "visitor",
      ds: d,
    });
    const consent = r.$("wz-consent--leadform");
    expect((consent.querySelector("input") as HTMLInputElement).checked).toBe(false);
    await type(r.$("wz-field-name").querySelector("input") as HTMLInputElement, "Мария");
    await type(r.$("wz-field-phone").querySelector("input") as HTMLInputElement, "9005554433");
    await click(r.$("wz-leadform-submit"));
    expect(d.calls.filter((c) => c.op === "create")).toHaveLength(0);
    expect(consent.textContent).toContain("Нужно согласие");
    await click(consent.querySelector("input") as HTMLInputElement);
    await click(r.$("wz-leadform-submit"));
    const creates = d.calls.filter((c) => c.op === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.args[1]).toEqual({ consent: true });
    expect(r.$("wz-leadform-success").textContent).toContain("Заявка отправлена");
    expect(r.$("wz-leadform").getAttribute("id")).toBe("lead");
    expect(r.$("wz-leadform").getAttribute("aria-labelledby")).toBeTruthy();
  });

  test("a role without create on the entity sees «Форма заявки сейчас недоступна»", async () => {
    r = await render(h(LeadForm, { entity: "service" }), { app: studio, role: "visitor", ds: ds() });
    expect(r.$("wz-leadform-unavailable").textContent).toBe("Форма заявки сейчас недоступна");
  });
});

describe("Image", () => {
  test("fileId → srcset of /api/files/:id/img/480|960|1600, lazy, async decoding, alt", async () => {
    r = await render(h(Image, { fileId: "f1", alt: "Фото зала" }), {
      app: studio,
      role: "visitor",
      ds: sdkDataSource(),
    });
    const img = r.$("wz-image-img") as HTMLImageElement;
    expect(img.getAttribute("srcset")).toBe(
      "/api/files/f1/img/480 480w, /api/files/f1/img/960 960w, /api/files/f1/img/1600 1600w",
    );
    expect(img.getAttribute("src")).toBe("/api/files/f1/img/960");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
    expect(img.getAttribute("alt")).toBe("Фото зала");
    expect(r.$("wz-image").getAttribute("data-wz-component")).toBe("Image");
  });

  test("no alt → an error in the console; decorative → empty alt without error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    r = await render(h(Image, { src: "/a.webp", alt: "" }), { app: studio, role: "visitor", ds: ds() });
    expect(err.mock.calls.flat().join(" ")).toContain("Image: нужен alt");
    r.unmount();
    err.mockClear();
    r = await render(h(Image, { src: "/a.webp", alt: "", decorative: true }), {
      app: studio,
      role: "visitor",
      ds: ds(),
    });
    expect(err).not.toHaveBeenCalled();
    expect(r.$("wz-image-img").getAttribute("alt")).toBe("");
    err.mockRestore();
  });

  test("Hero: the only h1 of the page; the picture of the first screen loads eagerly", async () => {
    r = await render(
      h(Hero, {
        title: "Пример",
        image: { fileId: "f2", alt: "Пример" },
        primary: { label: "Записаться", href: "#lead" },
      }),
      { app: studio, role: "visitor", ds: sdkDataSource() },
    );
    expect(r.container.querySelectorAll("h1")).toHaveLength(1);
    expect(r.$("wz-image-img").getAttribute("loading")).toBe("eager");
    expect(r.$("wz-hero-primary").getAttribute("href")).toBe("#lead");
  });
});

describe("forms and footer", () => {
  test("RecordForm renders an image field through ImageField (owner)", async () => {
    r = await render(h(RecordForm, { entity: "service" }), { app: studio, role: "owner", ds: ds("u_owner") });
    expect(r.$("wz-imagefield-photo-input").getAttribute("accept")).toBe("image/jpeg,image/png,image/webp");
  });

  test("Footer links the personal data policy when the system collects personal data", async () => {
    const spec = toRoleSpec(studio, "visitor");
    r = await render(h(Footer, { brand: "Пример", legal: "Пример: ИП" }), { spec, ds: ds() });
    expect(r.$("wz-footer-policy").getAttribute("href")).toBe("/privacy");
    expect(r.$("wz-footer").tagName).toBe("FOOTER");
  });
});
