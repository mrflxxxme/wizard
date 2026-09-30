// Покрытие ожиданий брифа. Ожидание — строка "Подпись :: стем1|стем2|..." или просто "стем1|стем2".
// Совпадение — подстрока в нижнем регистре (ё→е), поэтому в паттернах пишем основы слов: "билет|ticket".

export const WEIGHTS = { roles: 0.2, entities: 0.3, features: 0.3, acceptance: 0.2 };

export const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replaceAll("ё", "е");

export function parseExpectation(item) {
  const [label, pat] = item.includes("::")
    ? item.split("::").map((x) => x.trim())
    : [item.trim(), item.trim()];
  return {
    label,
    patterns: pat
      .split("|")
      .map((p) => norm(p.trim()))
      .filter(Boolean),
  };
}

function coverage(expected = [], haystacks) {
  const missing = [];
  let hit = 0;
  for (const item of expected) {
    const { label, patterns } = parseExpectation(item);
    if (haystacks.some((h) => patterns.some((p) => h.includes(p)))) hit++;
    else missing.push(label);
  }
  return { value: expected.length ? hit / expected.length : 1, missing };
}

export function scoreSpec(spec, expected) {
  if (!spec) {
    return {
      total: 0,
      roles: 0,
      entities: 0,
      features: 0,
      acceptance: 0,
      missing: { all: "нет валидной спеки" },
    };
  }
  // AppSpec roles: {name, label}; the legacy draft shape {id, name, description} is still matched.
  const roleTexts = (spec.roles ?? []).map((r) =>
    norm(`${r.id ?? ""} ${r.name} ${r.label ?? ""} ${r.description ?? ""}`),
  );
  const entityTexts = (spec.entities ?? []).map((e) => norm(`${e.name} ${e.label ?? ""}`));
  const whole = [norm(JSON.stringify(spec))];
  const accTexts = [norm(JSON.stringify([spec.acceptance ?? [], spec.workflows ?? []]))];

  const r = coverage(expected.roles, roleTexts);
  const e = coverage(expected.entities, entityTexts);
  const f = coverage(expected.must_have_features, whole);
  const a = coverage(expected.acceptance_criteria, accTexts);
  const total =
    WEIGHTS.roles * r.value +
    WEIGHTS.entities * e.value +
    WEIGHTS.features * f.value +
    WEIGHTS.acceptance * a.value;
  return {
    total: round(total),
    roles: round(r.value),
    entities: round(e.value),
    features: round(f.value),
    acceptance: round(a.value),
    missing: { roles: r.missing, entities: e.missing, features: f.missing, acceptance: a.missing },
  };
}

export const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
