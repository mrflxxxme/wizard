// @vitest-environment happy-dom
// V3-09 «Три направления» chat card: three live first screens in sandboxed srcdoc frames, «Выбрать», «Что поменять?»
// with example words, «Решите за меня», «Другие варианты», the desktop/phone view and the optional logo and references
// block; a viewer only looks; API errors are shown in Russian. The API is a double: no network.
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "../src/api/client.js";
import type { DirectionsApi, DirectionsProposalView } from "../src/v3/directions/api.js";
import { DIRECTIONS_UPLOAD_MAX, DirectionsCard } from "../src/v3/directions/DirectionsCard.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SYS = "33333333-3333-4333-8333-333333333333";
const NAMES = ["Тёплый ремесленный", "Редакционный", "Швейцарская сетка"];

function proposal(id: string, tuning: string[] = [], picked: number | null = null): DirectionsProposalView {
  return {
    id: id.padEnd(64, "0"),
    briefVersion: 1,
    createdAt: "2026-10-09T09:00:00.000Z",
    costRub: 0.5,
    fallback: false,
    references: [],
    picked,
    directions: NAMES.map((name, i) => ({
      n: i + 1,
      archetype: ["warm_craft", "editorial", "swiss"][i] as string,
      name,
      why: "Почему это направление подходит бизнесу.",
      texts: { title: "Запись на приём с сайта", lead: "Выберите услугу и время.", action: "Записаться" },
      textsSource: "model",
      tuning,
      header: "header-classic",
      hero: "hero-split",
      fonts: { display: "Literata", text: "Commissioner" },
      palette: { background: "#FBFBFA", foreground: "#1C1B1A", accent: "#B5541B" },
      previewHtml: `<!doctype html><html lang="ru"><body><h1>Направление ${i + 1}</h1></body></html>`,
    })),
  };
}

function fakeApi(first: DirectionsProposalView | null = null) {
  const calls: unknown[][] = [];
  let current = first;
  const api: DirectionsApi = {
    get: async () => current,
    propose: async (...a) => {
      calls.push(["propose", ...a]);
      current = proposal("a1");
      return current;
    },
    refine: async (...a) => {
      calls.push(["refine", ...a]);
      if (a[2] === "беру второй")
        return {
          proposal: proposal("a1", [], 2),
          kind: "pick",
          changed: [],
          reply: "Выбран второй вариант.",
        };
      current = proposal("b2", ["теплее"]);
      return { proposal: current, kind: "tuned", changed: [1, 2, 3], reply: "Все три варианта: теплее." };
    },
    pick: async (...a) => {
      calls.push(["pick", ...a]);
      return { archetype: a[2] === null ? "warm_craft" : "editorial", pinned: a[2] !== null };
    },
    addUrl: async (...a) => {
      calls.push(["addUrl", ...a]);
      return { reference: "Сайт example.ru: ритм просторный.", read: true };
    },
    upload: async (...a) => {
      calls.push(["upload", a[0], a[1]]);
      return { reference: "Логотип: фирменный цвет #B5541B." };
    },
  };
  return { api, calls };
}

let container: HTMLDivElement;
let root: Root;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

async function render(props: Parameters<typeof DirectionsCard>[0]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(h(DirectionsCard, props)));
  await act(async () => {});
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  container.querySelector<T>(`[data-testid="${id}"]`);
const click = async (el: HTMLElement | null) => {
  if (!el) throw new Error("no element");
  await act(async () => el.click());
};
async function type(el: HTMLElement | null, value: string) {
  if (!el) throw new Error("no field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function chooseFile(el: HTMLInputElement | null, file: File) {
  if (!el) throw new Error("no input");
  await act(async () => {
    Object.defineProperty(el, "files", { value: [file], configurable: true });
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

test("no directions yet → «Показать три направления» → three live first screens in sandboxed srcdoc frames", async () => {
  const { api, calls } = fakeApi();
  await render({ systemId: SYS, api });
  expect(container.querySelector("h2")?.textContent).toBe("Три направления оформления");
  await click($("directions-propose"));
  expect(calls).toEqual([["propose", SYS, false]]);
  const cards = [1, 2, 3].map((n) => $(`direction-${n}`));
  expect(cards.every(Boolean)).toBe(true);
  for (const [i, card] of cards.entries()) {
    expect(card?.querySelector("h3")?.textContent).toBe(`${i + 1}. ${NAMES[i]}`);
    const frame = card?.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain(`Направление ${i + 1}`);
    expect(frame.getAttribute("title")).toBe(`Первый экран, направление ${i + 1}: ${NAMES[i]}`);
    expect(card?.textContent).toContain("Шрифты: Literata и Commissioner");
  }
});

test("«Что поменять?»: the owner's words and the example chips go to refine; the reply is announced", async () => {
  const { api, calls } = fakeApi(proposal("a1"));
  await render({ systemId: SYS, api });
  await type($("directions-refine-input"), "теплее");
  await click($("directions-refine-send"));
  expect(calls[0]).toEqual(["refine", SYS, "a1".padEnd(64, "0"), "теплее"]);
  const reply = $("directions-reply");
  expect(reply?.getAttribute("aria-live")).toBe("polite");
  expect(reply?.textContent).toBe("Все три варианта: теплее.");
  expect(($("directions-refine-input") as HTMLInputElement).value).toBe("");
  expect($("direction-1")?.textContent).toContain("Ваши пожелания: теплее");
  const chip = [...container.querySelectorAll("button")].find((b) => b.textContent === "без фото");
  await click(chip ?? null);
  expect(calls[1]).toEqual(["refine", SYS, "b2".padEnd(64, "0"), "без фото"]);
});

test("«Выбрать», «Решите за меня» and «беру второй» save the choice; «Другие варианты» proposes again", async () => {
  const { api, calls } = fakeApi(proposal("a1"));
  const onPicked = vi.fn();
  await render({ systemId: SYS, api, onPicked });
  await click($("direction-pick-2"));
  expect(calls.at(-1)).toEqual(["pick", SYS, "a1".padEnd(64, "0"), 2]);
  expect($("direction-pick-2")?.getAttribute("aria-pressed")).toBe("true");
  expect($("direction-pick-2")?.textContent).toContain("Выбрано");
  expect($("directions-reply")?.textContent).toContain("Редакционный");
  expect(onPicked).toHaveBeenLastCalledWith({ archetype: "editorial", pinned: true });
  await click($("directions-skip"));
  expect(calls.at(-1)).toEqual(["pick", SYS, "a1".padEnd(64, "0"), null]);
  expect($("directions-reply")?.textContent).toBe("Направление выберет система при сборке.");
  await type($("directions-refine-input"), "беру второй");
  await click($("directions-refine-send"));
  expect($("direction-pick-2")?.getAttribute("aria-pressed")).toBe("true");
  await click($("directions-reroll"));
  expect(calls.at(-1)).toEqual(["propose", SYS, true]);
});

test("desktop / phone view renders the frame at 1280 or 390 px, scaled into the card", async () => {
  const { api } = fakeApi(proposal("a1"));
  await render({ systemId: SYS, api });
  await click($("directions-view-desktop"));
  const frame = () => $("direction-preview-1") as HTMLIFrameElement;
  expect(frame().style.width).toBe("1280px");
  expect($("directions-view-desktop")?.getAttribute("aria-pressed")).toBe("true");
  await click($("directions-view-phone"));
  expect(frame().style.width).toBe("390px");
  expect(frame().style.transform).toMatch(/^scale\(/);
  expect(container.querySelector("legend")?.textContent).toBe("Как показать");
});

test("logo, screenshot and a link: size and type checked before upload; principles listed; refresh offered", async () => {
  const { api, calls } = fakeApi(proposal("a1"));
  await render({ systemId: SYS, api });
  const big = new File([new Uint8Array(DIRECTIONS_UPLOAD_MAX + 1)], "big.png", { type: "image/png" });
  await chooseFile($("directions-logo") as HTMLInputElement, big);
  expect(
    container.querySelector('[data-testid="directions-references"] [role="alert"]')?.textContent,
  ).toMatch(/2 МБ/);
  const jpg = new File([new Uint8Array(10)], "photo.jpg", { type: "image/jpeg" });
  await chooseFile($("directions-screenshot") as HTMLInputElement, jpg);
  expect(
    container.querySelector('[data-testid="directions-references"] [role="alert"]')?.textContent,
  ).toMatch(/PNG/);
  expect(calls).toEqual([]);
  const logo = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "Логотип Иванова.png", {
    type: "image/png",
  });
  await chooseFile($("directions-logo") as HTMLInputElement, logo);
  expect(calls.at(-1)).toEqual(["upload", SYS, "logo"]);
  expect($("directions-references")?.textContent).toContain("Учли: Логотип: фирменный цвет #B5541B.");
  await type($("directions-url"), "https://example.ru");
  await click($("directions-url-add"));
  expect(calls.at(-1)).toEqual(["addUrl", SYS, "https://example.ru"]);
  await click($("directions-refresh"));
  expect(calls.at(-1)).toEqual(["propose", SYS, false]);
});

test("a viewer only looks; an API error is shown in Russian", async () => {
  const { api } = fakeApi(proposal("a1"));
  await render({ systemId: SYS, api, editable: false });
  expect($("direction-1")).not.toBeNull();
  expect($("direction-pick-1")).toBeNull();
  expect($("directions-refine-input")).toBeNull();
  expect($("directions-references")).toBeNull();
  act(() => root.unmount());
  container.remove();
  const failing: DirectionsApi = {
    ...fakeApi().api,
    propose: async () => {
      throw new ApiError(400, { code: "VALIDATION_FAILED", message_ru: "Сначала нужен бриф системы" });
    },
  };
  await render({ systemId: SYS, api: failing });
  await click($("directions-propose"));
  expect($("directions-error")?.textContent).toBe("Сначала нужен бриф системы");
  expect($("directions-error")?.getAttribute("role")).toBe("alert");
});
