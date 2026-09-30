// Rebuilds argument validators reported by the executor process with the host's `v` (@wizard/sdk), so args are
// validated in the runtime before the handler runs (runtime.yaml#functions.args). Input is untrusted.
import { type ArgsShape, type Validator, v } from "@wizard/sdk";
import type { SerializedValidator } from "./executor.js";

const MAX_DEPTH = 16;

function bad(): never {
  throw new TypeError("invalid validator descriptor");
}

const optNum = (x: unknown): number | undefined =>
  x === undefined || x === null ? undefined : typeof x === "number" && Number.isFinite(x) ? x : bad();

function range(s: SerializedValidator): { min?: number; max?: number } {
  const o: { min?: number; max?: number } = {};
  const min = optNum(s.min);
  const max = optNum(s.max);
  if (min !== undefined) o.min = min;
  if (max !== undefined) o.max = max;
  return o;
}

export function toValidator(raw: unknown, depth = 0): Validator<unknown> {
  if (depth > MAX_DEPTH || typeof raw !== "object" || raw === null) bad();
  const s = raw as SerializedValidator;
  switch (s.kind) {
    case "string": {
      const o: { min?: number; max?: number; pattern?: RegExp } = range(s);
      if (s.pattern !== undefined) {
        if (typeof s.pattern?.source !== "string" || typeof s.pattern.flags !== "string") bad();
        o.pattern = new RegExp(s.pattern.source, s.pattern.flags);
      }
      return v.string(o);
    }
    case "int":
      return v.int(range(s));
    case "number":
      return v.number(range(s));
    case "money":
      return v.money(range(s));
    case "boolean":
      return v.boolean();
    case "date":
      return v.date();
    case "datetime":
      return v.datetime();
    case "email":
      return v.email();
    case "phone":
      return v.phone();
    case "pagination":
      return v.pagination();
    case "id":
      return typeof s.entity === "string" ? v.id(s.entity as never) : bad();
    case "literal":
      return ["string", "number", "boolean"].includes(typeof s.value)
        ? v.literal(s.value as string | number | boolean)
        : bad();
    case "enum": {
      const values =
        Array.isArray(s.values) && s.values.every((x) => typeof x === "string") ? s.values : bad();
      return values.length > 0 ? v.enum(...(values as [string, ...string[]])) : bad();
    }
    case "array": {
      const max = optNum(s.max);
      return v.array(toValidator(s.item, depth + 1), max === undefined ? {} : { max });
    }
    case "object":
      return v.object(toShape(s.shape, depth + 1));
    case "optional":
      return v.optional(toValidator(s.inner, depth + 1));
    case "nullable":
      return v.nullable(toValidator(s.inner, depth + 1));
    default:
      return bad();
  }
}

export function toShape(raw: unknown, depth = 0): ArgsShape {
  if (depth > MAX_DEPTH || typeof raw !== "object" || raw === null || Array.isArray(raw)) bad();
  const out: ArgsShape = {};
  for (const [k, x] of Object.entries(raw)) out[k] = toValidator(x, depth + 1);
  return out;
}
