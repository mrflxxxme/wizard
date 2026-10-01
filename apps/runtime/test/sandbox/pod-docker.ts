// `docker run` flags reproducing a sandbox pod's security settings (pod.ts) for the CI sandbox job, where the
// container runs under gVisor (`--runtime=runsc`) on a disposable runner. Throws if the manifest changes shape, so the
// CI reproduction cannot silently drift from what is deployed.

// biome-ignore lint/suspicious/noExplicitAny: walking a plain manifest object
type Obj = Record<string, any>;

export function dockerFlagsOf(pod: Obj): string[] {
  const spec = pod.spec as Obj;
  const c = (spec.containers as Obj[])[0] as Obj;
  const sc = c.securityContext as Obj;
  const psc = spec.securityContext as Obj;
  if (spec.runtimeClassName !== "gvisor") throw new Error("pod is not gVisor");
  if (psc.runAsNonRoot !== true || !(psc.runAsUser > 0)) throw new Error("pod runs as root");
  if (psc.seccompProfile?.type !== "RuntimeDefault") throw new Error("seccomp profile changed");
  if (
    sc.allowPrivilegeEscalation !== false ||
    sc.readOnlyRootFilesystem !== true ||
    sc.privileged !== false
  ) {
    throw new Error("container securityContext changed");
  }
  if (JSON.stringify(sc.capabilities) !== JSON.stringify({ drop: ["ALL"] }))
    throw new Error("capabilities changed");
  if (spec.automountServiceAccountToken !== false || spec.hostNetwork || spec.hostPID || spec.hostIPC) {
    throw new Error("pod host access changed");
  }
  const mem = String(c.resources.limits.memory);
  if (!/^\d+Mi$/.test(mem)) throw new Error(`memory limit ${mem}`);
  return [
    "--runtime=runsc",
    `--user=${psc.runAsUser}:${psc.runAsGroup}`,
    "--read-only",
    "--cap-drop=ALL",
    // docker's default seccomp profile = RuntimeDefault (runsc applies it with --oci-seccomp, see the workflow)
    "--security-opt=no-new-privileges",
    `--memory=${mem.replace(/Mi$/, "m")}`,
    `--cpus=${c.resources.limits.cpu}`,
    "--pids-limit=256",
    "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
  ];
}
