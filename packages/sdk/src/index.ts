// @wizard/sdk — the only runtime import of generated systems (specs/runtime/sdk.md).
// Every export of §5 is bound to its declaration in ./sdk.d.ts: tsc fails if the implementation drifts.
import {
  useAiAction as useAiActionImpl,
  useEntity as useEntityImpl,
  useEntityList as useEntityListImpl,
  useEntityMutation as useEntityMutationImpl,
  useMutation as useMutationImpl,
  useNavigate as useNavigateImpl,
  useParams as useParamsImpl,
  usePayment as usePaymentImpl,
  useQuery as useQueryImpl,
  useUser as useUserImpl,
} from "./client/react.js";
import { action as actionImpl, mutation as mutationImpl, query as queryImpl } from "./define.js";
import { WizardError as WizardErrorImpl } from "./errors.js";
import type * as Sdk from "./sdk.js";
import { v as vImpl } from "./validators.js";

export const PACKAGE = "@wizard/sdk";

export type * from "./sdk.js";

export const v: typeof Sdk.v = vImpl;
export const query: typeof Sdk.query = queryImpl;
export const mutation: typeof Sdk.mutation = mutationImpl;
export const action: typeof Sdk.action = actionImpl;
export const WizardError: typeof Sdk.WizardError = WizardErrorImpl;
export type WizardError = Sdk.WizardError;

export const useQuery: typeof Sdk.useQuery = useQueryImpl;
export const useMutation: typeof Sdk.useMutation = useMutationImpl;
export const useEntityList: typeof Sdk.useEntityList = useEntityListImpl;
export const useEntity: typeof Sdk.useEntity = useEntityImpl;
export const useEntityMutation: typeof Sdk.useEntityMutation = useEntityMutationImpl;
export const useUser: typeof Sdk.useUser = useUserImpl;
export const usePayment: typeof Sdk.usePayment = usePaymentImpl;
export const useAiAction: typeof Sdk.useAiAction = useAiActionImpl;
export const useParams: typeof Sdk.useParams = useParamsImpl;
export const useNavigate: typeof Sdk.useNavigate = useNavigateImpl;
// React hooks for pages: ui/** never imports react directly (sdk.md §1).
export { useCallback, useEffect, useMemo, useRef, useState } from "react";
export { matchRoute, SdkProvider, type SdkProviderProps, useSdkClient } from "./client/react.js";
// ext: host/template-side helpers (not used by generated code).
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
export { ERROR_MESSAGES, isWizardError } from "./errors.js";
