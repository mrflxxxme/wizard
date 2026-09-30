import type { ReactNode } from "react";
import type { MemoryDataSource } from "../src/testing/index.js";
import type { SpecKey } from "./fixtures.js";

/** One demo story per component (demo/stories/<Component>.tsx, collected by import.meta.glob). */
export type Story = {
  /** Component name as in ui-kit.yaml#components. */
  component: string;
  spec: SpecKey;
  /** Default role (null → guest/public role); ?role= overrides it. */
  role: string | null;
  /** Initial in-memory path for routing components. */
  path?: string;
  render(ctx: { ds: MemoryDataSource }): ReactNode;
};
