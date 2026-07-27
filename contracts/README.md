# Contracts Module

On-chain logic for policy creation, weather-trigger checks, and payouts.

## Current Scope (Stage 04, consumed by Stage 06)

- `contracts/InsuranceProvider.sol`
- `contracts/InsurancePolicy.sol`
- `contracts/mocks/MockWeatherOracle.sol`
- `contracts/interfaces/` interface-first boundaries
- `scripts/` deployment and helper scripts
- `test/` contract tests
- `hardhat.config.ts`

## Commands

- Install dependencies: `npm install`
- Compile contracts: `npm run compile`
- Sync compiled artifacts to shared ABI: `npm run artifacts:sync`
- Run tests: `npm test`
- Run quality gates (lint + format check + Stage-04 static analysis profile): `npm run quality:check`
- Run Stage-04 static analysis profile only: `npm run analyze:static`
- Run full static analysis profile (non-blocking reporting): `npm run analyze:static:full`
- Run gas report: `npm run gas:report`
- Run contract size check: `npm run size:check`
- Update contract size baseline after reviewed intentional growth: `npm run size:baseline:update`
- Run combined baseline checks (size + gas): `npm run baseline:check`
- Format contracts/scripts/tests: `npm run format:write`
- Deploy to ephemeral hardhat network: `npm run deploy:hardhat`
- Deploy to localhost: `npm run deploy:localhost`
- Deploy to Sepolia: `npm run deploy:sepolia`
- Fund the provider coverage reserve on localhost: `npm run reserve:fund:localhost`
- Fund the provider coverage reserve on Sepolia: `npm run reserve:fund:sepolia`
- Run local burst-creation stress harness on ephemeral hardhat: `npm run stress:policies:local`
- Run local burst-creation stress harness on localhost node: `npm run stress:policies:localhost`
- Run deterministic local stress smoke (Stage 03/04 gate): `npm run stress:policies:local:smoke`
- Run consolidated Stage 03 gate (quality + baseline + stress smoke + ABI sync): `npm run stage3:check`
- Run consolidated Stage 04 gate (compile + tests + quality + baseline + stress smoke + ABI sync): `npm run stage4:check`

### Coverage reserve (required after every deploy)

A freshly deployed provider holds no coverage reserve, so **every**
`createPolicy` call reverts with `InsufficientCoverageReserve` until an owner
funds it. `fundCoverageReserve` is owner-only, so this cannot be done by the
backend — it is an operational step between deploying and any policy flow
working:

```bash
npm run deploy:localhost
npm run reserve:fund:localhost      # 10 ETH by default
COVERAGE_RESERVE_ETH=25 npm run reserve:fund:localhost
```

The script resolves the provider from `deployments/<network>.json`, verifies the
configured signer is the contract owner before submitting, and prints the
reserve before and after. Consumers see the unfunded state as HTTP `503` from
the backend, naming the shortfall.

Stress harness environment knobs (optional):

- `STRESS_POLICIES_COUNT` (default: `20`)
- `STRESS_BURST_SIZE` (default: `5`)
- `STRESS_INSURED_ACCOUNTS` (default: `5`, must be >= burst size)
- `STRESS_COVERAGE_ETH` (default: `0.2`)
- `STRESS_PREMIUM_BPS` (default: `125`)
- `STRESS_RAINFALL_THRESHOLD_MM` (default: `30`)
- `STRESS_DURATION_DAYS` (default: `14`)
- `STRESS_REGION_CODE` (default: `STRESS`, 1-31 ASCII chars)
- `STRESS_START_OFFSET_SECONDS` (default: `300`)
- `STRESS_PROVIDER_ADDRESS` (reuse an existing local provider deployment)
- `STRESS_FORCE_DEPLOY` (`true|false`, default: `false`)
- Reused deployment behavior: stress harness now auto-aligns mock `policyRegistry` with provider when possible.

## Stage 03/04 Domain and Gate Outputs

- Interface-first boundaries under `contracts/interfaces/`.
- Shared ABI exports written to `../shared/abi/`.
- ABI exports are deterministic (no per-run timestamps) to reduce non-functional drift noise.
- Deterministic deployment manifests written to `deployments/<network>.json`.
- Provider policy creation supports both legacy and metadata-aware flows (`createPolicyWithMetadata`) with region and requested-start metadata.
- Provider policy creation applies a minimum lead-time before weather-window opening.
- Provider exposes paginated policy getters for insured and global lists.
- Provider exposes settlement metadata via `getPolicySettlementInfo(policyAddress)`.
- Provider weather request flow emits canonical request-id tracking events for oracle fulfill provenance.
- Policy weather flow tracks one pending request id and validates fulfill callbacks against that id.
- Policy payout flow supports deferred claims (`claimPendingPayout`) when immediate insured transfer fails.
- Deferred claims cannot strand coverage: the insured may route them to any recipient (`claimPendingPayoutTo`), and the owner may return an unclaimed amount to the coverage reserve (`recoverUnclaimedPolicyPayout`) only after a 365-day claim window.
- Weather oracle adapter and mock support explicit request-id push overloads.
- Mock oracle supports optional strict policy-registry mode to prevent accidental provenance disablement.
- Stage-04 quality gates run lint, format, static analysis, baseline checks, stress smoke, and ABI sync through one command.

## Environment

Copy `contracts/.env.example` to `contracts/.env` and set required values.

- `RPC_URL`
- `PRIVATE_KEY`
- `EXTERNAL_WEATHER_ORACLE_ADDRESS` (required for non-local deployments, for example Sepolia)
- `STRICT_POLICY_PROVENANCE` (`true|false`, optional for local deploy; when true, local mock blocks unsetting `policyRegistry`)
- Optional explorer verification: `ETHERSCAN_API_KEY`

Deployment behavior by network:

- `hardhat` and `localhost`: deploys `MockWeatherOracle` automatically.
- Non-local networks: requires `EXTERNAL_WEATHER_ORACLE_ADDRESS` and does not deploy a mock.

> **Use `localhost`, not `hardhat`, for anything the backend connects to.**
> `hardhat` is an in-process chain that exists only for the lifetime of the
> command that created it, so the addresses in `deployments/hardhat.json` are not
> reachable over RPC. The backend verifies bytecode at those addresses on boot
> and refuses to start against a stale manifest. Full procedure:
> [`docs/runbooks/local-stack.md`](../docs/runbooks/local-stack.md).

## Standards

- Solidity code and identifiers must be in English.
- Use OpenZeppelin contracts and security patterns.
- Add tests for every state transition and payout condition.
