// In-memory SMTP receiver for tests (email.yaml#test_mode.mocks): plaintext, STARTTLS or implicit TLS, AUTH
// PLAIN/LOGIN, scripted failures. TLS material is generated per run with openssl (no key in the repository).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";

export interface ReceivedMail {
  from: string;
  to: string[];
  data: string;
  authUser: string | null;
  secure: boolean;
}

export interface SmtpMockOptions {
  tls: "none" | "starttls" | "implicit";
  /** Advertise STARTTLS (default: tls === "starttls"). */
  advertiseStarttls?: boolean;
  auth?: { user: string; pass: string };
  /** Reply code for RCPT TO (e.g. 550) or for the end of DATA (e.g. 451, repeated `times`). */
  rcptCode?: number;
  dataFailures?: { code: number; times: number };
  cert?: TestCert;
}

export interface TestCert {
  key: string;
  cert: string;
}

/** Self-signed certificate for smtp.example.test / localhost (openssl; null when it is not installed). */
export function testCert(): TestCert | null {
  const dir = mkdtempSync(join(tmpdir(), "wz-smtp-cert-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "2",
        "-subj",
        "/CN=smtp.example.test",
        "-addext",
        "subjectAltName=DNS:smtp.example.test,DNS:localhost",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    return {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export class SmtpMock {
  readonly mails: ReceivedMail[] = [];
  connections = 0;
  private server: Server;
  port = 0;

  constructor(private readonly o: SmtpMockOptions) {
    this.server = createServer((s) => this.session(s));
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private secureSocket(raw: Socket): TLSSocket {
    if (!this.o.cert) throw new Error("TLS mock needs a certificate");
    return new TLSSocket(raw, { isServer: true, key: this.o.cert.key, cert: this.o.cert.cert });
  }

  private session(raw: Socket): void {
    this.connections += 1;
    let sock: Socket | TLSSocket = this.o.tls === "implicit" ? this.secureSocket(raw) : raw;
    let secure = this.o.tls === "implicit";
    let buf = "";
    let inData = false;
    let data = "";
    let from = "";
    let to: string[] = [];
    let authUser: string | null = null;
    let authStep: null | "user" | "pass" = null;
    let loginUser = "";
    const send = (line: string) => sock.write(`${line}\r\n`);
    const checkAuth = (user: string, pass: string) => {
      if (this.o.auth && user === this.o.auth.user && pass === this.o.auth.pass) {
        authUser = user;
        send("235 2.7.0 Authentication successful");
      } else send("535 5.7.8 Authentication credentials invalid");
    };
    const onLine = (line: string) => {
      if (inData) {
        if (line === ".") {
          inData = false;
          const f = this.o.dataFailures;
          if (f && f.times > 0) {
            f.times -= 1;
            send(`${f.code} try again later`);
            return;
          }
          this.mails.push({ from, to, data, authUser, secure });
          send("250 2.0.0 Ok: queued as MOCK1");
          return;
        }
        data += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
        return;
      }
      if (authStep === "user") {
        loginUser = Buffer.from(line, "base64").toString();
        authStep = "pass";
        send("334 UGFzc3dvcmQ6");
        return;
      }
      if (authStep === "pass") {
        authStep = null;
        checkAuth(loginUser, Buffer.from(line, "base64").toString());
        return;
      }
      const [verb = "", ...rest] = line.split(" ");
      const arg = rest.join(" ");
      switch (verb.toUpperCase()) {
        case "EHLO": {
          const caps = ["250-mock.local"];
          if ((this.o.advertiseStarttls ?? this.o.tls === "starttls") && !secure) caps.push("250-STARTTLS");
          if (this.o.auth) caps.push("250-AUTH PLAIN LOGIN");
          caps.push("250 8BITMIME");
          sock.write(`${caps.join("\r\n")}\r\n`);
          return;
        }
        case "STARTTLS":
          send("220 2.0.0 Ready to start TLS");
          sock.removeAllListeners("data");
          sock = this.secureSocket(sock as Socket);
          secure = true;
          sock.on("data", onData);
          return;
        case "AUTH": {
          const [mech, init] = arg.split(" ");
          if (mech?.toUpperCase() === "PLAIN" && init) {
            const [, user = "", pass = ""] = Buffer.from(init, "base64").toString().split("\0");
            checkAuth(user, pass);
          } else if (mech?.toUpperCase() === "LOGIN") {
            authStep = "user";
            send("334 VXNlcm5hbWU6");
          } else send("504 5.5.4 Unrecognized authentication type");
          return;
        }
        case "MAIL":
          if (this.o.auth && !authUser) return send("530 5.7.0 Authentication required");
          from = /<([^>]*)>/.exec(arg)?.[1] ?? "";
          to = [];
          return send("250 2.1.0 Ok");
        case "RCPT":
          if (this.o.rcptCode) return send(`${this.o.rcptCode} mailbox unavailable`);
          to.push(/<([^>]*)>/.exec(arg)?.[1] ?? "");
          return send("250 2.1.5 Ok");
        case "DATA":
          inData = true;
          data = "";
          return send("354 End data with <CR><LF>.<CR><LF>");
        case "QUIT":
          send("221 2.0.0 Bye");
          sock.end();
          return;
        default:
          return send("502 5.5.2 Error: command not recognized");
      }
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let i = buf.indexOf("\r\n");
      while (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
        i = buf.indexOf("\r\n");
      }
    };
    sock.on("data", onData);
    sock.on("error", () => {});
    send("220 mock.local ESMTP");
  }
}
