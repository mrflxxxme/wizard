// Name helpers shared by the DNS backends.

export const normalizeDomain = (s: string): string => s.trim().toLowerCase().replace(/\.$/, "");

/** Name of fqdn relative to zone: "_acme-challenge" for _acme-challenge.<zone>; "" for the apex. */
export function relativeName(fqdn: string, zone: string): string {
  const host = normalizeDomain(fqdn);
  const z = normalizeDomain(zone);
  if (host === z) return "";
  if (!host.endsWith(`.${z}`)) throw new Error(`${fqdn} is not under zone ${zone}`);
  return host.slice(0, -(z.length + 1));
}
