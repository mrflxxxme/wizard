// G1 runtime for the eval harness: a real apps/runtime (createRuntimeApp) in test mode (connectors: outbox) with its
// own DB role and a temp artifacts folder, as in packages/gates/test/g1-helpers.ts. Generated functions execute only
// under WIZARD_UNSAFE_LOCAL_EXEC=1 (AGENTS.md); fixture code comes from the repository.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertStartupAllowed,
  closeExecutors,
  createRuntimeApp,
  MemoryRegistry,
  type RuntimeApp,
  readEnv,
} from "../../../apps/runtime/src/index.ts";
import {
  newQrKeyring,
  QR_SECRET,
  serializeQrKeyring,
  staticSecretReader,
} from "../../../packages/connectors/src/index.ts";
import type { Sql } from "./db.ts";

export interface G1Runtime {
  rt: RuntimeApp;
  role: string;
  close(): Promise<void>;
}

export async function createG1Runtime(
  db: Sql,
  o: { unsafeLocalExec: boolean; env: Record<string, string | undefined> },
): Promise<G1Runtime> {
  const env = { ...readEnv(o.env), unsafeLocalExec: o.unsafeLocalExec };
  assertStartupAllowed(env);
  const role = `wz_eval_rt_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  const root = mkdtempSync(join(tmpdir(), "wz-eval-g1-"));
  const qr = serializeQrKeyring(newQrKeyring());
  const rt = createRuntimeApp({
    db,
    registry: new MemoryRegistry(),
    dbRole: role,
    artifactsRoot: join(root, "artifacts"),
    connectors: "outbox",
    secrets: () => staticSecretReader({ [QR_SECRET]: qr }),
    env: {
      ...env,
      authModeDev: true,
      devLogin: false,
      publicScheme: "http",
      systemsDomain: "localhost",
      nodeEnv: "test",
    },
  });
  return {
    rt,
    role,
    async close() {
      closeExecutors();
      await db.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
      await db.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    },
  };
}
