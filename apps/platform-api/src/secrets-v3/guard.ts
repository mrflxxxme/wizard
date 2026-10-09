// Interception of a key typed as plain text (V3-21; security/data-boundary.yaml#secret_window.interception): the chat
// routes (POST /systems, /systems/:id/messages, /systems/:id/answers) refuse a text with an access key before anything
// is stored or sent to a model — the page offers the key window instead. The refusal names only the kinds found, never
// the value or its position.
import { detectSecrets, type SecretKind } from "@wizard/pii";
import { invalid } from "../errors.js";

/** The refusal text (the page shows it next to the key window). */
export const SECRET_IN_TEXT_RU =
  "Похоже, в сообщении ключ доступа. Мы его не отправили и не сохранили — введите ключ в защищённом окне ключа";

/** Throws VALIDATION_FAILED {reason: SECRET_IN_TEXT, kinds} when any of `texts` carries a key. */
export function assertNoSecretInText(...texts: (string | null | undefined)[]): void {
  const kinds = new Set<SecretKind>();
  const providers = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const f of detectSecrets(t)) {
      kinds.add(f.kind);
      if (f.provider) providers.add(f.provider);
    }
  }
  if (kinds.size === 0) return;
  throw invalid(SECRET_IN_TEXT_RU, {
    reason: "SECRET_IN_TEXT",
    kinds: [...kinds].sort(),
    ...(providers.size ? { providers: [...providers].sort() } : {}),
  });
}
