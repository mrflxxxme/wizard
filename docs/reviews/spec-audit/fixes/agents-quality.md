# Fixes log — agents-quality

Files: specs/agents/{models,orchestrator,builder,qa}.yaml, specs/quality/{gates,eval}.yaml. tools/eval — not changed (brief renames, briefs and canaries are M0-18 acceptance in backlog).

| id | status | note |
|---|---|---|
| L1-01 | fixed | gates#scenario_dsl declared canonical; `actors` (and `milestone`) are top-level scenario properties, a `{actors}` step is a DSL error |
| L1-02 | fixed | builder#loop.events = workflows#events types; run_finished {status, resultRevision, creditsUsed, summary_ru}; warn_at via budget_update; plan_ready/model_switched per workflows |
| L1-03 | fixed | DSL: `consent: true` modifier for create/callFn steps; qa validate requires it for PII writes by non-admin |
| L1-04 | fixed | builder: types via `import type … from '@wizard/sdk'` (`_generated/wizard.d.ts`), `useQuery('fnName', args)`, page = page.file; virtual path renamed; human_diff.files; gates G0-SPEC-04, G0-FN-01 |
| L1-05 | fixed | builder target {wzId, componentName, file, line, route, instruction}; component_ids removed; orchestrator point_and_edit → target {wzId, file} |
| L1-06 | fixed | builder escalation → needs_input decision decisionId=escalation, outcomes as workflows; budget → decisionId=budget, N from workflows |
| L1-07 | fixed | builder modes create/change/fix/point_edit; fix skips plan and ops |
| L1-09 | fixed | orchestrator: messages kind=notice + chat_output{kind: notice}; test counts messages; pii_notice event removed |
| L1-10 | fixed | orchestrator Answer `custom` → `text` ≤500 |
| L1-11 | fixed | builder run_gate: full report → platform.gate_reports + gate_result |
| L1-12 | fixed | gates#report.GateReport.explanations (G1) |
| L1-13 | needs-other | ORCH_INVALID_OUTPUT is added on the workflows side (already done); no change in orchestrator |
| L1-14 | fixed | models fallback: LLM_UNAVAILABLE behaviour → workflows#run_lifecycle |
| L1-15 | fixed | usage_record = platform.llm_calls from M0 (fields renamed 1:1 to db columns, billable, aborted, step); prompt content not stored, transcripts off by default |
| L1-16 | fixed | models credits: credits_milli per row, charge = min(cap, Σ billable), test ±1 millicredit |
| L1-17 | fixed | routing steps 2a (t1Restricted → policy_region_restricted, per L3-02 naming) and 3a (containsPiiHint=true → pii_hint) |
| L1-18 | fixed (no change) | models.yaml is the source; provider env names are unchanged |
| L1-19 | fixed | builder tokens `var(--w-*)` |
| L1-22 | fixed | gates G1.milestone_rule + G1-AC-COVER text; qa skips later-milestone AC |
| L1-26 | fixed | gates G2-PII-06 (operatorName+operatorContact; INN checksum from L3-34) |
| L1-30 | fixed | gates#G0.forbidden_api (union by scope + size limits); builder.forbidden references it |
| L1-35 | fixed | G0-IDX-01 and builder functions rule use the SDK where/limit wording |
| L1-38 | fixed | G0-BUILD-01 → buildSystem (architecture#interfaces.build_system), same call as gate_G0 |
| L1-40 | fixed | models step 7 and G0-PH-01 use `[ТЕЛЕФОН_1]` format / regex `\[[А-ЯЁ_]+_\d+\]` |
| L1-41 | fixed | Expect.status mapped to runtime HTTP codes; ctx.error only via `error`; example → callFn registerTicket + `error: SOLD_OUT`; qa examples |
| L1-42 | fixed | builder rephrase button `freeText: true` |
| L1-43 | fixed | orchestrator state persistence is derived from systems.stage + pending_questions |
| L1-44 | fixed (no change) | builder is the source |
| L1-46 | fixed | models providers zai/moonshot termsCheckedAt |
| L1-47 | fixed | orchestrator pii categories = piiKind; models step 4 → strong kinds + special/biometric |
| L1-51 | fixed | orchestrator small_edit = SystemCard kind=change with required fields |
| L1-52 | fixed / deferred | eval fixtures → demo/bakery.jsonl, spec_only schema note; brief rename cg→gd and schema import → M0-18 (already in backlog acceptance) |
| L1-53 | fixed | route() signature with ctx, as in architecture#interfaces.llm_call |
| L2-01 | fixed | eval#fixtures.lookup (demo by sequence) + golden generator |
| L2-07 | fixed | G1-AC-COVER milestone text |
| L2-13 | fixed | G0 time_budget 60 s hard, 20 s target as a warning |
| L2-14 | fixed | builder#loop.owner: runBuild(host), host.runStep |
| L2-15 | fixed | seed generator owned by packages/gates (gates.generateSeed); qa only calls it |
| L2-16 | fixed | qa test: ≥1 SC per scenario/constraint AC ≤ M0, pass on the golden revision |
| L2-18 | deferred | brief rename is M0-18 acceptance; eval.yaml keeps `gd` |
| L2-27 | fixed | `since: M1` on G0-LINT-01, A11Y-01, I18N-01, PH-01 (+ skip rule in report.rules) |
| L2-§6 | fixed | builder get_ui_kit_docs/get_sdk_docs use slice.mjs assets |
| L3-02 | fixed | route_reason policy_region_restricted, fail-safe T0 when region/policy unknown |
| L3-04 | fixed | pii_leaks = canary exact-match in outbound T1 payloads + forbidden callTypes on T1; independent-detector metric pii_suspect_t1 (M1); canaries field, ≥4 briefs |
| L3-06 | fixed | builder read_file('spec.json') masks operator*/consentText/retentionWaiver.reason; agent set_compliance only {consentTemplateId, policyPage} |
| L3-07 | fixed | eval: record refuses non-repo briefs; T0 requests stored scrubbed; CI artifacts only from fixture runs; partner briefs only as synthetic retellings |
| L3-13 | fixed | gates#G0.order: AST checks before tsc/esbuild, sandboxed resolve/loaders |
| L3-14 | fixed | forbidden_api: computed member on document/navigator/location/Reflect/getOwnPropertyDescriptor |
| L3-16 | fixed | forbidden_api.ui: parent, top, opener, postMessage, window.name |
| L3-18 | fixed | G2-AF-03 covers file-field labels from M2 |
| L3-31 | fixed | G2-AF-01/02/04 context rules, PII dictionaries scope, good/ fixtures list |
| L3-32 | fixed | G2-AF-04 checks compliance.operatorName; G2-AF-09 (ОРИ, warning) |
| L3-34 | fixed / needs-other | INN checksum (G2-PII-06), event retention 30 days; operatorAddress and consentTemplateId need the schema owner and E-LEGAL |
| L3-37 | needs-other | api.yaml (xlsx limits, CSV escaping); orchestrator unchanged |
| L3-39 | fixed | F3: gpt-oss-120b kept (open weights, RF-hosted); catalog rule checks provider/placement |
| L3-40 | fixed | builder header: NOTICE/THIRD_PARTY_NOTICES for Chef/bolt.diy |
| L3-41 | fixed | models credits.runtime_ai: public-role rate limit, text-only output, multimodal T0-only (M3) |
| L3-42 | fixed | model_switched is not sent to the user's SSE |
| L3-43 | needs-other | compliance.yaml (support is already T0-only) |
| L4-01 | fixed | G2-AF-04 context/combos + connector allowlist; negative fixtures «Мир», Telegram, ЮKassa, «срок действия билета», allergens |
| L4-04 | fixed | F2: models#week0_decision (t1_default switch) + eval live_cadence.week0 |
| L4-05 | fixed | F3 recorded in models |
| L4-06 | fixed | F4: email/Telegram by default; phone_otp only on start/business; F-LOGIN plan_rule, validation and test |
| L4-15 | fixed | F6: eval#live_cadence (nightly 5 briefs, full by PR label/milestone, ≤30 000 ₽/month) |
| L4-19 | fixed | orchestrator: event retention 30 days, F-RETENTION d30_after_event |
| L4-20 | needs-other | models: fallback shown only generically; whether and where to show it is up to platform-screens (data-boundary says there is no notice in beta) |
| L4-21 | fixed | orchestrator «Строить», «по рекомендациям», one-by-one stepper |
| L4-24 | fixed | builder human_diff templates for every op + «Изменены настройки системы» |
| L4-27 | fixed | eval first_preview_minutes, M2 p80 thresholds |
| L4-28 | fixed / deferred | eval set ≥4 hz of 12, ≥10 of 30; briefs → M0-18 |
| L4-31 | fixed | G0-DATA-01 (warning, since M1) |
| KI-10 | fixed | = L1-15 |

## Needs other owner
- appspec.schema.json / examples: L1-01 step propertyNames (already converged); L3-34 `operatorAddress`, `consentTemplateId`; L1-47 piiKind mapping.
- platform/db.yaml: llm_calls.agent_role comment += importer, auditor (L1-15); keep the route_reason CHECK in sync with models#usage_record.routeReason (already converged).
- platform/workflows.yaml: nightly_eval → eval.yaml#live_cadence (F6); step/limit texts are already converged.
- security/data-boundary.yaml: model_registry `inRussia` → `placement=internal` (L1-46, done); ruOnly cache invalidation (L3-42); detector kind → piiKind mapping (L1-47).
- runtime/sdk.md, security/isolation.yaml: reference gates#G0.forbidden_api and G0.order (L1-30, L3-13); sdk §2.4 «limit по умолчанию 100» (L1-35); isolation limits.logs → ctx.log (L1-30).
- security/abuse.yaml: pattern changes behind G2-AF-01/02/04, PII-02/03, allowlists, G2-AF-09 signal (L3-31, L3-32, L4-01).
- ui/platform-screens.yaml: fallback notice text (L4-20), preview widths (L4-27), S2 stepper wording (L4-21).
- product.yaml / AGENTS.md: F3 non_goals wording (L4-05); D2 fallback (F2, L4-04). runtime.yaml / billing.yaml: F4 phone login only on paid plans (L4-06).
- backlog.yaml: M0-10 acceptance time 60 s and `since` (L2-13, L2-27); M0-14 acceptance (L2-16); M0-18 already carries the brief renames, canaries and schema import.

## CHANGELOG
- agents-quality: builder events, modes, budget and escalation now follow platform/workflows.yaml (L1-02, L1-06, L1-07, L1-42).
- agents-quality: builder code conventions follow runtime/sdk.md: `@wizard/sdk` types, string function names, page = page.file, `--w-*` tokens (L1-04, L1-19).
- agents-quality: point-and-edit target = ui-kit wz_id {wzId, componentName, file, line, route, instruction} (L1-05).
- agents-quality: usage_record = platform.llm_calls from M0, fields 1:1 with db, prompt content not stored (L1-15, KI-10).
- agents-quality: credits = credits_milli per llm_calls row, charge = min(cap, Σ billable) (L1-16).
- agents-quality: router steps 2a policy_region_restricted (fail-safe T0) and 3a pii_hint; strong kinds → pii_high_risk (L3-02, L1-17, L1-47).
- agents-quality: F2 recorded: models#week0_decision `t1_default` switch (≥10 p.p. g0_pass rule).
- agents-quality: F3 recorded: gpt-oss-120b stays (RF-hosted open weights); registry checks provider/placement (L3-39).
- agents-quality: F4 recorded: orchestrator offers phone login only on start/business; default is email plus Telegram (L4-06).
- agents-quality: F6 recorded: eval live_cadence — nightly 5 briefs, full run by PR label, ≤30 000 ₽/month (L4-15).
- agents-quality: pii_leaks now counts canary exact matches in T1 payloads; the independent detector is an M1 diagnostic (L3-04).
- agents-quality: G0.forbidden_api is the single forbidden-API list, and AST checks run before tsc/esbuild (L1-30, L3-13, L3-14, L3-16).
- agents-quality: G2-AF-04 brands only in strong context, with connector names allowlisted, plus false-positive fixtures (L4-01, L3-31).
- agents-quality: scenario DSL is canonical in gates.yaml: `actors` is a scenario property, `consent` step modifier, status↔HTTP mapping (L1-01, L1-03, L1-41).
- agents-quality: G0 warning checks `since: M1`; G0 60 s hard / 20 s target; G1 skips AC from later milestones (L2-27, L2-13, L1-22).
