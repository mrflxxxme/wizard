import type { Context } from "hono";
import type postgres from "postgres";
import type { z } from "zod";
import type { Billing } from "../billing/ledger.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { invalid } from "../errors.js";
import type { EventBus } from "../runs/events.js";
import type { RunEngine } from "../runs/queue.js";
import type { BlobStore } from "../storage/blobs.js";

export interface Deps {
  db: Db;
  pg: postgres.Sql;
  bus: EventBus;
  blobs: BlobStore;
  engine: RunEngine;
  config: Config;
  billing: Billing;
}

function issues(e: z.ZodError) {
  return { issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
}

export async function jsonBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw invalid("Тело запроса должно быть JSON");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw invalid("Некорректные параметры запроса", issues(r.error));
  return r.data;
}

export function parseQuery<T>(c: Context, schema: z.ZodType<T>): T {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw invalid("Некорректные параметры запроса", issues(r.error));
  return r.data;
}
