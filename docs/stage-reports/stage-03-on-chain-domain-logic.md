# Stage 03 - On-Chain Domain Logic

## Scope completed

- Objective achieved: Implemented and hardened Stage 03 lifecycle domain logic increments on top of Stage 02 guardrails.
- Purpose and value: Improve lifecycle determinism, observability, and backend-read readiness while preserving interface-first compatibility.
- Functional result: Policy lifecycle transitions are explicitly observable, metadata-aware policy creation and request-id weather flows are integrated end-to-end, and payout settlement now supports deferred insured claims when immediate transfer fails.
- Added canonical lifecycle transition event emission for all policy status changes.
- Added lifecycle transition event declaration to `IInsurancePolicy` for interface-level event subscription compatibility.
- Extended policy interface with telemetry getters needed by downstream backend integration.
- Extended ABI export pipeline to publish `IInsurancePolicy` in `shared/abi` for interface-driven backend consumers.
- Extended ABI export pipeline to publish `IInsuranceProviderRegistry` and `IWeatherOracleAdapter` for interface-driven backend and oracle-adapter consumers.
- Simplified weather-window and expiry-eligibility comparisons to direct inclusive-bound expressions.
- Fixed weather-window read semantics so `isWeatherWindowOpen()` is true only while policy is `Active` and inside time window.
- Hardened `InsurancePolicy` constructor to reject zero rainfall threshold and EOA oracle addresses for direct deployments.
- Added insured context to policy-level expiry event payload for parity with payout observability.
- Normalized constructor oracle validation style to one canonical condition for invalid oracle addresses.
- Emitted lifecycle transition event after state mutation while preserving previous-status payload in event data.
- Added payout/expiry/weather-window eligibility reads and validated transition semantics through tests.
- Added provider-level happy-path weather request test to verify dual-event emission (`PolicyWeatherDataRequested` + `WeatherDataRequested`).
- Added explicit non-emission assertion for `PolicyStatusTransitioned` when rainfall is below threshold.
- Added provider policy-start lead-time (`MIN_POLICY_START_LEAD_TIME_SECONDS`) to prevent same-block activation/fulfillment behavior.
- Added metadata-aware provider creation path (`createPolicyWithMetadata`) plus provider metadata reads for region and requested-start fields.
- Added policy-level `regionCode` persistence and interface reads to keep provider/policy metadata consistent.
- Added pending weather request-id lifecycle state and explicit request-id fulfill validation to prevent mismatched callbacks.
- Added request-id observability events (`WeatherDataRequestTracked`, `WeatherDataFulfillmentTracked`) in policy/provider flows.
- Added weather-oracle adapter overload with explicit request-id fulfillment path and aligned mock-oracle telemetry.
- Replaced same-block fulfillment behavior test with deterministic rejection-before-start and acceptance-at-start coverage.
- Added boundary test coverage for end-window transitions (`endTimestamp - 2`, `endTimestamp - 1`, and `endTimestamp`).
- Added payout-failure coverage for non-payable insured contracts and validated deferred-claim settlement path (`PayoutClaimCreated` + `claimPendingPayout`).
- Clarified provider-level oracle update semantics and expanded payout event payload with explicit coverage and premium accounting fields.
- Replaced oracle mock policy-status validation magic number with a named constant for readability and maintainability.
- Aligned `IInsurancePolicy.insured()` to anonymous return style for interface consistency while preserving NatSpec compatibility.
- Added `InsuranceProvider.getPolicyFinancials(policyAddress)` read API to expose provider-side settlement snapshot for monitoring/audit tooling.
- Added explicit rationale comment in `withdrawUntrackedBalance` clarifying why no tracked-ledger state mutation occurs before transfer.
- Added shape-validation intent comments in mock oracle selector checks where return values are intentionally discarded.
- Added explicit non-owner access-control coverage for `executePolicyPayout` and `expirePolicy`.
- Added explicit non-owner access-control coverage for reserve, premium, and untracked withdrawal paths.
- Added explicit happy-path coverage for `getPolicyAt(index)` and stronger boundary assertions after end-window minus-one fulfillment.
- Added same-oracle update guard in provider (`SameOracleAddress`) to avoid misleading no-op oracle-update events.
- Added `IInsurancePolicy.getCurrentBalance()` to preserve interface-level read access for policy-balance monitoring.
- Added policy business-event declarations to `IInsurancePolicy` so interface-only subscribers can consume domain events without concrete-contract coupling.
- Aligned constructor window validation and expiry-time comparison style in policy to explicit inequalities with consistent integer-width handling.
- Switched post-deployment activation call in provider to interface type (`IInsurancePolicy`) to reinforce interface-first interaction discipline.
- Made `InsuranceProvider` explicitly implement `IInsuranceProviderRegistry` for compile-time interface conformance.
- Updated local deployment and local stress harness flows to configure mock oracle `policyRegistry` with deployed provider for environment parity with provenance checks.
- Moved test-helper create-policy interface out of `NonPayableInsured` inline definition into shared `contracts/interfaces` to avoid signature drift.
- Added explicit zero-amount guardrails for all provider withdrawal paths to prevent no-op transfer calls and zero-value withdrawal events.
- Documented oracle mock push-order rationale where external policy call intentionally precedes local snapshot writes to preserve all-or-nothing mock state on policy revert.
- Added payout-retry test note clarifying rollback semantics after failed provider settlement attempts.
- Added defense-in-depth consistency by applying `nonReentrant` on policy expiry flow.
- Added paginated policy read APIs (`getPoliciesByInsuredPage`, `getAllPoliciesPage`) for high-cardinality read paths.
- Added provider settlement observability API (`getPolicySettlementInfo`) and canonical settlement event (`PolicySettled`).
- Added strict mock provenance mode (`setStrictPolicyRegistryMode`) to prevent accidental policy-registry disablement.
- Hardened ABI export to fail fast when any required contract ABI is missing from artifacts.
- Made ABI export deterministic by removing per-run generation timestamps from individual ABI files and index metadata.
- Hardened local stress harness to auto-synchronize mock `policyRegistry` when reusing provider deployments.
- Extended stress harness inputs with metadata-aware knobs (`STRESS_REGION_CODE`, `STRESS_START_OFFSET_SECONDS`).
- Added consolidated Stage 03 gate script (`npm run stage3:check`) and deterministic stress smoke profile.
- Preserved Stage 02 compatibility expectations: interface-first changes, quality/baseline checks, and shared ABI synchronization.

## Files changed

- `contracts/contracts/InsurancePolicy.sol`
- `contracts/contracts/InsuranceProvider.sol`
- `contracts/contracts/interfaces/IInsurancePolicy.sol`
- `contracts/contracts/interfaces/IInsuranceProviderCreatePolicy.sol`
- `contracts/contracts/mocks/MockWeatherOracle.sol`
- `contracts/contracts/mocks/NonPayableInsured.sol`
- `contracts/package.json`
- `contracts/README.md`
- `contracts/deployments/contract-size-baseline.json`
- `contracts/scripts/deploy.ts`
- `contracts/scripts/export-abi.ts`
- `contracts/scripts/stress-create-policies.ts`
- `contracts/test/InsuranceProvider.ts`
- `README.md`
- `shared/abi/IInsurancePolicy.json`
- `shared/abi/IInsuranceProviderRegistry.json`
- `shared/abi/IWeatherOracleAdapter.json`
- `shared/abi/InsurancePolicy.json`
- `shared/abi/InsuranceProvider.json`
- `shared/abi/MockWeatherOracle.json`
- `shared/abi/index.json`
- `docs/stage-reports/stage-03-on-chain-domain-logic.md`

## Decisions made

- Kept lifecycle transition observability centralized through one internal transition helper to reduce event drift.
- Kept backend-facing policy reads and lifecycle-transition event declaration in the interface boundary to avoid direct implementation coupling in later stages.
- Kept interface ABI publication in shared assets to decouple backend event subscriptions from concrete implementation artifacts.
- Kept weather-window semantics explicit as `[startTimestamp, endTimestamp)` to avoid ambiguous callback timing behavior.
- Aligned read-model eligibility (`isWeatherWindowOpen`) with execution eligibility (`requestWeatherData` and `fulfillWeatherData`) to avoid backend false positives.
- Bound oracle fulfill calls to one pending canonical request id to harden callback provenance and prevent stale/mismatched fulfillments.
- Enforced direct-deployment safety parity with provider safeguards by requiring non-zero rainfall threshold and contract-based oracle address.
- Kept provider event semantics explicit: `WeatherOracleUpdated` is non-retroactive for deployed policies, and `PolicyPayoutExecuted` includes both coverage and premium amounts for indexer-ready settlement accounting.
- Kept provider oracle-update event self-descriptive by emitting `appliesToNewPoliciesOnly = true` and documenting non-retroactive behavior for existing policies.
- Kept policy expiry observability aligned with payout path by including insured context in policy-level `PolicyExpired` event.
- Kept transition-event semantics explicit by capturing previous status snapshot and emitting transition after state update.
- Exposed provider-side policy financial snapshots through a dedicated getter to reduce off-chain inference requirements.
- Added explicit provider-to-registry interface conformance (`IInsuranceProviderRegistry`) to catch signature drift at compile time.
- Prevented oracle-update no-op emissions by rejecting same-address updates before state mutation.
- Added `nonReentrant` on `expirePolicy` for audit consistency and defense in depth, even though flow already follows CEI and trusted-owner transfer.
- Kept payout settlement deterministic by marking policy as paid out and creating a deferred claim when insured transfer fails instead of reverting provider settlement.
- Replaced mock-oracle policy-status bound magic number with `MAX_POLICY_STATUS` to improve code readability during audit and test maintenance.
- Kept oracle-side status check scoped to enum-range validation and delegated active-status enforcement to policy-level guards.
- Rejected zero-value withdrawals uniformly across reserve, premium, and untracked balance paths for operational symmetry with zero-value funding rejection.
- Kept local tooling aligned with test assumptions by setting mock oracle policy registry during local deploy and local stress-stack bootstrap.
- Adopted minimum policy start lead-time to prevent same-block weather fulfillment and improve temporal determinism for downstream consumers.
- Added paginated read APIs to avoid unbounded array reads in higher-volume monitoring/indexing scenarios.
- Added provider settlement metadata (type + timestamp) to reduce off-chain inference for lifecycle analytics.
- Added strict mock provenance mode as an opt-in safety rail against accidental registry disablement.
- Enforced ABI export completeness by failing when required contracts are missing from artifacts.
- Removed ABI timestamp fields to make shared ABI output deterministic and CI-drift friendly.
- Kept stress harness parity with deployment assumptions by auto-aligning mock policy registry to reused providers when possible.
- Extended stress harness defaults to metadata-aware inputs while preserving legacy coverage/premium controls.
- Added a single Stage 03 execution gate (`stage3:check`) to combine quality, baseline, stress smoke, and ABI sync.
- Preserved strict Stage 02 guardrails (`quality:check`, `baseline:check`, `artifacts:sync`) as mandatory on Stage 03 increments.

## Commands executed

- `cd contracts && npm run test`
- `cd contracts && npm run quality:check`
- `cd contracts && npm run format:write`
- `cd contracts && npm run quality:check`
- `cd contracts && npm run compile && npx cross-env UPDATE_SIZE_BASELINE=true ts-node scripts/report-contract-size.ts`
- `cd contracts && npm run baseline:check`
- `cd contracts && npm run stage3:check`
- `cd contracts && npm run artifacts:sync`

## Tests executed and results

- `npm run test`: passed (`100 passing`).
- `npm run quality:check`: passed (strict lint, format check, Stage-04 static profile with 0 findings).
- `npm run baseline:check`: passed.
  - Size baseline refreshed after intentional Stage 03 hardening growth.
  - Current baseline values: `InsurancePolicy 4875`, `InsuranceProvider 15071`, `MockWeatherOracle 2876` bytes.
  - Gas report generated successfully, including telemetry for metadata-aware creation and request-id oracle flows.
- `npm run stage3:check`: passed (quality + baseline + stress smoke + ABI sync).
  - Stress smoke profile (`STRESS_POLICIES_COUNT=6`, `STRESS_BURST_SIZE=3`) completed with throughput summary.

## Risks or pending items

- Oracle flow is still mock-based; production Chainlink request/fulfill pipeline remains for Stage 10.
- Deferred payout claims require insured retry and operational monitoring so claimable balances do not remain stranded long-term.
- Stage 03 lead-time changes temporal assumptions for weather readiness; downstream consumers should use `startTimestamp` rather than creation block time.
- Size baseline was refreshed after validated Stage 03 hardening changes to keep future growth detection meaningful.
- Stage 03 has progressed through key lifecycle and interface-readiness increments; further refinements may still be added before declaring downstream-ready freeze.

## Credentials status

- Credentials required now: No.
- Credentials list: None for local compile/test/quality/baseline/ABI sync.
- Purpose: Stage 03 remains local-first and does not require private keys or external RPC credentials for this increment.

## Next stage handoff notes

- Stage 04 should extend transition matrix coverage toward invariant-style assertions and edge-case combinatorics.
- Keep interface-first discipline (`IInsurancePolicy`, `IInsuranceProviderRegistry`, `IWeatherOracleAdapter`) before introducing new integrations.
- Continue using `shared/abi/index.json` and deployment manifests as canonical downstream contract metadata.
- Re-run stress harness on any future change to creation paths, reserve accounting, settlement lifecycle behavior, or registry-provenance validation logic.
- Prefer paginated policy getters in any high-cardinality backend/indexer read path.
