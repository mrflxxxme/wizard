#!/usr/bin/env node
// Memory/CPU sampler for sizing the pilot VM (docs/ops/deploy.md «Пилот: замер»). Linux /proc only, no deps.
//   node tools/deploy/rss-sample.mjs --out <file.json> [--interval 500] [--phase-file <path>]
// Every interval it reads RSS (VmRSS) and CPU ticks of every process, classifies it by command line (classify()),
// and keeps per phase and class: peak RSS sum, mean RSS sum, CPU seconds and peak CPU (cores over one interval).
// The phase is the first line of --phase-file (e.g. "idle", "build"), so a driver script can mark phases.
// SIGINT/SIGTERM writes the JSON report and exits.
import { readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Service class of a process by its command line and working directory (null → not ours). Launch wrappers (pnpm, the
 * tsx CLI parent) are skipped: in the images each service is one `node --import tsx` process (infra/docker).
 */
export function classify(cmd, cwd = "") {
  if (/\bworkerd\b.*\bserve\b/.test(cmd)) return "workerd";
  if (/(^|\/)pnpm(\.cjs)?\s|tsx\/dist\/cli\.mjs|\bsh -c\b/.test(cmd)) return null;
  if (/postgres(:|\s|$)|\/postgres\b/.test(cmd) && !/psql/.test(cmd)) return "postgres";
  if (/pgbouncer/.test(cmd)) return "pgbouncer";
  if (/chrom(e|ium)|headless_shell|playwright/.test(cmd)) return null;
  const where = `${cwd} ${cmd}`;
  if (/egress-main/.test(cmd)) return "egress-proxy";
  if (/apps\/platform-api\b/.test(where)) return "platform-api";
  if (/apps\/worker\b/.test(where)) return "worker";
  if (/apps\/runtime\b/.test(where)) return "runtime";
  if (/\bvite\b|apps\/platform-web\b/.test(where)) return "platform-web(vite dev)";
  if (/stand\/m[12]\.ts/.test(cmd)) return "e2e-stand(other)";
  if (/esbuild/.test(cmd)) return "esbuild(build)";
  if (/\btsc\b|typescript\/bin/.test(cmd)) return "tsc(build)";
  return null;
}

/** Parses /proc/<pid>/stat → utime+stime ticks (fields 14, 15 after the parenthesised comm). */
export function cpuTicks(stat) {
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(rest[11]) + Number(rest[12]);
}

/** VmRSS in KiB from /proc/<pid>/status. */
export function rssKib(status) {
  const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
  return m ? Number(m[1]) : 0;
}

function snapshot() {
  const out = [];
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
      let cwd = "";
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        // no access to the cwd of a foreign process
      }
      const cls = classify(cmd, cwd);
      if (!cls) continue;
      out.push({
        pid,
        cls,
        rss: rssKib(readFileSync(`/proc/${pid}/status`, "utf8")),
        ticks: cpuTicks(readFileSync(`/proc/${pid}/stat`, "utf8")),
      });
    } catch {
      // process exited between readdir and read
    }
  }
  return out;
}

/** Folds snapshots into {phase: {class: {peakMiB, meanMiB, cpuSec, peakCores, samples}}}. */
export function createAccumulator(hz = 100) {
  const phases = {};
  let prev = new Map();
  let prevAt = null;
  return {
    add(phase, snap, at) {
      phases[phase] ??= {};
      const p = phases[phase];
      const sums = {};
      const cpu = {};
      for (const s of snap) {
        sums[s.cls] = (sums[s.cls] ?? 0) + s.rss;
        const before = prev.get(s.pid);
        if (before !== undefined && s.ticks >= before) cpu[s.cls] = (cpu[s.cls] ?? 0) + (s.ticks - before);
      }
      const dt = prevAt === null ? 0 : (at - prevAt) / 1000;
      for (const cls of new Set([...Object.keys(sums), ...Object.keys(cpu)])) {
        p[cls] ??= { peakMiB: 0, sumMiB: 0, samples: 0, cpuSec: 0, peakCores: 0 };
        const c = p[cls];
        const mib = (sums[cls] ?? 0) / 1024;
        c.peakMiB = Math.max(c.peakMiB, mib);
        c.sumMiB += mib;
        c.samples++;
        const sec = (cpu[cls] ?? 0) / hz;
        c.cpuSec += sec;
        if (dt > 0) c.peakCores = Math.max(c.peakCores, sec / dt);
      }
      prev = new Map(snap.map((s) => [s.pid, s.ticks]));
      prevAt = at;
    },
    report() {
      const r = {};
      for (const [phase, classes] of Object.entries(phases)) {
        r[phase] = {};
        for (const [cls, c] of Object.entries(classes)) {
          r[phase][cls] = {
            peakMiB: Math.round(c.peakMiB),
            meanMiB: Math.round(c.sumMiB / Math.max(c.samples, 1)),
            cpuSec: Math.round(c.cpuSec * 10) / 10,
            peakCores: Math.round(c.peakCores * 100) / 100,
          };
        }
      }
      return r;
    },
  };
}

function main(argv) {
  const arg = (k, d) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : d;
  };
  const out = arg("--out");
  if (!out) throw new Error("--out is required");
  const interval = Number(arg("--interval", "500"));
  const phaseFile = arg("--phase-file");
  const acc = createAccumulator();
  const phase = () => {
    if (!phaseFile) return "all";
    try {
      return readFileSync(phaseFile, "utf8").split("\n")[0].trim() || "none";
    } catch {
      return "none";
    }
  };
  const timer = setInterval(() => acc.add(phase(), snapshot(), Date.now()), interval);
  const stop = () => {
    clearInterval(timer);
    writeFileSync(out, `${JSON.stringify(acc.report(), null, 2)}\n`);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
