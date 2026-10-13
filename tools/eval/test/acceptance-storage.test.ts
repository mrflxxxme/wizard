// V4 acceptance: the job reads prod's photo library through, writes only its own files (prod's bucket is only read).
import { describe, expect, test } from "vitest";
import { MemoryFileStorage } from "../../../apps/runtime/src/files/storage.ts";
import { ReadThroughStorage, rowStatus } from "../acceptance/v4.ts";

const meta = { name: "x", mime: "image/webp", size: 1, entity: "e", field: "f", uploadedBy: null, uploadedAt: "now" } as const;
const KEY = "wz_photos/00000000-0000-4000-8000-000000000001";
const OWN = "wz_reports/00000000-0000-4000-8000-000000000002";

describe("acceptance storage: read through, write local", () => {
  test("a library file is read from prod; the run's files are written and deleted only locally", async () => {
    const local = new MemoryFileStorage();
    const remote = new MemoryFileStorage();
    await remote.put(KEY, new Uint8Array([1]), meta);
    const s = new ReadThroughStorage(local, remote);
    expect((await s.get(KEY))?.data).toEqual(new Uint8Array([1]));
    expect(await s.head(KEY)).toMatchObject({ name: "x" });
    await s.put(OWN, new Uint8Array([2]), meta);
    expect(await remote.get(OWN)).toBeNull();
    expect((await local.get(OWN))?.data).toEqual(new Uint8Array([2]));
    expect(await s.list("wz_photos/")).toEqual([KEY]);
    await s.delete(KEY);
    expect(await remote.get(KEY)).not.toBeNull();
  });
});

describe("acceptance table: the outcome of a brief", () => {
  test("ready, or not ready with the build's status and its failed must scenarios", () => {
    expect(rowStatus({ ready: true, status: "ready", build: { status: "succeeded" } })).toBe("готова");
    const list = [
      { id: "s1", priority: "must", status: "failed" },
      { id: "s2", priority: "should", status: "failed" },
      { id: "s3", priority: "must", status: "passed" },
    ];
    expect(rowStatus({ ready: false, status: "not_ready", build: { status: "succeeded", scenarios: { list } } })).toBe(
      "не готова (not_ready; сборка succeeded; must ✗ s1)",
    );
    expect(rowStatus({ status: "failed", build: null })).toBe("не готова (failed)");
  });
});
