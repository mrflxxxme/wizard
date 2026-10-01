// M2-01 acceptance, CI job `sandbox` only (WIZARD_SANDBOX_E2E=1; docker with the gVisor runtime `runsc`, the
// amicontained binary in AMICONTAINED_BIN). A container started with the security settings of sandboxPod()
// (security/isolation.yaml#M2.pods) is inspected read-only: the off-the-shelf audit tool amicontained reports runtime,
// capabilities and seccomp; a few plain shell checks report what the container can see. Only negative-capability
// assertions: gVisor kernel, no capabilities, seccomp on, no service-account secrets, no host env or files, and no
// network except the egress-proxy address on the pod network.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sandboxPod } from "../../src/index.js";
import { dockerFlagsOf } from "./pod-docker.js";

const E2E = process.env.WIZARD_SANDBOX_E2E === "1";
const exec = promisify(execFile);
/** Small image with a shell for the checks (CI only, pinned in the workflow). */
const IMAGE = process.env.WIZARD_SANDBOX_PROBE_IMAGE ?? "busybox:1.36.1";
const AMICONTAINED = process.env.AMICONTAINED_BIN ?? "";

const docker = async (args: string[], timeoutMs = 120_000) =>
  (await exec("docker", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })).stdout;

/** Read-only checks inside the container; prints key=value lines. $1 = egress-proxy IP, $2 = a host path. */
const CHECKS = `
echo "uname=$(uname -r)"
echo "uid=$(id -u)"
for k in CapInh CapPrm CapEff CapBnd CapAmb NoNewPrivs Seccomp; do
  echo "$k=$(grep "^$k:" /proc/self/status | tr -d ' \\t' | cut -d: -f2)"
done
if dmesg 2>/dev/null | grep -q gVisor; then echo dmesg=gvisor; else echo dmesg=other; fi
if touch /wz-probe 2>/dev/null; then echo rootfs=writable; else echo rootfs=readonly; fi
if ls /var/run/secrets >/dev/null 2>&1; then echo secrets=present; else echo secrets=absent; fi
if cat /var/run/secrets/kubernetes.io/serviceaccount/token >/dev/null 2>&1; then echo satoken=readable; else echo satoken=unreadable; fi
if [ -e "$2" ]; then echo hostpath=visible; else echo hostpath=absent; fi
echo "envnames=$( (env; tr '\\0' '\\n' </proc/self/environ; tr '\\0' '\\n' </proc/1/environ) 2>/dev/null | cut -d= -f1 | sort -u | tr '\\n' ',')"
echo "envdump=$( (env; tr '\\0' '\\n' </proc/self/environ; tr '\\0' '\\n' </proc/1/environ) 2>/dev/null | tr '\\n' ' ')"
if nc -w 5 1.1.1.1 443 </dev/null >/dev/null 2>&1; then echo ext_tcp=connected; else echo ext_tcp=failed; fi
if wget -q -T 5 -O /dev/null http://example.com/ 2>/dev/null; then echo ext_http=ok; else echo ext_http=failed; fi
if nslookup example.com >/dev/null 2>&1; then echo dns=resolved; else echo dns=failed; fi
echo "proxy=$(wget -q -T 5 -O - "http://$1:3128/" 2>/dev/null)"
`;

function kv(out: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) r[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return r;
}

/** amicontained report → runtime, seccomp mode, capability lines. */
function parseAmicontained(out: string): { runtime: string; seccomp: string; capLines: string[] } {
  const runtime = /^Container Runtime: (.*)$/m.exec(out)?.[1]?.trim() ?? "";
  const seccomp = /^Seccomp: (.*)$/m.exec(out)?.[1]?.trim() ?? "";
  const capLines: string[] = [];
  const lines = out.split("\n");
  const start = lines.indexOf("Capabilities:");
  if (start >= 0) {
    for (const l of lines.slice(start + 1)) {
      if (!l.startsWith("\t")) break;
      capLines.push(l.trim());
    }
  }
  return { runtime, seccomp, capLines };
}

describe.skipIf(!E2E)("gVisor container with the sandbox pod's settings (CI sandbox job)", () => {
  const tag = randomBytes(4).toString("hex");
  const net = `wz-sbx-${tag}`;
  const proxyName = `wz-egress-${tag}`;
  const canary = `wzcanary${randomBytes(12).toString("hex")}`;
  let flags: string[];
  let proxyIp = "";

  beforeAll(async () => {
    expect(AMICONTAINED, "AMICONTAINED_BIN").not.toBe("");
    process.env.WZ_HOST_CANARY = canary;
    flags = dockerFlagsOf(
      sandboxPod({
        name: "probe",
        namespace: "sandbox",
        pool: "sandbox-free",
        image: IMAGE,
        configMap: "probe",
        basePort: 8081,
        systems: 1,
        healthPort: 8080,
      }),
    );
    // Pod network stand-in: internal (no route out); the only peer is an "egress-proxy" answering on :3128.
    await docker(["network", "create", "--internal", net]);
    await docker([
      "run",
      "-d",
      "--rm",
      "--name",
      proxyName,
      "--network",
      net,
      IMAGE,
      "sh",
      "-c",
      "mkdir -p /tmp/www && echo ok > /tmp/www/index.html && exec httpd -f -p 3128 -h /tmp/www",
    ]);
    proxyIp = (
      await docker(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", proxyName])
    ).trim();
    expect(proxyIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  }, 180_000);

  afterAll(async () => {
    delete process.env.WZ_HOST_CANARY;
    await docker(["rm", "-f", proxyName]).catch(() => "");
    await docker(["network", "rm", net]).catch(() => "");
  });

  it("precondition: the runner itself reaches the internet (so failures inside are the sandbox's)", async () => {
    await new Promise<void>((resolve, reject) => {
      const s = connect({ host: "1.1.1.1", port: 443, timeout: 5000 }, () => {
        s.destroy();
        resolve();
      });
      s.on("timeout", () => reject(new Error("timeout")));
      s.on("error", reject);
    });
  });

  it("amicontained: gVisor runtime, no capabilities, seccomp filtering", async () => {
    const out = await docker(
      [
        "run",
        "--rm",
        ...flags,
        "--network",
        net,
        "-v",
        `${AMICONTAINED}:/opt/amicontained:ro`,
        IMAGE,
        "/opt/amicontained",
      ],
      300_000,
    );
    const r = parseAmicontained(out);
    const uname = kv(
      await docker([
        "run",
        "--rm",
        ...flags,
        "--network",
        "none",
        IMAGE,
        "sh",
        "-c",
        "echo uname=$(uname -r)",
      ]),
    ).uname;
    // amicontained checks cgroups before /__runsc_containers__, so under docker it may print "docker";
    // the gVisor kernel then shows in uname (the sentry reports a fixed 4.4.0 kernel).
    expect(r.runtime === "gvisor" || uname === "4.4.0", `runtime=${r.runtime} uname=${uname}\n${out}`).toBe(
      true,
    );
    expect(r.seccomp, out).toBe("filtering");
    expect(r.capLines, out).toEqual([]);
  }, 300_000);

  it("plain checks: gVisor kernel, no caps, read-only root, no secrets, no host env or files, network only to the proxy", async () => {
    const out = await docker(
      ["run", "--rm", ...flags, "--network", net, IMAGE, "sh", "-c", CHECKS, "sh", proxyIp, process.cwd()],
      180_000,
    );
    const r = kv(out);
    expect(r.uname === "4.4.0" || r.dmesg === "gvisor", out).toBe(true);
    expect(r.uid).toBe("65532");
    for (const k of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) expect(r[k], k).toMatch(/^0+$/);
    expect(r.NoNewPrivs).toBe("1");
    expect(r.Seccomp).toBe("2");
    expect(r.rootfs).toBe("readonly");
    expect(r.secrets).toBe("absent");
    expect(r.satoken).toBe("unreadable");
    expect(r.hostpath).toBe("absent");
    expect(out).not.toContain(canary);
    const names = (r.envnames ?? "").split(",").filter(Boolean);
    expect(names.filter((n) => /^(WZ_|GITHUB_|RUNNER_|ACTIONS_|WIZARD_)/.test(n))).toEqual([]);
    expect(r.ext_tcp).toBe("failed");
    expect(r.ext_http).toBe("failed");
    expect(r.dns).toBe("failed");
    expect(r.proxy).toBe("ok");
  }, 180_000);
});
