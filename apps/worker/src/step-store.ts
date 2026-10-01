// Outputs of offloaded steps (LLM answers, specs, gate reports): dbos.operation_outputs keeps only {id, sha256}
// (workflows.yaml#execution.M1.dbos_data, L3-09); the content lives here, AES-256-GCM, until the workflow ends.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface StepRef {
  id: string;
  sha256: string;
}

const UUID = /^[0-9a-f-]{36}$/;

function replacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const raw = this[key];
  if (raw instanceof Date) return { $date: raw.toISOString() };
  if (raw instanceof Map) return { $map: [...raw.entries()] };
  if (raw instanceof Uint8Array) return { $bytes: Buffer.from(raw).toString("base64") };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1) {
      if (typeof o.$date === "string") return new Date(o.$date);
      if (Array.isArray(o.$map)) return new Map(o.$map as [unknown, unknown][]);
      if (typeof o.$bytes === "string") return Buffer.from(o.$bytes, "base64");
    }
  }
  return value;
}

export class StepStore {
  readonly root: string;
  readonly #keyMaterial: string;
  #k: Buffer | undefined;

  /** keyMaterial: WIZARD_SECRETS_KEY; empty → a random key in <root>/.key (local only). */
  constructor(root: string, keyMaterial: string) {
    this.root = root;
    this.#keyMaterial = keyMaterial;
  }

  get #key(): Buffer {
    if (!this.#k) {
      let ikm: Buffer;
      if (this.#keyMaterial) ikm = Buffer.from(this.#keyMaterial, "utf8");
      else {
        const f = join(this.root, ".key");
        if (!existsSync(f)) {
          mkdirSync(this.root, { recursive: true });
          try {
            writeFileSync(f, randomBytes(32), { mode: 0o600, flag: "wx" });
          } catch (e) {
            if ((e as { code?: string }).code !== "EEXIST") throw e;
          }
        }
        ikm = readFileSync(f);
      }
      this.#k = Buffer.from(hkdfSync("sha256", ikm, "wizard", "step-store", 32));
    }
    return this.#k;
  }

  #path(runId: string, id: string): string {
    if (!UUID.test(runId) || !UUID.test(id)) throw new Error("invalid step ref");
    return join(this.root, runId, `${id}.bin`);
  }

  async put(runId: string, value: unknown): Promise<StepRef> {
    const plain = Buffer.from(JSON.stringify(value, replacer), "utf8");
    const id = randomUUID();
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.#key, iv);
    c.setAAD(Buffer.from(`${runId}/${id}`));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    mkdirSync(join(this.root, runId), { recursive: true });
    writeFileSync(this.#path(runId, id), Buffer.concat([iv, c.getAuthTag(), ct]), { mode: 0o600 });
    return { id, sha256: createHash("sha256").update(plain).digest("hex") };
  }

  async get<T>(runId: string, ref: StepRef): Promise<T> {
    const p = this.#path(runId, ref.id);
    if (!existsSync(p)) throw new Error(`step output ${ref.id} of run ${runId} is gone`);
    const buf = readFileSync(p);
    const d = createDecipheriv("aes-256-gcm", this.#key, buf.subarray(0, 12));
    d.setAAD(Buffer.from(`${runId}/${ref.id}`));
    d.setAuthTag(buf.subarray(12, 28));
    const plain = Buffer.concat([d.update(buf.subarray(28)), d.final()]);
    if (createHash("sha256").update(plain).digest("hex") !== ref.sha256)
      throw new Error(`step output ${ref.id} does not match its checkpoint`);
    return JSON.parse(plain.toString("utf8"), reviver) as T;
  }

  /** Runs that have stored outputs. */
  runs(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter((n) => UUID.test(n));
  }

  /** Deletes the outputs of a finished workflow (it is never replayed again). */
  drop(runId: string): void {
    if (UUID.test(runId)) rmSync(join(this.root, runId), { recursive: true, force: true });
  }
}
