# M0-07 (packages/sdk) — CHANGELOG lines from the sdk agent

- 2026-09-30 · M0-07 · Conflict: sdk.md#4 / architecture interfaces.types say sdk re-exports appspec generateTypes, but appspec types-gen.ts emits the old DataModel format; @wizard/sdk/codegen keeps its own §4 implementation until appspec adopts packages/sdk/src/codegen (+ host/indexes.ts).
- 2026-09-30 · M0-07 · §5 InferArgs<{}> = {} accepts any non-null value as args; suggest `keyof S extends never ? Record<string, never> : …`.
- 2026-09-30 · M0-07 · IndexWhere: prefix members mark other indexed keys `?: never`; Range only on orderable types; Insert makes qr_token optional.
- 2026-09-30 · M0-07 · §5 extensions: WizardError.status; useEntityMutation().update(id, patch, opts?: CallOptions) (runtime requires _consent on update of PII rows).
- 2026-09-30 · M0-07 · Consent: without compliance.consentTextHash SDK sends sha256(consentText); without policyVersion → CONSENT_REQUIRED client-side. FunctionHost checks collectsPii consent presence; content matching stays in runtime.
- 2026-09-30 · M0-07 · SSE over fetch streaming (EventSource cannot send X-Wizard-Request); runtime /api/events must accept the header.
- 2026-09-30 · M0-07 · ctx.db: count() = 1 read; where/getBy on hidden field → FIELD_HIDDEN; non-indexed where → VALIDATION_FAILED (NOT_INDEXED); malformed ctx.error code → INTERNAL; log string fields masked; each ctx.scheduler call from an action is its own write tx; action ctx.now = call start.
- 2026-09-30 · M0-07 · Data API filter equality with null is sent as filter[f]=null (runtime.yaml does not define a null filter).
