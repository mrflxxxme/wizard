/// <reference path="./css-modules.d.ts" />
// @wizard/ui-kit public API (specs/ui/ui-kit.yaml). Components import only from here in generated code.
export const PACKAGE = "@wizard/ui-kit";

export { AppShell, type AppShellProps, type NavItem } from "./components/AppShell.js";
export { Badge, type BadgeProps, type BadgeTone } from "./components/Badge.js";
export { Button, type ButtonProps } from "./components/Button.js";
export { CabinetLayout } from "./components/CabinetLayout.js";
export { Catalog } from "./components/Catalog.js";
export { ConsentCheckbox } from "./components/ConsentCheckbox.js";
export { DataTable } from "./components/DataTable.js";
export { Field, type FieldProps, type FieldType } from "./components/Field.js";
export { FILE_MIMES, FileField, formatFileSize } from "./components/FileField.js";
export { ItemCard } from "./components/ItemCard.js";
export { Login } from "./components/Login.js";
export { QrScanner } from "./components/QrScanner.js";
export { QrCode, QrTicket } from "./components/QrTicket.js";
export { RecordCard } from "./components/RecordCard.js";
export { RecordForm } from "./components/RecordForm.js";
export { EmptyState, ErrorState, Loading } from "./components/States.js";
export { StatsReport } from "./components/StatsReport.js";
export { StatusBoard } from "./components/StatusBoard.js";
export type {
  CabinetLayoutProps,
  CatalogProps,
  ColumnDef,
  ConsentCheckboxProps,
  DataTableProps,
  FileFieldProps,
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
  FileInfo,
  FileMimeType,
  FilesApi,
  ListQuery,
  LoginConsent,
  Mutation,
  QrCheckRequest,
  QrCheckResponse,
  QrManifest,
  QrManifestEntry,
  QrOfflineApi,
  QrSyncEvent,
  QrSyncRequest,
  QrSyncResponse,
  QrSyncResult,
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
