// Minimal SMTP submission client (RFC 5321/3207/4954): implicit TLS (465) or mandatory STARTTLS (587);
// plaintext only for the local dev receiver. Errors carry the SMTP reply code, never the conversation.
import type { Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { type Dialer, tcpDialer } from "./net.js";

export interface SmtpEndpoint {
  host: string;
  port: number;
  /** implicit — TLS from the first byte (465); starttls — upgrade required (587); none — dev receiver only. */
  tls: "implicit" | "starttls" | "none";
  user?: string;
}

export interface SmtpSendOptions {
  endpoint: SmtpEndpoint;
  /** IP to connect to (already checked by resolvePublic); default endpoint.host. TLS verifies endpoint.host. */
  address?: string;
  password?: string;
  from: string;
  to: string[];
  /** Complete message with CRLF line endings. */
  data: string;
  dial?: Dialer;
  /** Extra trusted CA (tests against a local receiver). */
  ca?: string;
  timeoutMs?: number;
  ehloName?: string;
}

export class SmtpError extends Error {
  /** SMTP reply code; 0 — connection, TLS or timeout failure. */
  readonly code: number;
  readonly phase: string;
  constructor(code: number, phase: string) {
    super(`smtp ${phase} failed${code ? ` (${code})` : ""}`);
    this.name = "SmtpError";
    this.code = code;
    this.phase = phase;
  }
}

interface Reply {
  code: number;
  lines: string[];
}

class Conversation {
  private buf = "";
  private waiting: ((r: Reply) => void) | null = null;
  private failed: Error | null = null;
  private failWaiter: ((e: Error) => void) | null = null;
  private pending: string[] = [];
  private replies: Reply[] = [];
  private socket: Socket | TLSSocket;

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(s: Socket | TLSSocket): void {
    s.on("data", (chunk: Buffer | string) => this.onData(chunk.toString()));
    s.on("error", (e) => this.fail(e));
    s.on("close", () => this.fail(new Error("connection closed")));
  }

  private fail(e: Error): void {
    if (this.failed) return;
    this.failed = e;
    this.failWaiter?.(e);
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i = this.buf.indexOf("\r\n");
    while (i >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      this.pending.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const lines = this.pending;
        this.pending = [];
        const reply = { code: Number(line.slice(0, 3)), lines };
        const w = this.waiting;
        this.waiting = null;
        this.failWaiter = null;
        if (w) w(reply);
        else this.replies.push(reply);
      }
      i = this.buf.indexOf("\r\n");
    }
  }

  read(): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const queued = this.replies.shift();
      if (queued) return resolve(queued);
      if (this.failed) return reject(this.failed);
      this.waiting = resolve;
      this.failWaiter = reject;
    });
  }

  async cmd(line: string | null, phase: string, expect: number[]): Promise<Reply> {
    if (line !== null) this.socket.write(`${line}\r\n`);
    let r: Reply;
    try {
      r = await this.read();
    } catch {
      throw new SmtpError(0, phase);
    }
    if (!expect.includes(r.code)) throw new SmtpError(r.code, phase);
    return r;
  }

  /** Replaces the transport with TLS over the same TCP connection (STARTTLS) or from the start (465). */
  async upgrade(servername: string, ca?: string): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    // Plaintext received before the handshake must not be read as TLS-protected replies (STARTTLS injection).
    this.buf = "";
    this.pending = [];
    this.replies = [];
    const secure = await new Promise<TLSSocket>((resolve, reject) => {
      const t = tlsConnect({ socket: plain, servername, ca, minVersion: "TLSv1.2" }, () => resolve(t));
      t.once("error", reject);
    }).catch(() => {
      throw new SmtpError(0, "tls");
    });
    this.socket = secure;
    this.attach(secure);
  }

  write(data: string): void {
    this.socket.write(data);
  }

  close(): void {
    this.socket.destroy();
  }
}

const dotStuff = (data: string) =>
  `${data.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..").replace(/\r\n$/, "")}\r\n.\r\n`;

/** Sends one message; resolves with the server's final reply text (queue id). */
export async function sendSmtp(o: SmtpSendOptions): Promise<{ reply: string }> {
  const { endpoint } = o;
  const dial = o.dial ?? tcpDialer;
  let socket: Socket;
  try {
    socket = await dial({ host: o.address ?? endpoint.host, port: endpoint.port });
  } catch {
    throw new SmtpError(0, "connect");
  }
  const conv = new Conversation(socket);
  const timer = setTimeout(() => conv.close(), o.timeoutMs ?? 20_000);
  try {
    if (endpoint.tls === "implicit") await conv.upgrade(endpoint.host, o.ca);
    await conv.cmd(null, "greeting", [220]);
    const ehlo = `EHLO ${o.ehloName ?? "wizard.local"}`;
    let caps = await conv.cmd(ehlo, "ehlo", [250]);
    if (endpoint.tls === "starttls") {
      if (!caps.lines.some((l) => /^250[ -]STARTTLS\b/i.test(l))) throw new SmtpError(0, "starttls");
      await conv.cmd("STARTTLS", "starttls", [220]);
      await conv.upgrade(endpoint.host, o.ca);
      caps = await conv.cmd(ehlo, "ehlo", [250]);
    }
    if (endpoint.user) {
      if (endpoint.tls === "none") throw new SmtpError(0, "auth");
      const auth = caps.lines.find((l) => /^250[ -]AUTH\b/i.test(l))?.toUpperCase() ?? "";
      const pass = o.password ?? "";
      if (/\bPLAIN\b/.test(auth)) {
        const token = Buffer.from(`\0${endpoint.user}\0${pass}`, "utf8").toString("base64");
        await conv.cmd(`AUTH PLAIN ${token}`, "auth", [235]);
      } else {
        await conv.cmd("AUTH LOGIN", "auth", [334]);
        await conv.cmd(Buffer.from(endpoint.user).toString("base64"), "auth", [334]);
        await conv.cmd(Buffer.from(pass).toString("base64"), "auth", [235]);
      }
    }
    await conv.cmd(`MAIL FROM:<${o.from}>`, "mail", [250]);
    for (const rcpt of o.to) await conv.cmd(`RCPT TO:<${rcpt}>`, "rcpt", [250, 251]);
    await conv.cmd("DATA", "data", [354]);
    conv.write(dotStuff(o.data));
    const done = await conv.cmd(null, "data", [250]);
    await conv.cmd("QUIT", "quit", [221]).catch(() => undefined);
    return { reply: (done.lines.at(-1) ?? "").slice(4) };
  } finally {
    clearTimeout(timer);
    conv.close();
  }
}
