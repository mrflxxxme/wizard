// Minimal DOM rendering for happy-dom tests (no testing-library): render inside WzProvider with act().
import type { AppSpec } from "@wizard/appspec";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { type DataSource, type RoleSpec, toRoleSpec, WzProvider } from "../../src/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export type Rendered = {
  container: HTMLElement;
  $(testid: string): HTMLElement;
  $$(testid: string): HTMLElement[];
  q<E extends Element = HTMLElement>(sel: string): E;
  rerender(el: ReactNode): Promise<void>;
  unmount(): void;
};

export async function render(
  el: ReactNode,
  opts: { spec?: RoleSpec; app?: AppSpec; role?: string | null; ds?: DataSource; pathname?: string } = {},
): Promise<Rendered> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const spec = opts.spec ?? (opts.app ? toRoleSpec(opts.app, opts.role ?? null) : undefined);
  const wrap = (node: ReactNode) =>
    spec
      ? createElement(
          WzProvider,
          {
            spec,
            applyTheme: false,
            ...(opts.ds ? { dataSource: opts.ds } : {}),
            ...(opts.pathname ? { pathname: opts.pathname, navigate: () => {} } : {}),
          },
          node,
        )
      : node;
  await act(async () => root.render(wrap(el)));
  const q = <E extends Element = HTMLElement>(sel: string): E => {
    const found = container.querySelector<E>(sel);
    if (!found) throw new Error(`not found: ${sel}`);
    return found;
  };
  return {
    container,
    $: (id) => q(`[data-testid="${id}"]`),
    $$: (id) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)],
    q,
    rerender: async (node) => act(async () => root.render(wrap(node))),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

export async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

/** Sets a controlled input's value the way React listens for it. */
export async function type(el: Element, value: string): Promise<void> {
  const input = el as HTMLInputElement;
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}

export async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}
