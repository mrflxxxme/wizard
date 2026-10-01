// Local Bot API stub for tests (telegram.yaml#test_mode.mocks): sendMessage/setWebhook/getMe/deleteWebhook over
// real HTTP on 127.0.0.1 with scripted responses.
import { createServer, type Server } from "node:http";

export interface BotCall {
  token: string;
  method: string;
  body: Record<string, unknown>;
}

export interface ScriptedReply {
  status: number;
  body: Record<string, unknown>;
}

export class TelegramMock {
  readonly calls: BotCall[] = [];
  /** Replies consumed in order; when empty — {ok: true}. */
  readonly queue: ScriptedReply[] = [];
  private server: Server;
  url = "";

  constructor() {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => {
        raw += c.toString();
      });
      req.on("end", () => {
        const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        if (m) this.calls.push({ token: m[1] as string, method: m[2] as string, body });
        const next = this.queue.shift();
        const result =
          m?.[2] === "getMe"
            ? { id: 42, is_bot: true, username: "own_test_bot" }
            : m?.[2] === "sendMessage"
              ? { message_id: this.calls.length }
              : true;
        const reply = next ?? { status: 200, body: { ok: true, result } };
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const addr = this.server.address();
    this.url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  static blocked(): ScriptedReply {
    return {
      status: 403,
      body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
    };
  }

  static unavailable(): ScriptedReply {
    return { status: 502, body: { ok: false, error_code: 502, description: "Bad Gateway" } };
  }

  static tooMany(retryAfter: number): ScriptedReply {
    return {
      status: 429,
      body: {
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: retryAfter },
      },
    };
  }
}
