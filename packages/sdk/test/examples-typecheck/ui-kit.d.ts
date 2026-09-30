// Minimal stand-in for @wizard/ui-kit (M0-08 not implemented yet): components used by
// specs/runtime/examples/ui with permissive props. Only @wizard/sdk types are under test here.
declare module "@wizard/ui-kit" {
  import type { ReactNode } from "react";

  type Props = { children?: ReactNode; [prop: string]: unknown };
  type Component = (props: Props) => ReactNode;

  export const AppShell: Component;
  export const Badge: Component;
  export const Button: Component;
  export const CabinetLayout: Component;
  export const Catalog: Component;
  export const DataTable: Component;
  export const Field: Component;
  export const QrScanner: Component;
  export const QrTicket: Component;
  export const RecordCard: Component;
}
