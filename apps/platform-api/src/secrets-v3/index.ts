// V3-21 «Окно ключа в чате» of platform-api (security/data-boundary.yaml#secret_window): browser-encrypted keys of
// external APIs stored as secret://<name> of a system, sent only to the hosts the window showed, checked by the V3-20
// contract, rotated and removed; keys typed into the chat as text are refused.
/** request_secret for agents, the build hook asking for missing keys, the D37 check of window keys. */
export {
  REQUEST_SECRET_TOOL,
  type RequestSecretToolResult,
  requestMissingKeys,
  runRequestSecret,
  type SecretEgressIssue,
  secretEgressIssues,
  withKeyWindow,
} from "./agent.js";
/** Window cryptography: P-256 ECDH + HKDF-SHA-256 + AES-256-GCM, context-bound; the server-side mirror for tests. */
export {
  isSealedSecret,
  newWindowKeyPair,
  openSealedSecret,
  SealError,
  type SealedSecret,
  sealForWindow,
  WINDOW_ALG,
  WINDOW_VERSION,
  type WindowPublicKey,
  windowContext,
} from "./crypto.js";
/** Refusal of a chat text that carries an access key (VALIDATION_FAILED, reason SECRET_IN_TEXT). */
export { assertNoSecretInText, SECRET_IN_TEXT_RU } from "./guard.js";
/** The KMS of windows (TransitKms of V3-33 with its own key). */
export { windowKmsOf } from "./kms.js";
/** API passports in the window (V3-22): their fields, the composed key (СДЭК: oauth2cc), the account. */
export {
  adoptAccount,
  composePassportKey,
  passportFields,
  type WindowField,
  type WindowForm,
  type WindowPassport,
  windowForm,
  windowPassport,
} from "./passport.js";
/** HTTP routes of api.yaml (secrets, secret-windows). */
export { type SecretWindowRoutesDeps, secretWindowRoutes } from "./routes.js";
/** The window lifecycle: request, key, submit, cancel, list, re-check, removal. */
export {
  cancelWindow,
  checkSecret,
  listSecrets,
  type NeededKey,
  openConnectorWindow,
  openIntegrationWindow,
  removeSecret,
  requestSecret,
  SECRET_WINDOW_NAME,
  type SecretRequest,
  type SecretView,
  type SecretWindowDeps,
  type SubmitResult,
  submitWindow,
  type WindowKeyView,
  type WindowView,
  windowWithKey,
} from "./service.js";
/** Key rules: format, last 4 characters. */
export { KEY_MAX, KEY_MIN, keyProblem, lastFour } from "./vault.js";
