// The ready notice of a v3 build in the browser (V3-17): the Notification API when the owner allowed it; the in-app
// toast does not depend on it and the e-mail goes from the harness. Every call is guarded: some browsers have no
// page notifications (Android Chrome throws on `new Notification`), private windows may block storage.

export type NotifyState = "unsupported" | "default" | "granted" | "denied";

const api = (): typeof Notification | null =>
  typeof window !== "undefined" && "Notification" in window ? window.Notification : null;

/** Whether the browser can notify and what the owner said. */
export function notifyState(): NotifyState {
  try {
    const N = api();
    return N ? (N.permission as NotifyState) : "unsupported";
  } catch {
    return "unsupported";
  }
}

/** Asks the owner (only on their click); the answer, or the state as it is when the browser refuses to ask. */
export async function askNotify(): Promise<NotifyState> {
  try {
    const N = api();
    if (!N) return "unsupported";
    return (await N.requestPermission()) as NotifyState;
  } catch {
    return notifyState();
  }
}

/** Shows the browser notice when allowed; a click brings the tab back. true — shown. */
export function showNotice(title: string, body: string, tag: string): boolean {
  if (notifyState() !== "granted") return false;
  try {
    const N = api() as typeof Notification;
    const n = new N(title, { body, tag });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

/** Once per run and browser (a reload right after the end does not notify twice). */
export function firstNotice(runId: string): boolean {
  const key = `wz.v3.ready.${runId}`;
  try {
    if (window.localStorage.getItem(key)) return false;
    window.localStorage.setItem(key, "1");
  } catch {
    // Storage blocked: the in-memory guard of the page still holds.
  }
  return true;
}
