// Parameter substitution in fragment values (specs/modules/modules.yaml#manifest.substitutions): a string exactly
// "{{param}}" becomes the typed value (an unset optional parameter drops the key or item), "…{{param}}…" interpolates.
// Placeholders that are not parameters of the module stay as they are: notification templates use {{field}} and
// {{link}} of the record (capabilities/notify.md), so a module must not name a parameter like a record field it
// mentions in a template.

const EXACT = /^\{\{([a-z][a-z0-9_]*)\}\}$/;
const INNER = /\{\{([a-z][a-z0-9_]*)\}\}/g;
const OMIT = Symbol("omit");

const text = (v: unknown): string =>
  Array.isArray(v) ? v.map(String).join(", ") : v == null ? "" : String(v);

/** Deep copy of `value` with the module's parameters (`known` names) substituted; other placeholders stay. */
export function substitute(
  value: unknown,
  params: Readonly<Record<string, unknown>>,
  known: ReadonlySet<string>,
): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const exact = EXACT.exec(v);
      if (exact && known.has(exact[1] as string)) {
        const p = params[exact[1] as string];
        return p === undefined ? OMIT : structuredClone(p);
      }
      return v.replace(INNER, (all, name: string) => (known.has(name) ? text(params[name]) : all));
    }
    if (Array.isArray(v)) return v.map(walk).filter((x) => x !== OMIT);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const r = walk(x);
        if (r !== OMIT) out[k] = r;
      }
      return out;
    }
    return v;
  };
  const r = walk(value);
  return r === OMIT ? undefined : r;
}

/** Stable deep equality of JSON-like values (key order ignored). */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** JSON with object keys sorted (stable text for comparison and hashing). */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, (x as Record<string, unknown>)[k]]),
        )
      : x,
  );
}
