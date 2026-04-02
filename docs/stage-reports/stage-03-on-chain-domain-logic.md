# Stage 03 - On-Chain Domain Logic

## Scope completed

- Objective achieved: Implemented and hardened Stage 03 lifecycle domain logic increments on top of Stage 02 guardrails.
- Purpose and value: Improve lifecycle determinism, observability, and backend-read readiness while preserving interface-first compatibility.
- Functional result: Policy lifecycle transitions are explicitly observable, weather-window reads now match execution guards, constructor hardening is enforced for direct deployments, and policy telemetry accessors are available through `IInsurancePolicy`.
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
- Added same-block creation and oracle fulfillment test to document and validate current Stage 03 timing behavior.
- Added boundary test coverage for end-window transitions (`endTimestamp - 2`, `endTimestamp - 1`, and `endTimestamp`).
- Added direct-policy and provider-path payout-failure coverage for non-payable insured contracts (`EthTransferFailed` path).
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
- Preserved Stage 02 compatibility expectations: interface-first changes, quality/baseline checks, and shared ABI synchronization.

## Files changed

- `contracts/contracts/InsurancePolicy.sol`
- `contracts/contracts/InsuranceProvider.sol`
- `contracts/contracts/interfaces/IInsurancePolicy.sol`
- `contracts/contracts/interfaces/IInsuranceProviderCreatePolicy.sol`
- `contracts/contracts/mocks/MockWeatherOracle.sol`
- `contracts/contracts/mocks/NonPayableInsured.sol`
- `contracts/deployments/contract-size-baseline.json`
- `contracts/scripts/deploy.ts`
- `contracts/scripts/export-abi.ts`
- `contracts/scripts/stress-create-policies.ts`
- `contracts/test/InsuranceProvider.ts`
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
- Enforced direct-deployment safety parity with provider safeguards by requiring non-zero rainfall threshold and contract-based oracle address.
- Kept provider event semantics explicit: `WeatherOracleUpdated` is non-retroactive for deployed policies, and `PolicyPayoutExecuted` includes both coverage and premium amounts for indexer-ready settlement accounting.
- Kept provider oracle-update event self-descriptive by emitting `appliesToNewPoliciesOnly = true` and documenting non-retroactive behavior for existing policies.
- Kept policy expiry observability aligned with payout path by including insured context in policy-level `PolicyExpired` event.
- Kept transition-event semantics explicit by capturing previous status snapshot and emitting transition after state update.
- Exposed provider-side policy financial snapshots through a dedicated getter to reduce off-chain inference requirements.
- Added explicit provider-to-registry interface conformance (`IInsuranceProviderRegistry`) to catch signature drift at compile time.
- Prevented oracle-update no-op emissions by rejecting same-address updates before state mutation.
- Added `nonReentrant` on `expirePolicy` for audit consistency and defense in depth, even though flow already follows CEI and trusted-owner transfer.
- Kept payout/expiry business events emitted right after lifecycle transition while relying on transaction atomicity for rollback on transfer failure.
- Replaced mock-oracle policy-status bound magic number with `MAX_POLICY_STATUS` to improve code readability during audit and test maintenance.
- Kept oracle-side status check scoped to enum-range validation and delegated active-status enforcement to policy-level guards.
- Rejected zero-value withdrawals uniformly across reserve, premium, and untracked balance paths for operational symmetry with zero-value funding rejection.
- Kept local tooling aligned with test assumptions by setting mock oracle policy registry during local deploy and local stress-stack bootstrap.
- Kept Stage 03 same-block weather behavior unchanged and documented it with a deterministic test for future Stage 10 automation review.
- Preserved strict Stage 02 guardrails (`quality:check`, `baseline:check`, `artifacts:sync`) as mandatory on Stage 03 increments.

## Commands executed

- `cd contracts && npm run test`
- `cd contracts && npm run quality:check`
- `cd contracts && npm run format:write`
- `cd contracts && npm run quality:check`
- `cd contracts && npm run compile && npx cross-env UPDATE_SIZE_BASELINE=true ts-node scripts/report-contract-size.ts`
- `cd contracts && npm run baseline:check`
- `cd contracts && npm run artifacts:sync`

## Tests executed and results

- `npm run test`: passed (`77 passing`).
- `npm run quality:check`: passed (strict lint, format check, static scan fallback with no findings).
- `npm run baseline:check`: passed.
  - Size deltas: `InsurancePolicy +21`, `InsuranceProvider +320`, `MockWeatherOracle +0` (within tolerance).
  - Gas report generated successfully, including `requestPolicyWeatherData` method telemetry.

## Risks or pending items

- Oracle flow is still mock-based; production Chainlink request/fulfill pipeline remains for Stage 10.
- Payout failure for non-payable insured contracts remains terminal in current Stage 03 flow and requires explicit remediation strategy in later treasury/ops stages.
- Size baseline was refreshed after validated Stage 03 changes to keep future growth detection meaningful.
- Stage 03 has progressed through key lifecycle and interface-readiness increments; further refinements may still be added before declaring downstream-ready freeze.

## Credentials status

- Credentials required now: No.
- Credentials list: None for local compile/test/quality/baseline/ABI sync.
- Purpose: Stage 03 remains local-first and does not require private keys or external RPC credentials for this increment.

## Next stage handoff notes

- Stage 04 should extend transition matrix coverage toward invariant-style assertions and edge-case combinatorics.
- Keep interface-first discipline (`IInsurancePolicy`, `IInsuranceProviderRegistry`, `IWeatherOracleAdapter`) before introducing new integrations.
- Continue using `shared/abi/index.json` and deployment manifests as canonical downstream contract metadata.
- Re-run stress harness on any future change to creation paths, reserve accounting, or settlement lifecycle behavior.
