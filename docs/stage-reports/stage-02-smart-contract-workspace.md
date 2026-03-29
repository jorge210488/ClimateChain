# Stage 02 - Smart Contract Workspace

## Scope completed

- Objective achieved: Established a functional Hardhat + TypeScript smart-contract workspace and completed a Stage 02 scalability extension pass.
- Purpose and value: Create a reliable on-chain foundation that enables safe iteration speed, clean module boundaries, and reproducible artifact promotion.
- Functional result: Contracts compile and test in one command, interfaces decouple policy interactions, ABIs sync to shared assets, deployment manifests are generated per network, and quality gates are executable locally.
- Bootstrapped a TypeScript-based Hardhat workspace in `contracts/`.
- Added OpenZeppelin contracts dependency and environment-driven Hardhat network profiles.
- Implemented initial smart contracts:
  - `InsuranceProvider.sol`
  - `InsurancePolicy.sol`
- Added local oracle mock contract:
  - `mocks/MockWeatherOracle.sol`
- Added deployment script and baseline unit tests for policy creation and payout trigger flow.
- Added interface-first boundary in `contracts/interfaces/IInsurancePolicy.sol` and wired provider/mock interactions through it.
- Added ABI export pipeline from `contracts/artifacts` to `shared/abi` with index generation.
- Added deterministic deployment manifest output to `contracts/deployments/<network>.json`.
- Added Stage 02 quality gates (`solhint`, `prettier`) with reusable npm scripts.
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
- `contracts/contracts/mocks/MockWeatherOracle.sol`
- `contracts/scripts/deploy.ts`
- `contracts/scripts/export-abi.ts`
- `contracts/test/InsuranceProvider.ts`
- `contracts/.prettierrc.json`
- `contracts/.prettierignore`
- `contracts/.solhint.json`
- `contracts/deployments/README.md`
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
- `cd contracts && npm run format:write && npm run quality:check`
- `cd contracts && npm run deploy:hardhat`
- `cd contracts && npm run compile && npm test && npm run quality:check`
- `cd contracts && npm run artifacts:sync && npm run deploy:hardhat`

## Tests executed and results

- `npm run compile`: passed.
- `npm test`: passed (30 tests).
- `npm run artifacts:sync`: passed and ABIs exported to `shared/abi`.
- `npm run quality:check`: passed with strict zero-warning Solidity lint gate.
- `npm run deploy:hardhat`: passed and generated `contracts/deployments/hardhat.json`.
- Contract test results:
  - `creates and tracks policy by insured account` -> passing
  - `executes payout after oracle threshold is met and books premium separately` -> passing
  - `returns coverage to reserve and books premium separately when policy expires` -> passing
  - `withdraws premium balance without affecting coverage reserve` -> passing
  - `withdraws untracked ETH without changing reserve or premium balances` -> passing
  - `rejects untracked ETH withdrawal above available amount` -> passing
  - `updates weather oracle and uses it for newly created policies` -> passing
  - `rejects payout execution when policy is not triggered` -> passing
  - `rejects policy expiry through provider when policy is triggered` -> passing
  - `rejects expiring a policy still in created status` -> passing
  - `withdraws coverage reserve and updates reserve balance` -> passing
  - `rejects coverage reserve withdrawal when amount exceeds reserve` -> passing
  - `rejects premium withdrawal when amount exceeds premium balance` -> passing
  - `accepts policy creation at exact minimum premium ratio` -> passing
  - `accepts policy creation at exact max duration` -> passing
  - `rejects zero-value reserve funding` -> passing
  - `returns empty policy list for insured account with no policies` -> passing
  - `tracks global policies count across multiple policy creations` -> passing
  - `rejects policy creation when reserve is insufficient` -> passing
  - `returns descriptive reserve error for extremely large coverage requests` -> passing
  - `rejects oracle pushes from a different mock oracle instance` -> passing
  - `rejects duplicate payout attempts` -> passing
  - `rejects unauthorized policy and oracle actions` -> passing
  - `rejects weather updates and requests outside policy window` -> passing
  - `rejects expiring a policy before end timestamp` -> passing
  - `rejects weather request on unknown policy` -> passing
  - `rejects out-of-range policy index lookups` -> passing

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

- Stage 03 should deepen treasury policy definitions (for example, reserve target rules and premium utilization policy).
- Keep expanding negative-path coverage for full lifecycle corner cases and eventual Chainlink integration paths.
- Keep ABI export and contract interface stability in mind for upcoming backend integration stages.
