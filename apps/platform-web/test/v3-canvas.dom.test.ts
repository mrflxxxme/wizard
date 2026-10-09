// @vitest-environment happy-dom
// V3-06 with V3-03 and V3-04 (DOM, API doubles): the v3 question view (the reserved «Решите за меня» out of the answer
// chips, why the recommendation, the step); «Приложить ТЗ» through Composer — the share sent, the card with the gaps and
// the short brief of the new version, refusals in the server's Russian words (or by the status without a body); the
// /admin block «Пока не умею» by months.

import { Composer } from "@wizard/ui-kit/v2";
import { act, type ComponentProps, createElement as h, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { COFFEE, toDocx } from "../../../packages/agents/test/brief-extract-fixtures.js";
import { type ApiClient, ApiError } from "../src/api/client.js";
import type { BriefUpload, CapabilityMonth } from "../src/api/types.js";
import { PlatformProvider } from "../src/app/context.js";
import { AdminCapability } from "../src/screens/v3/AdminCapability.js";
import { uploadErrorText, useBriefUpload } from "../src/screens/v3/BriefUpload.js";
import { v3Question } from "../src/screens/v3/question.js";
import { FakeV3 } from "./v3/fake-v3.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

async function mount(api: Partial<ApiClient>, node: ReactNode): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      h(
        PlatformProvider,
        { api: { getOrgSettings: async () => ({}), ...api } as ApiClient } as ComponentProps<
          typeof PlatformProvider
        >,
        node,
      ),
    ),
  );
  await flush();
  return container;
}
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
}
const $ = (id: string) => container?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
const $$ = (id: string) => [...(container?.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`) ?? [])];

async function choose(file: File): Promise<void> {
  const input = $("p-composer-file") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

const SYS = "55555555-5555-4555-8555-555555555555";

function Host({ onUploaded }: { onUploaded(r: BriefUpload): void }): ReactNode {
  const [text, setText] = useState("");
  const u = useBriefUpload(SYS, { onUploaded });
  return h(
    "div",
    null,
    u.card,
    u.progress,
    h(Composer, { value: text, onChange: setText, onSubmit: () => {}, attach: u.attach }),
  );
}

describe("v3 question", () => {
  test("a v3 question: answer chips without «Решите за меня», why, step; a v2 question is null", async () => {
    const fake = new FakeV3();
    await fake.start();
    const q = fake.view().pendingQuestions[0];
    const v = v3Question(q);
    expect(v?.step).toBe(1);
    expect(v?.delegate).toBe(true);
    expect(v?.why).toBe(fake.question?.recommendation);
    expect(v?.options.map((o) => o.id)).toEqual(["o1", "o2", "o3"]);
    expect(v3Question({ ...q, allowDelegate: false })?.delegate).toBe(false);
    expect(
      v3Question({
        id: "g1",
        topic: "goals",
        text: "Что важнее?",
        options: [{ id: "a", label: "Заявки", recommended: true }],
      }),
    ).toBeNull();
    expect(v3Question(null)).toBeNull();
  });
});

describe("«Приложить ТЗ»", () => {
  test("the share sent, then the card: source, gaps (blocking marked), the short brief; «Понятно» hides it", async () => {
    const fake = new FakeV3();
    await fake.start();
    const bytes = toDocx(COFFEE);
    const answer = (await fake.upload("tz.docx", bytes)).body as BriefUpload;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const uploadBrief = vi.fn(async (_id: string, _f: File, onProgress?: (s: number) => void) => {
      onProgress?.(0.4);
      await gate;
      return answer;
    });
    const onUploaded = vi.fn();
    await mount({ uploadBrief } as Partial<ApiClient>, h(Host, { onUploaded }));
    await choose(new File([new Uint8Array(bytes)], "tz.docx"));
    expect($("canvas-upload-progress")?.textContent).toContain("Отправляю ТЗ — 40 %");
    expect($("p-composer-attach-status")?.textContent).toBe("Читаем ТЗ «tz.docx»…");
    await act(async () => release());
    await flush();
    expect(uploadBrief.mock.calls[0]?.[0]).toBe(SYS);
    expect(onUploaded).toHaveBeenCalledWith(answer);
    expect($("canvas-upload-progress")).toBeNull();
    expect($("canvas-upload-source")?.textContent).toContain("DOCX");
    const gaps = $$("canvas-upload-gap");
    expect(gaps.map((g) => g.dataset.section)).toEqual(answer.gaps.missing);
    for (const g of gaps)
      expect(g.textContent?.includes("без этого не собрать")).toBe(
        answer.gaps.blocking.includes(g.dataset.section ?? ""),
      );
    expect($("canvas-upload-summary")?.textContent).toContain(`версия ${answer.brief.version}`);
    await act(async () => $("canvas-upload-close")?.click());
    expect($("canvas-upload-card")).toBeNull();
  });

  test("refusals in Russian: the server's message (415, 400), 413 without a body by the status", async () => {
    const errors = [
      new ApiError(415, {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message_ru: "Подходят файлы .docx, .pdf, .md и .txt. Файл RTF сохраните как .docx или PDF.",
      }),
      new ApiError(400, { code: "VALIDATION_FAILED", message_ru: "В файле нет текста — похоже, это скан." }),
      new ApiError(413, null),
      new ApiError(0, { code: "NETWORK", message_ru: "Нет связи с сервером" }),
    ];
    const uploadBrief = vi.fn(async () => {
      throw errors.shift();
    });
    await mount({ uploadBrief } as unknown as Partial<ApiClient>, h(Host, { onUploaded: () => {} }));
    for (const want of [
      "Подходят файлы .docx, .pdf, .md и .txt. Файл RTF сохраните как .docx или PDF.",
      "В файле нет текста — похоже, это скан.",
      "Файл больше 10 МБ — сократите ТЗ или пришлите его частями",
      "Нет связи с сервером",
    ]) {
      await choose(new File(["# ТЗ"], "tz.md"));
      expect($("p-composer-attach-error")?.textContent).toBe(want);
      expect($("canvas-upload-card")).toBeNull();
    }
    expect(uploadErrorText(new ApiError(415, null))).toBe("Подходят файлы .docx, .pdf, .md и .txt");
    expect(uploadErrorText(new Error("boom"))).toBe("Не удалось прочитать ТЗ — попробуйте ещё раз");
  });
});

describe("/admin «Пока не умею»", () => {
  const months: CapabilityMonth[] = [
    { month: "2026-08", briefs: 3, requirements: 20, notYet: 5, share: 0.25 },
    { month: "2026-09", briefs: 0, requirements: 0, notYet: 0, share: 0 },
    { month: "2026-10", briefs: 4, requirements: 30, notYet: 3, share: 0.1 },
  ];

  test("months newest first with the share in words and the trend", async () => {
    const adminCapabilityShare = vi.fn(async () => ({ months }));
    await mount({ adminCapabilityShare }, h(AdminCapability, { onMfaRequired: () => {} }));
    const rows = $$("admin-capability-row");
    expect(rows.map((r) => r.dataset.month)).toEqual(["2026-10", "2026-09", "2026-08"]);
    expect($$("admin-capability-share").map((x) => x.textContent)).toEqual(["10 %", "—", "25 %"]);
    expect(rows[0]?.textContent).toContain("октябрь 2026");
    expect($("admin-capability-trend")?.textContent).toBe("За период: 25 % → 10 %");
  });

  test("no briefs — a plain line; MFA_REQUIRED goes to the code screen", async () => {
    await mount(
      { adminCapabilityShare: async () => ({ months: [months[1] as CapabilityMonth] }) },
      h(AdminCapability, { onMfaRequired: () => {} }),
    );
    expect($("admin-capability")?.textContent).toContain("Брифов v3 пока нет");
    act(() => root?.unmount());
    const onMfaRequired = vi.fn();
    await mount(
      {
        adminCapabilityShare: async () => {
          throw new ApiError(403, { code: "MFA_REQUIRED", message_ru: "Подтвердите вход" });
        },
      },
      h(AdminCapability, { onMfaRequired }),
    );
    expect(onMfaRequired).toHaveBeenCalled();
  });
});
