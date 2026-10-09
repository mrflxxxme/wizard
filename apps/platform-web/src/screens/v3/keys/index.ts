// V3-21 «Окно ключа в чате» of platform-web: interception of keys typed into the chat, the platform's window with the
// recipient hosts, encryption in the browser (WebCrypto), the result, rotation, re-check and removal.
/** API client of /systems/:id/secrets* and /secret-windows* (mounted as api.keys). */
export {
  createKeysClient,
  type KeyCheckLine,
  type KeyEnv,
  type KeySubmitResult,
  type KeysClient,
  type KeysState,
  type KeyWindow,
  type KeyWindowWithKey,
  type NeededKey,
  type PassportForm,
  type SystemKey,
} from "./client.js";
/** The window form, the result card and the client-side format check (mirror of the server's rules). */
export { Hosts, KeyResult, KeyWindowForm, keyFormatProblem } from "./KeyWindow.js";
/** Encryption of a key for a window: P-256 ECDH + HKDF-SHA-256 + AES-256-GCM. */
export {
  canSeal,
  type SealedSecret,
  sealSecret,
  WINDOW_ALG,
  WINDOW_VERSION,
  type WindowPublicKey,
} from "./seal.js";
/** Russian texts. */
export { keysRu } from "./texts.js";
/** The canvas hook: intercept(text), the card above the dock, the keys row above the composer. */
export { type KeyWindows, type KeyWindowsOptions, useKeyWindows } from "./useKeyWindows.js";
