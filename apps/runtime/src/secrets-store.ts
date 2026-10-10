// Connector secrets of the runtime from the platform's secret store (V3-23): the keys an owner gives through the key
// window (platform-api V3-21) are written to the encrypted secret file on the data volume both services mount; the
// runtime reads its system's ones from it (@wizard/connectors fileSecretReader: connector paths only, never the
// platform's own secrets). The file is keyed by platform.systems.id, the runtime knows systems by schema_key — the id
// is looked up once per system. A name the file lacks falls back to the M0 env variables WIZARD_SECRET_<SYSTEM>_<NAME>.
import { envSecretReader, fileSecretReader } from "@wizard/connectors";
import type postgres from "postgres";
import type { SecretsFactory } from "./preview/connectors.js";

/** platform.systems.id of a schema_key (null — unknown or the platform schema not readable). */
export type SystemUuidLookup = (schemaKey: string) => Promise<string | null>;

export function dbSystemUuid(db: postgres.Sql): SystemUuidLookup {
  const known = new Map<string, string>();
  return async (schemaKey) => {
    const hit = known.get(schemaKey);
    if (hit) return hit;
    try {
      const rows = await db<{ id: string }[]>`
        select s.id::text as id from platform.systems s where s.schema_key = ${schemaKey} limit 1`;
      const id = rows[0]?.id ?? null;
      if (id) known.set(schemaKey, id);
      return id;
    } catch {
      return null;
    }
  };
}

export function storeSecrets(o: {
  file: string;
  keyMaterial: string;
  systemUuid: SystemUuidLookup;
  env?: NodeJS.ProcessEnv;
}): SecretsFactory {
  return (systemId, env) =>
    fileSecretReader({
      file: o.file,
      keyMaterial: o.keyMaterial,
      env,
      systemUuid: () => o.systemUuid(systemId),
      fallback: envSecretReader(systemId, o.env),
    });
}
