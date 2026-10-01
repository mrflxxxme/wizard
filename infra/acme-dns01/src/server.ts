// HTTPS server of the webhook: client certificates are requested but not required (kubelet probes come without one);
// a certificate counts only when it chains to the front-proxy CA (TLS layer) and its CN is allowed (webhook.trusted).
import { createServer, type Server } from "node:https";
import type { TLSSocket } from "node:tls";
import type { FrontProxyTrust } from "./kube.js";
import type { CallerInfo } from "./webhook.js";

export interface WebhookServerOptions {
  key: string | Buffer;
  cert: string | Buffer;
  trust: FrontProxyTrust;
  handle: (req: Request, caller: CallerInfo) => Promise<Response>;
  maxBodyBytes?: number;
}

export function createWebhookServer(o: WebhookServerOptions): Server {
  const max = o.maxBodyBytes ?? 65_536;
  return createServer(
    {
      key: o.key,
      cert: o.cert,
      ca: o.trust.ca,
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
    },
    (req, res) => {
      const sock = req.socket as TLSSocket;
      const peer = sock.getPeerCertificate();
      const cn = peer && typeof peer.subject?.CN === "string" ? peer.subject.CN : null;
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > max) req.destroy();
        else chunks.push(c);
      });
      req.on("end", () => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
        const method = req.method ?? "GET";
        const request = new Request(`https://webhook${req.url ?? "/"}`, {
          method,
          headers,
          ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
        });
        o.handle(request, { authorized: sock.authorized, commonName: cn, allowedNames: o.trust.allowedNames })
          .then(async (r) => {
            res.writeHead(r.status, Object.fromEntries(r.headers));
            res.end(Buffer.from(await r.arrayBuffer()));
          })
          .catch(() => {
            res.writeHead(500).end();
          });
      });
    },
  );
}
