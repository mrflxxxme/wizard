#!/usr/bin/env node
// One-time reinstall of a VM the founder handed over to the pilot (founder, 2026-10-03: the VM is dedicated to Wizard),
// run by OpenTofu (infra/tofu/timeweb/modules/env, terraform_data.adopt — once per server id):
//   the server must exist and carry the expected public IP (never reinstall the wrong one) → the admin SSH key is
//   attached → Ubuntu 24.04 is reinstalled with the k3s bootstrap as cloud-init (the same template as a created VM) →
//   wait until the server is up again. The public IP stays. k3s readiness is then awaited by infra.mjs over SSH.
// Inputs (environment): TWC_TOKEN, WIZARD_ADOPT_SERVER_ID, WIZARD_ADOPT_SERVER_IP, WIZARD_ADOPT_OS_ID,
// WIZARD_ADOPT_SSH_KEY_ID, WIZARD_ADOPT_CLOUD_INIT.
import { fileURLToPath } from "node:url";
import { twcClient } from "./pilot.mjs";

/** IPv4 addresses of a Timeweb server, any network. */
export const serverIpv4 = (s) =>
  (s?.networks ?? []).flatMap((n) => (n.ips ?? []).filter((i) => i.type === "ipv4").map((i) => i.ip));

export async function adoptServer(
  api,
  { id, ip, osId, sshKeyId, cloudInit },
  {
    log = () => {},
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    startWaitMs = 180_000,
    doneWaitMs = 1_800_000,
    pollMs = 15_000,
  } = {},
) {
  if (!id || !ip || !osId || !cloudInit) throw new Error("adopt: нет id, IP, ОС или cloud-init");
  const { server } = await api("GET", `/api/v1/servers/${id}`);
  if (!server) throw new Error(`adopt: сервер ${id} не найден`);
  if (!serverIpv4(server).includes(ip))
    throw new Error(`adopt: у сервера ${id} нет IP ${ip} — переустановка отменена`);
  log(`сервер ${id} «${server.name}» (${ip}): переустанавливаю Ubuntu 24.04 с установкой k3s`);
  if (sshKeyId) {
    await api("POST", `/api/v1/servers/${id}/ssh-keys`, { ssh_key_ids: [Number(sshKeyId)] }).catch((e) =>
      log(`::warning title=pilot::ключ SSH через API не добавлен (${e.message}); его добавит cloud-init`),
    );
  }
  await api("PATCH", `/api/v1/servers/${id}`, { os_id: Number(osId), cloud_init: cloudInit });
  const status = async () => (await api("GET", `/api/v1/servers/${id}`)).server?.status;
  let started = false;
  for (let waited = 0; waited < startWaitMs; waited += pollMs) {
    await sleep(pollMs);
    const s = await status();
    if (s !== "on") {
      log(`сервер ${id}: ${s}`);
      started = true;
      break;
    }
  }
  if (!started)
    log(`::warning title=pilot::сервер ${id} не сменил статус за ${startWaitMs / 1000} с — продолжаю`);
  for (let waited = 0; waited < doneWaitMs; waited += pollMs) {
    const s = await status();
    if (s === "on") {
      log(`сервер ${id}: переустановлен и включён`);
      return;
    }
    await sleep(pollMs);
  }
  throw new Error(`adopt: сервер ${id} не включился за ${doneWaitMs / 60_000} мин после переустановки`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const e = process.env;
  adoptServer(
    twcClient({ token: e.TWC_TOKEN }),
    {
      id: e.WIZARD_ADOPT_SERVER_ID,
      ip: e.WIZARD_ADOPT_SERVER_IP,
      osId: e.WIZARD_ADOPT_OS_ID,
      sshKeyId: e.WIZARD_ADOPT_SSH_KEY_ID,
      cloudInit: e.WIZARD_ADOPT_CLOUD_INIT,
    },
    { log: (s) => console.log(s) },
  ).then(
    () => process.exit(0),
    (err) => {
      console.error(`::error title=pilot::${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
