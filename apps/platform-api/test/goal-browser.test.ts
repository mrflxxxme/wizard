// B2-28: the process browser of plan builds (agents/goal-browser.ts) on a fake launch — one browser per process,
// slots, relaunch after a crash, a missing browser is not retried per build, close.
import { EventEmitter } from "node:events";
import type { Browser } from "@playwright/test";
import { describe, expect, test } from "vitest";
import { g1PlatformConfig } from "../src/agents/g1-platform.js";
import { chromiumProvider } from "../src/agents/goal-browser.js";

function fakeBrowser() {
  const ev = new EventEmitter();
  let connected = true;
  const b = {
    isConnected: () => connected,
    on: (e: string, f: () => void) => ev.on(e, f),
    close: async () => {
      connected = false;
      ev.emit("disconnected");
    },
    crash: () => {
      connected = false;
      ev.emit("disconnected");
    },
  };
  return b as unknown as Browser & { crash(): void };
}

describe("chromiumProvider", () => {
  test("one browser for every build; slots limit the builds at once; release hands the slot over", async () => {
    let launches = 0;
    const p = chromiumProvider({
      slots: 2,
      launch: async () => {
        launches += 1;
        return fakeBrowser();
      },
    });
    expect(await p.available()).toBe(true);
    const a = await p.acquire();
    const b = await p.acquire();
    expect(a?.browser).toBe(b?.browser);
    let third: Awaited<ReturnType<typeof p.acquire>> | undefined;
    const waiting = p.acquire().then((l) => {
      third = l;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(third).toBeUndefined();
    a?.release();
    a?.release();
    await waiting;
    expect(third?.browser).toBe(a?.browser);
    expect(launches).toBe(1);
    // A fourth waits until a slot is free; the abort signal ends the wait.
    const ac = new AbortController();
    const fourth = p.acquire(ac.signal);
    ac.abort();
    expect(await fourth).toBeNull();
    b?.release();
    third?.release();
    await p.close();
  });

  test("a crashed browser is started again for the next build", async () => {
    const made: (Browser & { crash(): void })[] = [];
    const p = chromiumProvider({
      launch: async () => {
        const b = fakeBrowser();
        made.push(b);
        return b;
      },
    });
    const first = await p.acquire();
    first?.release();
    made[0]?.crash();
    const second = await p.acquire();
    expect(second?.browser).toBe(made[1]);
    second?.release();
    await p.close();
    expect(await p.acquire()).toBeNull();
  });

  test("no Chromium: builds go without the browser checks, the launch is not retried for every build", async () => {
    let launches = 0;
    const lines: string[] = [];
    const p = chromiumProvider({
      retryAfterMs: 60_000,
      launch: async () => {
        launches += 1;
        throw new Error("Executable doesn't exist");
      },
      log: (msg) => lines.push(msg),
    });
    expect(await p.available()).toBe(false);
    expect(await p.available()).toBe(false);
    expect(await p.acquire()).toBeNull();
    expect(launches).toBe(1);
    expect(lines).toEqual(["browser_failed"]);
    await p.close();
  });

  test("the wait for a slot ends after waitTimeoutMs", async () => {
    const p = chromiumProvider({ slots: 1, waitTimeoutMs: 30, launch: async () => fakeBrowser() });
    const a = await p.acquire();
    expect(await p.acquire()).toBeNull();
    a?.release();
    const b = await p.acquire();
    expect(b).not.toBeNull();
    b?.release();
    await p.close();
  });
});

test("G1 runtime platform: an address domain for the sender, no network, no platform secrets", async () => {
  const c = g1PlatformConfig({});
  expect(c.mailDomain).toBe("systems.test");
  expect(g1PlatformConfig({ WIZARD_MAIL_DOMAIN: "mail.example.ru" }).mailDomain).toBe("mail.example.ru");
  expect(c.smtp).toBeNull();
  expect(c.devSmtp).toBeNull();
  await expect(c.secrets.get("smtp_password")).rejects.toThrow();
  await expect(c.resolve("example.ru")).rejects.toThrow();
});
