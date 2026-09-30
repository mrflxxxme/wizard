// Content-Security-Policy of the platform (platform-screens.yaml#stack, L3-17). Used by vite.config.ts.

export interface CspOptions {
  /** Origins allowed in frame-src (system hosts), e.g. http://*.localhost:4100. */
  frameSrc: string[];
  /** Vite dev server injects CSS modules as <style>; the built app loads CSS files only. */
  dev?: boolean;
}

/** frame-src for WIZARD_SYSTEMS_DOMAIN (host[:port]); default — local runtime http://*.localhost:4100. */
export function systemsFrameSrc(systemsDomain: string | undefined): string[] {
  const d = (systemsDomain ?? "").trim();
  if (!d || d === "localhost") return ["http://*.localhost:4100"];
  if (/^localhost:\d+$/.test(d)) return [`http://*.${d}`];
  return [`https://*.${d}`];
}

export function platformCsp(o: CspOptions): string {
  const directives = [
    "default-src 'self'",
    "script-src 'self'",
    `frame-src ${o.frameSrc.join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
  ];
  if (o.dev) directives.push("style-src 'self' 'unsafe-inline'");
  return directives.join("; ");
}
