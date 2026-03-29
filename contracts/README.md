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
- Format contracts/scripts/tests: `npm run format:write`
- Deploy to ephemeral hardhat network: `npm run deploy:hardhat`
- Deploy to localhost: `npm run deploy:localhost`
- Deploy to Sepolia: `npm run deploy:sepolia`

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
