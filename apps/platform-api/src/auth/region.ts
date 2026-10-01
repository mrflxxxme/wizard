// Region of an organization and the T1 restriction (security/data-boundary.yaml#region_restriction, L3-02).

/** Subjects of the RF whose tenants may use T0 only (list — E-LEGAL; until then all six). */
export const RESTRICTED_REGIONS: ReadonlySet<string> = new Set(["90", "91", "92", "93", "94", "95"]);

export const isRestrictedRegion = (code: string | null | undefined): boolean =>
  !!code && RESTRICTED_REGIONS.has(code);

/** Offline GeoIP of member logins → two-digit subject code or null (the RF-hosted database is pending). */
export type GeoRegion = (ip: string) => string | null | Promise<string | null>;

const W10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const W12A = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const W12B = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const check = (d: number[], w: number[]) => (w.reduce((s, k, i) => s + k * (d[i] as number), 0) % 11) % 10;

/** INN-10 (legal entity) or INN-12 (individual) with valid check digits. */
export function innValid(inn: string): boolean {
  if (!/^\d{10}$|^\d{12}$/.test(inn)) return false;
  const d = [...inn].map(Number);
  if (d.length === 10) return check(d, W10) === d[9];
  return check(d, W12A) === d[10] && check(d, W12B) === d[11];
}

/** The first two digits of an INN are the region code. */
export const regionFromInn = (inn: string): string => inn.slice(0, 2);

/**
 * New (region_code, t1_restricted) of an org after a region source changes. The flag is monotonic: only staff may
 * clear it by documents (data-boundary.yaml#region_restriction.rule).
 */
export function applyRegion(
  cur: { region_code: string | null; t1_restricted: boolean },
  src: { regionCode?: string | undefined; inn?: string | undefined; loginRegion?: string | null | undefined },
): { region_code: string | null; t1_restricted: boolean } {
  const innRegion = src.inn ? regionFromInn(src.inn) : undefined;
  const region_code = src.regionCode ?? innRegion ?? cur.region_code;
  const t1_restricted =
    cur.t1_restricted ||
    isRestrictedRegion(src.regionCode) ||
    isRestrictedRegion(innRegion) ||
    isRestrictedRegion(src.loginRegion) ||
    isRestrictedRegion(region_code);
  return { region_code, t1_restricted };
}
