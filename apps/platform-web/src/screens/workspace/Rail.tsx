// Rail of the workspace (platform-screens.yaml#regions.rail): logo → /, «+» new system, system settings (M1, S10).
import type { ReactNode } from "react";
import { navigate } from "../../app/router.js";
import { ru } from "../../i18n/ru.js";
import s from "./Workspace.module.css";

function RailLink({
  to,
  label,
  className,
  children,
}: {
  to: string;
  label: string;
  className: string | undefined;
  children: ReactNode;
}): ReactNode {
  return (
    <a
      href={to}
      className={className}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function Rail({ systemId }: { systemId?: string }): ReactNode {
  return (
    <nav className={s.rail} aria-label={ru.appName}>
      <RailLink to="/" label={ru.rail.home} className={s.logo}>
        W
      </RailLink>
      <RailLink to="/" label={ru.rail.newSystem} className={s.railButton}>
        +
      </RailLink>
      {systemId && (
        <RailLink to={`/s/${systemId}/settings`} label={ru.rail.settings} className={s.railButton}>
          <span aria-hidden="true" data-testid="rail-settings">
            ⚙
          </span>
        </RailLink>
      )}
    </nav>
  );
}
