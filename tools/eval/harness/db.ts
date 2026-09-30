// Postgres connection for gates (G0 shadow schema, G1 ephemeral schema). tools/eval is not a workspace package, so
// the driver (architecture.yaml#stack: postgres 3.x) is loaded from apps/runtime, whose app the harness runs for G1.
import { createRequire } from "node:module";
import { join } from "node:path";
import type { GateContext } from "../../../packages/gates/src/index.ts";

export type Sql = GateContext["db"];

const fromRuntime = createRequire(
  join(import.meta.dirname, "..", "..", "..", "apps", "runtime", "package.json"),
);

export function connectDb(url: string): Sql {
  const postgres = fromRuntime("postgres") as (url: string, o: Record<string, unknown>) => Sql;
  return postgres(url, { max: 4, onnotice: () => {} });
}
