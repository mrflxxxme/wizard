// deploy.yaml#local.host_guard (L3-10): DNS rebinding and tunnels in dev mode.
import type { MiddlewareHandler } from "hono";
import { ApiError } from "../errors.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function hostAllowed(hostHeader: string): boolean {
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return false;
    const rest = host.slice(end + 1);
    if (rest !== "" && !/^:\d{1,5}$/.test(rest)) return false;
    host = host.slice(0, end + 1);
  } else {
    const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(host);
    if (!m) return false;
    host = m[1] as string;
  }
  if (LOOPBACK.has(host)) return true;
  return /^([a-z0-9-]+\.)+localhost$/.test(host);
}

export function isTunnelHeader(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith("x-forwarded-") || n === "forwarded" || n.startsWith("cf-");
}

export function hostGuard(opts: { enabled: boolean; platformOrigin: string }): MiddlewareHandler {
  return async (c, next) => {
    if (!opts.enabled) return next();
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!hostAllowed(host)) throw new ApiError("HOST_NOT_ALLOWED", "Недопустимый адрес сервера");
    for (const name of Object.keys(c.req.header())) {
      if (isTunnelHeader(name))
        throw new ApiError("FORBIDDEN", "Доступ через прокси и туннели в режиме разработки запрещён");
    }
    const method = c.req.method;
    const origin = c.req.header("origin");
    if (method !== "GET" && method !== "HEAD" && origin !== undefined && origin !== opts.platformOrigin)
      throw new ApiError("FORBIDDEN", "Запрос с чужого сайта отклонён");
    return next();
  };
}
