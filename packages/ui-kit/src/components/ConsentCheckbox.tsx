// ConsentCheckbox (ui-kit.yaml#components.ConsentCheckbox; security/compliance.yaml#system_package.consent.ui).
import type { ReactNode } from "react";
import { cx, useRoleSpec, useWzRoot } from "../data/context.js";
import { ru } from "../i18n/ru.js";
import styles from "./ConsentCheckbox.module.css";
import type { RootAttrs } from "./root.js";
import type { ConsentCheckboxProps } from "./types.js";

export function ConsentCheckbox(props: ConsentCheckboxProps): ReactNode {
  return <ConsentCheckboxImpl {...props} root={useWzRoot("ConsentCheckbox", "wz-consent", props)} />;
}

export function ConsentCheckboxImpl({
  root,
  checked,
  onChange,
  error,
  className,
}: ConsentCheckboxProps & { root: RootAttrs }): ReactNode {
  const spec = useRoleSpec();
  const id = `${root["data-testid"]}-${root["data-wz-id"] ?? "input"}`.replace(/[^A-Za-z0-9_:.-]/g, "_");
  const errId = `${id}-error`;
  const text = spec.compliance?.consentText ?? ru.consent.defaultText;
  const policy = spec.compliance?.policyPage;
  return (
    <div {...root} className={cx(styles.consent, className)}>
      <div className={styles.row}>
        <input
          id={id}
          type="checkbox"
          className={styles.box}
          checked={checked}
          // Only a user event changes the value: the component never checks itself.
          onChange={(e) => onChange(e.target.checked)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errId : undefined}
          required
        />
        <label htmlFor={id} className={styles.text}>
          {text}
          {policy && (
            <>
              {" "}
              {ru.consent.policyPrefix}{" "}
              <a
                href={policy}
                target="_blank"
                rel="noopener"
                data-testid="wz-consent-policy-link"
                className={styles.link}
              >
                {ru.consent.policyLink}
              </a>
            </>
          )}
        </label>
      </div>
      {error && (
        <p id={errId} className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
