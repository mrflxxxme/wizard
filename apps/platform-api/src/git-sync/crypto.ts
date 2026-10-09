// Secrets of the repository sync (V3-31): the tokens of a connection sealed as BYOK keys are (envelope encryption, a data
// key per seal, AAD repo:<org>:<link>, the data key wrapped by the KMS); the signed state of the OAuth and installation
// redirects (HMAC, 15 min) with the PKCE verifier derived from it; constant-time checks of webhook signatures.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { openKey, sealKey, type TransitKms } from "../byok/kms.js";
import type { SecretStore } from "../secrets/store.js";

/** What a connection keeps sealed (only what its provider needs). */
export interface RepoSecrets {
  /** GitLab OAuth access token (2 h) and its refresh token. GitHub keeps none: installation tokens are minted per hour. */
  accessToken?: string;
  refreshToken?: string;
  /** ms since epoch. */
  expiresAt?: number;
  /** Self-managed GitLab: the OAuth application the owner registered on their instance. */
  clientId?: string;
  clientSecret?: string;
  /** GitLab project hook token (X-Gitlab-Token). */
  webhookSecret?: string;
  /** Id of the project hook Wizard created (removed on disconnect). */
  hookId?: string;
}

export interface SealedRow {
  ciphertext: string;
  wrappedDek: string;
  kekBackend: "local" | "openbao";
  kekName: string;
}

export const repoAad = (orgId: string, linkId: string): string => `repo:${orgId}:${linkId}`;

export async function sealSecrets(
  kms: TransitKms,
  orgId: string,
  linkId: string,
  s: RepoSecrets,
): Promise<SealedRow> {
  const sealed = await sealKey(kms, repoAad(orgId, linkId), JSON.stringify(s));
  return { ...sealed, kekBackend: kms.backend, kekName: kms.keyName };
}

export async function openSecrets(
  kms: TransitKms,
  orgId: string,
  linkId: string,
  row: { ciphertext: string | null; wrapped_dek: string | null },
): Promise<RepoSecrets> {
  if (!row.ciphertext || !row.wrapped_dek) return {};
  return JSON.parse(
    await openKey(kms, repoAad(orgId, linkId), { ciphertext: row.ciphertext, wrappedDek: row.wrapped_dek }),
  ) as RepoSecrets;
}

const b64url = (b: Buffer): string => b.toString("base64url");

/** What a redirect's `state` carries. */
export interface RedirectState {
  /** A system's repository link (V3-31); absent for a repository of the agent (V3-32). */
  systemId?: string;
  /** V3-32: «agent» — a repository connected to an org for the agent; its org. */
  target?: "agent";
  orgId?: string;
  userId: string;
  provider: "github" | "gitlab";
  /** The pending connection row (GitLab: a link or an agent repository). */
  linkId?: string;
}

/** Signs and checks the `state` of redirects: {system | agent org, user, provider, link, nonce, exp}. */
export class StateSigner {
  readonly #key: Buffer;
  constructor(key: Buffer) {
    this.#key = key;
  }

  /** WIZARD_SECRETS_KEY when set (HKDF), else a random key kept in the local secret store. */
  static of(secretsKey: string, secrets: SecretStore | undefined): StateSigner {
    if (secretsKey)
      return new StateSigner(Buffer.from(hkdfSync("sha256", secretsKey, "wizard", "git-sync-state", 32)));
    let k = secrets?.getPlatform("git-sync/state-key");
    if (!k) {
      k = randomBytes(32).toString("base64");
      secrets?.putPlatform("git-sync/state-key", k);
    }
    return new StateSigner(Buffer.from(k, "base64"));
  }

  #mac(payload: string): string {
    return b64url(createHmac("sha256", this.#key).update(payload).digest());
  }

  sign(data: RedirectState, ttlMs = 15 * 60_000) {
    const payload = b64url(
      Buffer.from(JSON.stringify({ ...data, nonce: b64url(randomBytes(16)), exp: Date.now() + ttlMs })),
    );
    return `${payload}.${this.#mac(payload)}`;
  }

  verify(state: string | undefined): (RedirectState & { nonce: string }) | null {
    if (!state || state.length > 2000) return null;
    const [payload, mac] = state.split(".");
    if (!payload || !mac) return null;
    const want = Buffer.from(this.#mac(payload));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const v = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (typeof v.exp !== "number" || v.exp < Date.now()) return null;
      return v;
    } catch {
      return null;
    }
  }

  /** PKCE verifier of a state nonce (RFC 7636, 43 characters) and its S256 challenge. */
  pkce(nonce: string): { verifier: string; challenge: string } {
    const verifier = b64url(createHmac("sha256", this.#key).update(`pkce:${nonce}`).digest());
    return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
  }
}

/** Constant-time equality of two strings (webhook tokens and signatures). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** GitHub X-Hub-Signature-256: sha256=<hex HMAC of the raw body>. */
export function githubSignatureOk(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const want = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return safeEqual(want, header);
}

export const newWebhookSecret = (): string => b64url(randomBytes(32));
