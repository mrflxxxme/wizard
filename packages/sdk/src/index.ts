// @wizard/sdk — the only runtime import of generated systems (specs/runtime/sdk.md).
export const PACKAGE = "@wizard/sdk";

// React hooks for pages: ui/** never imports react directly (sdk.md §1).
export { useCallback, useEffect, useMemo, useRef, useState } from "react";
export {
  matchRoute,
  SdkProvider,
  type SdkProviderProps,
  useEntity,
  useEntityList,
  useEntityMutation,
  useMutation,
  useNavigate,
  useParams,
  usePayment,
  useQuery,
  useSdkClient,
  useUser,
} from "./client/react.js";
export {
  buildListQuery,
  type ConsentPayload,
  type FetchLike,
  type ListParams,
  type ListResponse,
  type RealtimeMessage,
  SdkClient,
  type SdkClientOptions,
  SseParser,
} from "./client/transport.js";
export { action, mutation, query } from "./define.js";
export { ERROR_MESSAGES, isWizardError, WizardError } from "./errors.js";
export type * from "./types.js";
export { v } from "./validators.js";
