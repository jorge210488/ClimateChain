# Stage 02 - Smart Contract Workspace

## Scope completed

- Objective achieved: Established a functional Hardhat + TypeScript smart-contract workspace and completed a Stage 02 scalability extension pass.
- Purpose and value: Create a reliable on-chain foundation that enables safe iteration speed, clean module boundaries, and reproducible artifact promotion.
- Functional result: Contracts compile and test in one command, interfaces decouple policy interactions, ABIs sync to shared assets, deployment manifests are generated per network, quality gates are executable locally, and baseline telemetry (gas/size/stress) is operational.
- Bootstrapped a TypeScript-based Hardhat workspace in `contracts/`.
- Added OpenZeppelin contracts dependency and environment-driven Hardhat network profiles.
- Implemented initial smart contracts:
  - `InsuranceProvider.sol`
  - `InsurancePolicy.sol`
- Added local oracle mock contract:
  - `mocks/MockWeatherOracle.sol`
- Added deployment script and baseline unit tests for policy creation and payout trigger flow.
- Added interface-first boundary in `contracts/interfaces/IInsurancePolicy.sol` and wired provider/mock interactions through it.
- Added interface-first adapter boundaries in `contracts/interfaces/IInsuranceProviderRegistry.sol` and `contracts/interfaces/IWeatherOracleAdapter.sol` to harden cross-contract coupling.
- Added ABI export pipeline from `contracts/artifacts` to `shared/abi` with index generation.
- Added deterministic deployment manifest output to `contracts/deployments/<network>.json`.
- Added Stage 02 quality gates (`solhint`, `prettier`, static scan with optional Slither) with reusable npm scripts.
- Added contract size baseline and growth checks, including EIP-170 size guardrails.
- Added gas usage baseline reporting for critical flows.
- Added local burst stress harness for mass policy creation with configurable `STRESS_*` workload parameters.
- Added risk-mitigation pass for policy settlement flows and temporal validation:
  - policy contract now forwards remaining ETH back to provider on payout/expiry.
  - provider receives settlement transfers and now books reserve and premium balances separately.
  - provider exposes premium balance withdrawal without affecting coverage reserve.
  - provider now exposes explicit withdrawal for untracked ETH to avoid trapped balance from unexpected transfers.
  - provider payout/expiry flows now use strict CEI ordering with `nonReentrant` on both entrypoints.
  - policy expiry flow now rejects `Created` status explicitly.
  - premium minimum calculation now uses overflow-safe arithmetic and reserve validation order prioritizes descriptive errors.
  - oracle request/fulfill paths now enforce policy weather window boundaries.
  - provider index access now uses explicit custom bounds error.
  - weather oracle update event now states that changes do not retroactively affect existing policies.
- Expanded contract tests from baseline happy-path coverage to include critical negative paths.
- Refactored test harness to `loadFixture` snapshots and expanded admin/boundary coverage to reduce regression risk.
- Hardened quality gates to strict mode with zero-warning Solidity lint policy (`solhint --max-warnings 0`).
- Enabled NatSpec enforcement for contract/interface public surfaces to improve audit readability.
- Hardened deployment script to require an external oracle address on non-local networks (no mock auto-deploy on Sepolia).

## Files changed

- `contracts/package.json`
- `contracts/package-lock.json`
- `contracts/tsconfig.json`
- `contracts/hardhat.config.ts`
- `contracts/.env.example`
- `contracts/README.md`
- `contracts/contracts/InsuranceProvider.sol`
- `contracts/contracts/InsurancePolicy.sol`
- `contracts/contracts/interfaces/IInsurancePolicy.sol`
- `contracts/contracts/interfaces/IInsuranceProviderRegistry.sol`
- `contracts/contracts/interfaces/IWeatherOracleAdapter.sol`
- `contracts/contracts/mocks/MockWeatherOracle.sol`
- `contracts/scripts/deploy.ts`
- `contracts/scripts/export-abi.ts`
- `contracts/scripts/report-contract-size.ts`
- `contracts/scripts/static-analysis.ts`
- `contracts/scripts/stress-create-policies.ts`
- `contracts/test/InsuranceProvider.ts`
- `contracts/.prettierrc.json`
- `contracts/.prettierignore`
- `contracts/.solhint.json`
- `contracts/deployments/README.md`
- `contracts/deployments/contract-size-baseline.json`
- `contracts/deployments/hardhat.json`
- `shared/abi/InsurancePolicy.json`
- `shared/abi/InsuranceProvider.json`
- `shared/abi/MockWeatherOracle.json`
- `shared/abi/index.json`

## Decisions made

- Pinned Hardhat to `2.28.0` and toolbox to `4.0.0` to stay compatible with Node `20.10.0` in the current environment.
- Pinned TypeScript to `5.6.3` to avoid Hardhat + TS6 compatibility issues during compilation.
- Chose explicit module-level npm scripts (`compile`, `test`, deploy scripts by network) for reproducible local workflows.
- Tightened Solidity lint policy to block warnings in local quality checks.
- Fixed Sepolia chain ID to canonical `11155111` in Hardhat config.
- Export ABIs into `shared/abi` as the single source consumed by future backend integration.
- Kept contract identifiers and environment keys fully in English.
- Tracked settlement recovery with explicit reserve/premium split to avoid accounting drift.
- Hardened mock oracle destination checks to assert policy interface shape and expected oracle ownership.
- Enforced policy weather window checks at both request and fulfill entrypoints.
- Replaced enum magic numbers in tests with explicit status constants for maintainability.

## Commands executed

- `cd contracts && npm init -y`
- `cd contracts && npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox typescript ts-node @types/node dotenv`
- `cd contracts && npm install @openzeppelin/contracts`
- `cd contracts && npm install --save-dev hardhat@2.28.0 @nomicfoundation/hardhat-toolbox@4.0.0`
- `cd contracts && npm install --save-dev typescript@5.6.3`
- `cd contracts && npm run compile`
- `cd contracts && npm test`
- `cd contracts && npm install --save-dev prettier prettier-plugin-solidity solhint`
- `cd contracts && npm run artifacts:sync`
- `cd contracts && npm test`
- `cd contracts && npm run quality:check`
- `cd contracts && npm run analyze:static`
- `cd contracts && npm run size:check`
- `cd contracts && npm run baseline:check`
- `cd contracts && STRESS_POLICIES_COUNT=6 STRESS_BURST_SIZE=3 STRESS_INSURED_ACCOUNTS=3 npm run stress:policies:local`
- `cd contracts && npm run format:write && npm run quality:check`
- `cd contracts && npm run deploy:hardhat`
- `cd contracts && npm run compile && npm test && npm run quality:check`
- `cd contracts && npm run artifacts:sync && npm run deploy:hardhat`

## Tests executed and results

- `npm run compile`: passed.
- `npm test`: passed (54 tests).
- `npm run artifacts:sync`: passed and ABIs exported to `shared/abi`.
- `npm run quality:check`: passed with strict zero-warning Solidity lint gate and static scan.
- `npm run deploy:hardhat`: passed and generated `contracts/deployments/hardhat.json`.
- `npm run size:check`: passed, baseline deltas within configured tolerance.
- `npm run baseline:check`: passed, gas report + size check completed.
- `npm run stress:policies:local` (sample run): passed with burst creation summary and throughput metrics.
- Expanded coverage includes deficit guards, oracle provenance checks, exact-threshold boundary behavior, one-below-threshold behavior, constructor/setter EOA rejection, and lifecycle replay protection.

## Risks or pending items

- Current oracle flow is a local mock; real Chainlink request/fulfill and automation logic remains for Stage 10.
- Reserve release on expiry and premium recovery on settlement are now implemented; advanced treasury policy remains for Stage 03.
- Provider accounting currently assumes synchronous policy close calls; if Stage 10 introduces asynchronous settlement callbacks, reconciliation must move to explicit callback/event-driven accounting.
- Non-local deployment now requires explicit oracle address configuration; deployment should fail-fast when missing.
- `npm audit` reports transitive dev dependency vulnerabilities in tooling stack; evaluate remediation strategy before production pipelines.
- Strict lint ordering is now enforced; future refactors must preserve declaration/function ordering to keep the gate green.

## Credentials status

- Credentials required now: No.
- Credentials list: None for local compile/test/ABI export/lint/format/deploy on hardhat.
- Purpose: Stage 02 remains local-first; real credentials are deferred until external RPC/oracle integration and testnet deployment.

## Next stage handoff notes

- Stage 03 must extend logic through interfaces first and preserve adapter boundaries (`IInsurancePolicy`, `IInsuranceProviderRegistry`, `IWeatherOracleAdapter`) before adding new integrations.
- Stage 03 and Stage 04 should treat `npm run quality:check` and `npm run baseline:check` as mandatory merge gates, not optional local checks.
- Stage 03+ should use the stress harness (`npm run stress:policies:local`) as a recurring regression/performance smoke test when touching creation paths, storage indexing, or reserve accounting.
- Stage 05+ backend integration should consume `shared/abi/index.json` and `contracts/deployments/<network>.json` as canonical contract metadata sources.
- Stage 10 oracle productionization should replace mock internals behind the existing adapter boundary to avoid provider/policy API churn.
