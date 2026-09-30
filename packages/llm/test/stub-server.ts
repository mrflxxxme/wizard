// Local OpenAI-compatible HTTP stub: records every request (path, headers, body) and answers per provider prefix.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Captured {
  provider: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
  raw: string;
}

export type Responder = (req: Captured) => {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

export const okToolCall: Responder = (req) => ({
  status: 200,
  body: {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: String(req.body.model),
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "apply_ops", arguments: '{"ops":[]}' } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 400 },
    },
  },
});

export const okText: Responder = (req) => ({
  status: 200,
  body: {
    id: "chatcmpl-2",
    object: "chat.completion",
    created: 1,
    model: String(req.body.model),
    choices: [{ index: 0, message: { role: "assistant", content: "Готово" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  },
});

export const fail500: Responder = () => ({ status: 500, body: { error: { message: "boom" } } });

export interface Stub {
  url: string;
  requests: Captured[];
  respond: Record<string, Responder>;
  env(extra?: Record<string, string>): Record<string, string>;
  close(): Promise<void>;
}

export async function startStub(): Promise<Stub> {
  const requests: Captured[] = [];
  const respond: Record<string, Responder> = { zai: okToolCall, cloudru: okToolCall, yandex: okToolCall };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString("utf8");
    });
    req.on("end", () => {
      const provider = (req.url ?? "/").split("/")[1] ?? "";
      const cap: Captured = {
        provider,
        path: req.url ?? "",
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        raw,
      };
      requests.push(cap);
      const r = (respond[provider] ?? fail500)(cap);
      res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    respond,
    env: (extra = {}) => ({
      ZAI_BASE_URL: `${url}/zai`,
      ZAI_API_KEY: "test-zai",
      CLOUDRU_BASE_URL: `${url}/cloudru`,
      CLOUDRU_API_KEY: "test-cloudru",
      YANDEX_BASE_URL: `${url}/yandex`,
      YANDEX_API_KEY: "test-yandex",
      YANDEX_FOLDER_ID: "b1gfolder",
      ...extra,
    }),
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
