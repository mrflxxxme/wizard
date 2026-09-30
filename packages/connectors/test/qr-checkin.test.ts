// QR online check-in (qr.yaml#checkin_algorithm) and revoke on the forum reference spec.
import { describe, expect, test } from "vitest";
import {
  invokeAction,
  issueQrToken,
  newQrKeyring,
  qrCheck,
  qrConnector,
  serializeQrKeyring,
  signQrToken,
} from "../src/index.js";
import { createTestCtx, MemorySystemDb } from "../src/testing.js";
import { loadSpec } from "./helpers.js";

const spec = loadSpec("forum");
const qrKey = serializeQrKeyring(newQrKeyring());

async function setup(status = "paid") {
  const db = new MemorySystemDb(spec);
  const ctx = createTestCtx({ spec, integration: "qr", db, secrets: { qr_signing_key: qrKey } });
  const stream = await db.insert("stream", { name: "Технологии", capacity: 100 });
  const type = await db.insert("ticket_type", { name: "VIP", kind: "vip", price: 3025, active: true });
  const token = await issueQrToken(ctx);
  const ticket = await db.insert("ticket", {
    ticket_type: type,
    stream,
    holder_name: "Иван Петров",
    status,
    amount: 3025,
    qr_token: token,
  });
  return { db, ctx, token, ticket };
}

describe("qrCheck", () => {
  test("ok, then duplicate with the first scan time and checkpoint", async () => {
    const { ctx, token } = await setup();
    const first = await qrCheck(ctx, "volunteer", { payload: token, checkpoint: "A", deviceId: "d1" });
    expect(first).toMatchObject({
      forbidden: false,
      body: { status: "ok", ticketTitle: "VIP", details: "Технологии" },
    });
    const again = await qrCheck(ctx, "volunteer", { payload: token, checkpoint: "B", deviceId: "d2" });
    expect(again).toMatchObject({ forbidden: false, body: { status: "duplicate", firstCheckpoint: "A" } });
    expect(again.forbidden === false && again.body.firstScannedAt).toBeTruthy();
  });

  test("20 parallel check-ins of one ticket → exactly one ok", async () => {
    const { ctx, token, db } = await setup();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => qrCheck(ctx, "volunteer", { payload: token, deviceId: `d${i}` })),
    );
    const statuses = results.map((r) => (r.forbidden ? "403" : r.body.status));
    expect(statuses.filter((s) => s === "ok")).toHaveLength(1);
    expect(statuses.filter((s) => s === "duplicate")).toHaveLength(19);
    expect(await db.list("checkin")).toHaveLength(1);
  });

  test("role outside scannerRoles → forbidden", async () => {
    const { ctx, token } = await setup();
    expect(await qrCheck(ctx, "participant", { payload: token, deviceId: "d" })).toEqual({ forbidden: true });
  });

  test("forged payload → invalid/bad_signature; unknown signed token → not_found", async () => {
    const { ctx, token } = await setup();
    const forged = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(await qrCheck(ctx, "volunteer", { payload: forged, deviceId: "d" })).toMatchObject({
      body: { status: "invalid", reason: "bad_signature" },
    });
    const other = await issueQrToken(ctx);
    expect(await qrCheck(ctx, "volunteer", { payload: other, deviceId: "d" })).toMatchObject({
      body: { status: "invalid", reason: "not_found" },
    });
  });

  test("token signed by another key or for prod → bad_signature", async () => {
    const { ctx } = await setup();
    const foreign = signQrToken(newQrKeyring(), { systemId: ctx.system.id, env: "draft" });
    expect(await qrCheck(ctx, "volunteer", { payload: foreign, deviceId: "d" })).toMatchObject({
      body: { reason: "bad_signature" },
    });
  });

  test("status outside validStatuses → not_valid_status", async () => {
    const { ctx, token } = await setup("pending_payment");
    expect(await qrCheck(ctx, "organizer", { payload: token, deviceId: "d" })).toMatchObject({
      body: { status: "invalid", reason: "not_valid_status" },
    });
  });

  test("revoke: old payload → revoked, new payload passes", async () => {
    const { ctx, token, ticket, db } = await setup();
    await invokeAction(qrConnector, "revoke", ctx, { entity: "ticket", id: ticket });
    const row = await db.get("ticket", ticket);
    expect(row?.qr_token).not.toBe(token);
    expect(await qrCheck(ctx, "volunteer", { payload: token, deviceId: "d" })).toMatchObject({
      body: { status: "invalid", reason: "revoked" },
    });
    expect(await qrCheck(ctx, "volunteer", { payload: String(row?.qr_token), deviceId: "d" })).toMatchObject({
      body: { status: "ok" },
    });
  });

  test("logs of the QR flow never contain the payload", async () => {
    const { ctx, token, ticket } = await setup();
    await qrCheck(ctx, "volunteer", { payload: token, deviceId: "d" });
    await invokeAction(qrConnector, "revoke", ctx, { entity: "ticket", id: ticket });
    expect(JSON.stringify(ctx.logs)).not.toContain(token.split(".")[2]);
  });

  test("missing signing key → SECRET_MISSING", async () => {
    const ctx = createTestCtx({ spec, integration: "qr" });
    await expect(issueQrToken(ctx)).rejects.toMatchObject({ code: "SECRET_MISSING" });
  });
});
