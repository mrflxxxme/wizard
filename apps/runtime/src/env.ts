// Process configuration and startup guards (platform/deploy.yaml#local.env_vars, #local.bind, #local.host_guard;
// runtime.yaml#auth.dev_login_M0).

export interface RuntimeEnv {
  /** WIZARD_AUTH_MODE=dev */
  authModeDev: boolean;
  /** WIZARD_DEV_LOGIN=1 */
  devLogin: boolean;
  /** WIZARD_UNSAFE_LOCAL_EXEC=1 */
  unsafeLocalExec: boolean;
  /** WIZARD_PUBLIC_SCHEME: selects the session cookie name and the expected Origin scheme. */
  publicScheme: "http" | "https";
  /** WIZARD_PLATFORM_ORIGIN: frame-ancestors of draft hosts. */
  platformOrigin: string;
  /** Domain of system hosts (<slug>--<env>.<systemsDomain>); local: "localhost". */
  systemsDomain: string;
  nodeEnv: string | undefined;
  kubernetes: boolean;
}

type EnvSource = Readonly<Record<string, string | undefined>>;

export function readEnv(env: EnvSource = process.env): RuntimeEnv {
  return {
    authModeDev: env.WIZARD_AUTH_MODE === "dev",
    devLogin: env.WIZARD_DEV_LOGIN === "1",
    unsafeLocalExec: env.WIZARD_UNSAFE_LOCAL_EXEC === "1",
    publicScheme: env.WIZARD_PUBLIC_SCHEME === "https" ? "https" : "http",
    platformOrigin: env.WIZARD_PLATFORM_ORIGIN ?? "http://localhost:5173",
    systemsDomain: env.WIZARD_SYSTEMS_DOMAIN ?? "localhost",
    nodeEnv: env.NODE_ENV,
    kubernetes: env.KUBERNETES_SERVICE_HOST !== undefined && env.KUBERNETES_SERVICE_HOST !== "",
  };
}

/** Local modes enable the Host allowlist and the tunnel-header ban (deploy.yaml#local.host_guard). */
export function isLocalMode(env: RuntimeEnv): boolean {
  return env.authModeDev || env.unsafeLocalExec || env.devLogin;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function isLoopbackAddress(host: string): boolean {
  return LOOPBACK.has(host) || /^127(\.\d{1,3}){3}$/.test(host);
}

export class StartupError extends Error {
  override name = "StartupError";
}

/**
 * Throws when dev-only features are enabled outside a local machine: WIZARD_DEV_LOGIN=1 or
 * WIZARD_UNSAFE_LOCAL_EXEC=1 with NODE_ENV=production, KUBERNETES_SERVICE_HOST or a non-loopback bind (L3-11).
 */
export function assertStartupAllowed(env: RuntimeEnv, bindHost?: string): void {
  const on = [
    env.devLogin ? "WIZARD_DEV_LOGIN=1" : "",
    env.unsafeLocalExec ? "WIZARD_UNSAFE_LOCAL_EXEC=1" : "",
  ].filter(Boolean);
  if (on.length === 0) return;
  const what = on.join(", ");
  if (env.nodeEnv === "production") throw new StartupError(`${what} is forbidden with NODE_ENV=production`);
  if (env.kubernetes) throw new StartupError(`${what} is forbidden inside Kubernetes`);
  if (bindHost !== undefined && !isLoopbackAddress(bindHost)) {
    throw new StartupError(`${what} requires a loopback bind address, got ${bindHost}`);
  }
}
