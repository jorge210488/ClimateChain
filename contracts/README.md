# Contracts Module

On-chain logic for policy creation, weather-trigger checks, and payouts.

## Current Scope (Stage 02)

- `contracts/InsuranceProvider.sol`
- `contracts/InsurancePolicy.sol`
- `contracts/mocks/MockWeatherOracle.sol`
- `scripts/` deployment and helper scripts
- `test/` contract tests
- `hardhat.config.ts`

## Commands

- Install dependencies: `npm install`
- Compile contracts: `npm run compile`
- Sync compiled artifacts to shared ABI: `npm run artifacts:sync`
- Run tests: `npm test`
- Run quality gates (lint + format check): `npm run quality:check`
- Run static analysis gate (optional Slither + fallback scanner): `npm run analyze:static`
- Run gas report: `npm run gas:report`
- Run contract size check: `npm run size:check`
- Run combined baseline checks (size + gas): `npm run baseline:check`
- Format contracts/scripts/tests: `npm run format:write`
- Deploy to ephemeral hardhat network: `npm run deploy:hardhat`
- Deploy to localhost: `npm run deploy:localhost`
- Deploy to Sepolia: `npm run deploy:sepolia`
- Run local burst-creation stress harness on ephemeral hardhat: `npm run stress:policies:local`
- Run local burst-creation stress harness on localhost node: `npm run stress:policies:localhost`

Stress harness environment knobs (optional):
- `STRESS_POLICIES_COUNT` (default: `20`)
- `STRESS_BURST_SIZE` (default: `5`)
- `STRESS_INSURED_ACCOUNTS` (default: `5`, must be >= burst size)
- `STRESS_COVERAGE_ETH` (default: `0.2`)
- `STRESS_PREMIUM_BPS` (default: `125`)
- `STRESS_RAINFALL_THRESHOLD_MM` (default: `30`)
- `STRESS_DURATION_DAYS` (default: `14`)
- `STRESS_PROVIDER_ADDRESS` (reuse an existing local provider deployment)
- `STRESS_FORCE_DEPLOY` (`true|false`, default: `false`)

## Stage 02 Scalability Outputs

- Interface-first boundaries under `contracts/interfaces/`.
- Shared ABI exports written to `../shared/abi/`.
- Deterministic deployment manifests written to `deployments/<network>.json`.

## Environment

Copy `contracts/.env.example` to `contracts/.env` and set required values.
- `RPC_URL`
- `PRIVATE_KEY`
- `EXTERNAL_WEATHER_ORACLE_ADDRESS` (required for non-local deployments, for example Sepolia)
- Optional explorer verification: `ETHERSCAN_API_KEY`

Deployment behavior by network:
- `hardhat` and `localhost`: deploys `MockWeatherOracle` automatically.
- Non-local networks: requires `EXTERNAL_WEATHER_ORACLE_ADDRESS` and does not deploy a mock.

## Standards

- Solidity code and identifiers must be in English.
- Use OpenZeppelin contracts and security patterns.
- Add tests for every state transition and payout condition.
