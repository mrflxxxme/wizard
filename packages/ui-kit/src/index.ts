/// <reference path="./css-modules.d.ts" />
// @wizard/ui-kit public API (specs/ui/ui-kit.yaml). Components import only from here in generated code.
export const PACKAGE = "@wizard/ui-kit";

export { AppShell, type AppShellProps, type NavItem } from "./components/AppShell.js";
export { Badge, type BadgeProps, type BadgeTone } from "./components/Badge.js";
export { Button, type ButtonProps } from "./components/Button.js";
export { Field, type FieldProps, type FieldType } from "./components/Field.js";
export { Login } from "./components/Login.js";
export { EmptyState, ErrorState, Loading } from "./components/States.js";
export {
  CabinetLayout,
  Catalog,
  ConsentCheckbox,
  DataTable,
  ItemCard,
  QrScanner,
  QrTicket,
  RecordCard,
  RecordForm,
  StatsReport,
  StatusBoard,
} from "./components/stubs.js";
export type {
  CabinetLayoutProps,
  CatalogProps,
  ColumnDef,
  ConsentCheckboxProps,
  DataTableProps,
  ItemCardData,
  ItemCardProps,
  OptionGroup,
  QrScannerProps,
  QrTicketProps,
  RecordAction,
  RecordCardProps,
  RecordFormProps,
  ScanResult,
  Selection,
  StatsData,
  StatsReportProps,
  StatusBoardProps,
} from "./components/types.js";
export {
  useCan,
  useDataSource,
  useLocation,
  useNavigate,
  useRoleSpec,
  useWzUser,
  type WzBase,
  WzProvider,
  type WzProviderProps,
} from "./data/context.js";
export { toWzError } from "./data/mutation.js";
export {
  can,
  type LoginMethod,
  type RoleSpec,
  type RoleSpecCompliance,
  type RoleSpecOptions,
  toRoleSpec,
} from "./data/roleSpec.js";
export { sdkDataSource, toSdkListOptions } from "./data/sdk.js";
export type {
  AsyncResult,
  AuthApi,
  DataSource,
  ListQuery,
  Mutation,
  QrCheckRequest,
  QrCheckResponse,
  Rec,
  UserResult,
  WriteOpts,
  WzError,
  WzUser,
} from "./data/types.js";
export * from "./format.js";
export { ru } from "./i18n/ru.js";
export { blend, contrast, hexToOklch, luminance, oklchToHex } from "./tokens/color.js";
export {
  accentInk,
  accentText,
  applyTokens,
  PALETTE,
  type Scheme,
  THEME_DEFAULTS,
  type ThemeInput,
  type TokenName,
  type Tokens,
  themeToTokens,
  tokensToCss,
} from "./tokens/tokens.js";
