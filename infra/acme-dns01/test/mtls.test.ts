// The webhook server trusts only kube-apiserver's front-proxy client certificate: a request without a certificate or
// with one from another CA is refused, kubelet health probes pass without one. Certificates are made with openssl.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebhook, createWebhookServer } from "../src/index.js";

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "wz-acme-mtls-"));
const ssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });

function makeCa(name: string) {
  ssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`);
  ssl(
    "req",
    "-x509",
    "-new",
    "-key",
    `${name}.key`,
    "-subj",
    `/CN=${name}`,
    "-days",
    "1",
    "-out",
    `${name}.crt`,
  );
}
function makeLeaf(name: string, cn: string, caName: string) {
  ssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`);
  ssl("req", "-new", "-key", `${name}.key`, "-subj", `/CN=${cn}`, "-out", `${name}.csr`);
  ssl(
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    `${caName}.crt`,
    "-CAkey",
    `${caName}.key`,
    "-CAcreateserial",
    "-days",
    "1",
    "-out",
    `${name}.crt`,
  );
}
const read = (f: string) => readFileSync(join(dir, f));

describe.skipIf(!hasOpenssl)("webhook server mTLS (front proxy)", () => {
  let port = 0;
  let close = () => {};

  beforeAll(async () => {
    makeCa("front-proxy-ca");
    makeCa("rogue-ca");
    makeCa("serving-ca");
    makeLeaf("apiserver", "front-proxy-client", "front-proxy-ca");
    makeLeaf("rogue", "front-proxy-client", "rogue-ca");
    makeLeaf("server", "webhook", "serving-ca");
    const handle = createWebhook({
      groupName: "acme.wizard.ru",
      solverName: "cloudru",
      dns: { presentTxt: async () => {}, cleanupTxt: async () => {} },
      zones: ["sys-example.ru"],
      allowedUsers: ["system:serviceaccount:cert-manager:cert-manager"],
    });
    const server = createWebhookServer({
      key: read("server.key"),
      cert: read("server.crt"),
      trust: { ca: read("front-proxy-ca.crt").toString(), allowedNames: ["front-proxy-client"] },
      handle,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
    close = () => server.close();
  });
  afterAll(() => {
    close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (path: string, client?: "apiserver" | "rogue") =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          ca: read("serving-ca.crt"),
          servername: "webhook",
          checkServerIdentity: () => undefined,
          ...(client ? { key: read(`${client}.key`), cert: read(`${client}.crt`) } : {}),
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });

  it("discovery only for the front-proxy certificate; health for anyone", async () => {
    expect(await get("/apis/acme.wizard.ru/v1alpha1", "apiserver")).toBe(200);
    expect(await get("/apis/acme.wizard.ru/v1alpha1", "rogue")).toBe(401);
    expect(await get("/apis/acme.wizard.ru/v1alpha1")).toBe(401);
    expect(await get("/healthz")).toBe(200);
  });
});
