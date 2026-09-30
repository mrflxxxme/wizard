// Minimal renderHook on react-dom (no testing-library dependency).
import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { SdkProvider, type SdkProviderProps } from "../../src/index.js";

export function renderHook<T>(hook: () => T, provider: SdkProviderProps) {
  const result: { current: T; renders: number } = { current: undefined as T, renders: 0 };
  function Probe(): ReactNode {
    result.current = hook();
    result.renders += 1;
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  flushSync(() => root.render(createElement(SdkProvider, provider, createElement(Probe))));
  return { result, unmount: () => root.unmount() };
}
