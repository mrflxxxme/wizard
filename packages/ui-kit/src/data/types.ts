// DataSource contract (ui-kit.yaml#data_binding.DataSource_interface) plus ext members for auth and QR.
import type { LoginMethod } from "./roleSpec.js";

export type Rec = Record<string, unknown> & { id: string };

export type ListQuery = {
  filter?: Record<string, unknown>;
  sort?: { field: string; dir: "asc" | "desc" };
  page?: number;
  pageSize?: number;
  search?: string;
};

/** Error shape of runtime.yaml#data_api.error_shape; message is Russian. */
export type WzError = {
  code: string;
  message: string;
  status: number;
  fields?: { field: string; code: string; message: string }[];
  requestId?: string;
};

export type AsyncResult<T> = { data?: T; isLoading: boolean; error?: WzError; refetch(): void };

export type Mutation<A extends unknown[], R> = {
  mutate(...args: A): Promise<R>;
  pending: boolean;
  error?: WzError;
  reset(): void;
};

export type WriteOpts = { consent?: true };

export type WzUser = { id: string; role: string; displayName: string; isAdmin: boolean };

export type UserResult = {
  user: WzUser | null;
  isLoading: boolean;
  /** Navigates to /login (runtime template renders AppShell.Login). */
  login(o?: { role?: string; next?: string }): void;
  logout(): Promise<void>;
};

/** ext: /api/auth/* calls of AppShell.Login (ui-kit.yaml#data_binding.sdk_mapping.auth_calls). */
export interface AuthApi {
  /** `role` — /login?role= (selfSignup role of a new user, runtime.yaml#auth.role_assignment). */
  start(
    channel: "phone" | "email",
    destination: string,
    opts?: { role?: string },
  ): Promise<{ challengeId: string }>;
  /** `consent` — _consent of the first login (422 CONSENT_REQUIRED without it; compliance.yaml#consent.login). */
  verify(challengeId: string, code: string, consent?: LoginConsent): Promise<WzUser>;
  /** OIDC redirect (telegram); memory sources may log in directly. */
  redirect(
    method: Exclude<LoginMethod, "phone_otp" | "email_otp">,
    next?: string,
    opts?: { role?: string; consent?: LoginConsent },
  ): void;
}

/** Body `_consent` of a login: values of RoleSpec.compliance. */
export type LoginConsent = { policyVersion: string; textHash: string };

export type QrCheckRequest = { payload: string; checkpoint?: string; deviceId: string };
export type QrCheckResponse = {
  status: "ok" | "duplicate" | "invalid";
  reason?: "not_found" | "bad_signature" | "revoked" | "not_valid_status";
  ticketTitle?: string;
  details?: string;
  scannedAt: string;
  firstScannedAt?: string;
  firstCheckpoint?: string;
};

/** One ticket of the offline package (connectors/qr.yaml#offline.package): hash of rand, id, display line, status. */
export type QrManifestEntry = { h: string; id: string; d: string; s: string };
/** GET /_wizard/qr/manifest (connectors/qr.yaml#endpoints.manifest). */
export type QrManifest = {
  manifestId: string;
  cursor: string;
  generatedAt: string;
  expiresAt: string;
  /** true — replaces the device copy; false — delta since the requested cursor. */
  full: boolean;
  validStatuses: string[];
  entries: QrManifestEntry[];
  checkedIn: string[];
  revoked: string[];
};
export type QrSyncEvent = {
  clientEventId: string;
  h: string;
  scannedAt: string;
  gate?: string;
  localResult?: string;
};
export type QrSyncRequest = { deviceId: string; events: QrSyncEvent[]; sentAt?: string; pending?: number };
export type QrSyncResult = "accepted" | "duplicate" | "unknown" | "revoked";
/** POST /_wizard/qr/sync (connectors/qr.yaml#offline.sync_protocol). */
export type QrSyncResponse = {
  results: { clientEventId: string; result: QrSyncResult; firstScannedAt?: string }[];
  accepted: number;
  duplicate: number;
  unknown: number;
  revoked: number;
  cursor: string;
};
/** ext: offline package and sync of QrScanner offline (M2-03). */
export interface QrOfflineApi {
  manifest(since?: string): Promise<QrManifest>;
  sync(req: QrSyncRequest): Promise<QrSyncResponse>;
}

/** Upload types of runtime.yaml#files.upload (checked by signature on the server). */
export type FileMimeType = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

/** POST /api/files result and GET /api/files/:fileId/info (runtime.yaml#files); width/height — image fields (M2-47). */
export type FileInfo = {
  fileId: string;
  name: string;
  size: number;
  mime: FileMimeType;
  width?: number;
  height?: number;
};

/** Width slots of image variants (runtime.yaml#files.image). */
export type ImageWidth = 480 | 960 | 1600;

/** ext: files of file fields (FileField, M2-14). */
export interface FilesApi {
  /** POST /api/files (multipart: file, field, entity?) with X-Wizard-Request: 1. */
  upload(file: File, target: { field: string; entity?: string }): Promise<FileInfo>;
  /** Name, size and type of a stored file the user may read. */
  info(fileId: string): Promise<FileInfo>;
  /** Download address: GET /api/files/:fileId (302 to a short-lived signed link). */
  href(fileId: string): string;
  /** Inline address of an image variant: GET /api/files/:fileId/img/:width (image fields, M2-47). */
  imageSrc(fileId: string, width: ImageWidth): string;
}

/** ext: result of an AI action (POST /api/ai/:action, runtime.yaml#ai_actions, M3-02). */
export type AiActionResult = {
  /** The record as the user sees it, with `_aiFilled` (fields whose last write was the AI). */
  item: Rec & { _aiFilled?: string[] };
  filled: string[];
  skipped: string[];
};

export interface DataSource {
  useList<T = Rec>(entity: string, q: ListQuery): AsyncResult<{ items: T[]; total: number }>;
  useRecord<T = Rec>(entity: string, id: string): AsyncResult<T>;
  useCreate(entity: string): Mutation<[values: Record<string, unknown>, opts?: WriteOpts], Rec>;
  useUpdate(entity: string): Mutation<[id: string, patch: Record<string, unknown>, opts?: WriteOpts], Rec>;
  useRemove(entity: string): Mutation<[id: string], void>;
  useFn<T>(name: string, args?: unknown): AsyncResult<T>;
  /** ext: current user (sdk useUser()). */
  useUser(): UserResult;
  /** ext: mutation/action function call by name (RecordCard kind=fn). */
  useCall<R = unknown>(): Mutation<[name: string, args: unknown, opts?: WriteOpts], R>;
  /** ext: auth endpoints for AppShell.Login. */
  useAuth(): AuthApi;
  /** ext: POST /_wizard/qr/check (connectors/qr.yaml#endpoints.check) or verifyFn. */
  useQrCheck(verifyFn?: string): (req: QrCheckRequest) => Promise<QrCheckResponse>;
  /** ext: GET /_wizard/qr/manifest and POST /_wizard/qr/sync (connectors/qr.yaml#endpoints). */
  useQrOffline(): QrOfflineApi;
  /** ext: POST /api/files and file info (FileField, runtime.yaml#files). */
  useFiles(): FilesApi;
  /** ext (M3-02): POST /api/ai/:action {entity, id} — RecordCard action kind=ai. */
  useAiAction(): Mutation<[action: string, entity: string, id: string], AiActionResult>;
  /**
   * ext (V3-23): POST /api/pay/:integration {binding, id, token?} → the confirmation URL of the payment (the caller
   * goes there); `token` — the buyer's secret of an order he cannot read. Optional: sources without payments omit it.
   */
  usePay?(): Mutation<[integration: string, binding: string, id: string, token?: string], string>;
  /** ext (V3-23): POST /api/pay/:integration/check — back from the payment page, the runtime re-reads the payment. */
  usePayCheck?(): Mutation<[integration: string, binding: string, id: string, token?: string], string>;
}
