// Draft preview link of a system (getPreviewUrl, adminFounderReviewPreview): a one-time HMAC preview-login token in
// the cloud (runtime.yaml#auth.preview_login_M2, exp ≤ 15 min), dev-login/dev-logout locally (M0).
import type { AppSpec } from "@wizard/appspec";
import { issuePreviewToken, newPreviewNonce, PREVIEW_TOKEN_TTL_MS } from "@wizard/runtime";
import type { Config } from "../config.js";
import { invalid } from "../errors.js";
import { systemOrigin } from "./prod.js";

export interface PreviewTarget {
  schema_key: string;
  slug: string;
}

/** URL that opens the draft as `role` (default: the public role, else the first one) for `userId`. */
export function draftPreviewUrl(
  config: Config,
  s: PreviewTarget,
  revision: number,
  spec: AppSpec,
  userId: string,
  wanted?: string,
) {
  const roles = spec.roles ?? [];
  const role = wanted ?? (roles.find((x) => x.access === "public") ?? roles[0])?.name;
  if (!role || !roles.some((x) => x.name === role)) throw invalid("Такой роли нет в системе");
  const origin = systemOrigin(config, s.slug, "draft");
  // A minute below the 15-min ceiling: the runtime checks exp ≤ its now + 15 min, so clock skew cannot reject it.
  const exp = Date.now() + PREVIEW_TOKEN_TTL_MS - 60_000;
  let path: string;
  if (config.previewSecret) {
    const t = issuePreviewToken(config.previewSecret, {
      systemId: s.schema_key,
      env: "draft",
      role,
      revision,
      platformUserId: userId,
      exp,
      nonce: newPreviewNonce(),
    });
    path = `/_wizard/preview-login?t=${encodeURIComponent(t)}&next=/`;
  } else {
    // M0: a public role has no login — runtime dev-login answers 404 for it, dev-logout drops the draft session.
    const isPublic = roles.find((x) => x.name === role)?.access === "public";
    path = isPublic
      ? "/_wizard/dev-logout?next=/"
      : `/_wizard/dev-login?role=${encodeURIComponent(role)}&next=/`;
  }
  return {
    url: `${origin}${path}`,
    revision,
    roles: roles.map((x) => ({ name: x.name, label: x.label })),
    expiresAt: new Date(exp).toISOString(),
  };
}
