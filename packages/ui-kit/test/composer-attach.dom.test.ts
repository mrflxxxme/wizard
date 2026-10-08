// @vitest-environment happy-dom
// V3-04 acceptance (DOM): «Приложить ТЗ» in the Composer — the paperclip opens the file dialog (docx, pdf, md, txt),
// files over 10 МБ or of another type are refused in Russian before any upload, the upload state and the server's
// error are shown under the row; without the `attach` prop the Composer is exactly as before.
import { act, createElement as h, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { COMPOSER_ATTACH_MAX_BYTES, Composer, type ComposerProps } from "../src/v2/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(el: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(el));
  const $ = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  return { container, $, rerender: (n: ReactNode) => act(async () => root.render(n)) };
}

/** Chooses a file in the hidden input as the dialog would. */
async function choose(input: HTMLElement | null, file: File) {
  const el = input as HTMLInputElement;
  Object.defineProperty(el, "files", { value: [file], configurable: true });
  await act(async () => void el.dispatchEvent(new Event("change", { bubbles: true })));
}

const base: ComposerProps = { value: "", onChange: () => {}, onSubmit: () => {} };

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("Composer: «Приложить ТЗ»", () => {
  test("without attach: no paperclip, no file input, no status line — the row as before", async () => {
    const r = await render(h(Composer, base));
    expect(r.$("p-composer-attach")).toBeNull();
    expect(r.$("p-composer-file")).toBeNull();
    expect(r.$("p-composer-attach-status")).toBeNull();
    expect(r.container.querySelectorAll("button")).toHaveLength(1);
  });

  test("the paperclip opens the dialog for docx, pdf, md and txt", async () => {
    const r = await render(h(Composer, { ...base, attach: { onFile: vi.fn() } }));
    const clip = r.$("p-composer-attach") as HTMLButtonElement;
    expect(clip.getAttribute("aria-label")).toBe("Приложить ТЗ");
    expect(clip.getAttribute("title")).toBe("Приложить ТЗ");
    const input = r.$("p-composer-file") as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.hidden).toBe(true);
    expect(input.accept).toBe(".docx,.pdf,.md,.txt");
    const click = vi.spyOn(input, "click").mockImplementation(() => {});
    await act(async () => clip.click());
    expect(click).toHaveBeenCalledTimes(1);
    await r.rerender(h(Composer, { ...base, disabled: true, attach: { onFile: vi.fn() } }));
    expect((r.$("p-composer-attach") as HTMLButtonElement).disabled).toBe(true);
  });

  test("another type or over 10 МБ: a Russian error, nothing uploaded", async () => {
    const onFile = vi.fn();
    const r = await render(h(Composer, { ...base, attach: { onFile } }));
    await choose(r.$("p-composer-file"), new File(["a;b"], "Клиенты.xlsx"));
    expect(r.$("p-composer-attach-error")?.textContent).toBe("Подходят файлы .docx, .pdf, .md и .txt");
    expect(r.$("p-composer-attach-error")?.getAttribute("role")).toBe("alert");
    await choose(r.$("p-composer-file"), new File([new Uint8Array(COMPOSER_ATTACH_MAX_BYTES + 1)], "ТЗ.PDF"));
    expect(r.$("p-composer-attach-error")?.textContent).toBe(
      "Файл больше 10 МБ — сократите ТЗ или пришлите его частями",
    );
    await choose(r.$("p-composer-file"), new File([], "пусто.md"));
    expect(r.$("p-composer-attach-error")?.textContent).toBe("Файл пустой — выберите другой");
    expect(onFile).not.toHaveBeenCalled();
  });

  test("upload: busy paperclip and «Читаем ТЗ…» while pending; idle after; the server's error shown", async () => {
    let finish: (() => void) | undefined;
    let fail: ((e: unknown) => void) | undefined;
    const onFile = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    const r = await render(h(Composer, { ...base, attach: { onFile } }));
    const file = new File(["# ТЗ\n\n- Цель"], "ТЗ кофейни.md");
    await choose(r.$("p-composer-file"), file);
    expect(onFile).toHaveBeenCalledWith(file);
    const clip = r.$("p-composer-attach") as HTMLButtonElement;
    expect(clip.disabled).toBe(true);
    expect(clip.getAttribute("aria-busy")).toBe("true");
    expect(clip.getAttribute("data-state")).toBe("uploading");
    expect(r.$("p-composer-attach-status")?.textContent).toBe("Читаем ТЗ «ТЗ кофейни.md»…");
    expect(r.$("p-composer-attach-status")?.getAttribute("role")).toBe("status");
    await act(async () => finish?.());
    expect((r.$("p-composer-attach") as HTMLButtonElement).disabled).toBe(false);
    expect(r.$("p-composer-attach-status")?.textContent).toBe("");
    expect(r.$("p-composer-attach-error")).toBeNull();

    await choose(r.$("p-composer-file"), file);
    await act(async () =>
      fail?.(new Error("В файле нет текста. Похоже, это скан — пришлите ТЗ в .docx или текстом.")),
    );
    expect(r.$("p-composer-attach-error")?.textContent).toMatch(/^В файле нет текста/);
    await choose(r.$("p-composer-file"), file);
    await act(async () => fail?.(new TypeError("Failed to fetch")));
    expect(r.$("p-composer-attach-error")?.textContent).toBe("Не удалось загрузить ТЗ — попробуйте ещё раз");
    expect(onFile).toHaveBeenCalledTimes(3);
  });

  test("own label, formats and limit", async () => {
    const onFile = vi.fn();
    const r = await render(
      h(Composer, { ...base, attach: { onFile, label: "Приложить файл", accept: [".md"], maxBytes: 1024 } }),
    );
    expect(r.$("p-composer-attach")?.getAttribute("aria-label")).toBe("Приложить файл");
    expect((r.$("p-composer-file") as HTMLInputElement).accept).toBe(".md");
    await choose(r.$("p-composer-file"), new File(["x"], "tz.txt"));
    expect(r.$("p-composer-attach-error")?.textContent).toBe("Подходят файлы .md");
    await choose(r.$("p-composer-file"), new File([new Uint8Array(2048)], "tz.md"));
    expect(r.$("p-composer-attach-error")?.textContent).toMatch(/^Файл больше 1 КБ/);
    await choose(r.$("p-composer-file"), new File(["# ТЗ"], "tz.md"));
    expect(onFile).toHaveBeenCalledTimes(1);
    expect(r.$("p-composer-attach-error")).toBeNull();
  });
});
