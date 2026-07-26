# ClimateChain

Parametric climate micro-insurance platform built with smart contracts, a NestJS backend, and a Python ML pricing service.

## Repository Structure

- `contracts/`: Solidity contracts, tests, and deployment scripts.
- `backend/`: NestJS API and business orchestration.
- `ml-service/`: Python service for premium prediction.
- `infra/`: Docker, compose, and CI workflow assets.
- `shared/`: Shared ABI, schemas, and constants.
- `docs/`: Functional and technical project documentation.

## Toolchain Baseline

- Node.js `>=20.10.0`
- npm `>=10`
- Python `>=3.11`
- Docker + Docker Compose (optional for Stage 12 and later)

## Package Strategy

- Use `npm` for `contracts/` and `backend/`.
- Use `pip` (inside a virtual environment) for `ml-service/`.

## Commit Standard

- Commit messages are mandatory in English.
- Use the format: `<type>(<scope>): <short imperative summary>`.
- Full standard: `docs/Implementation-Step-By-Step.md` (section 2.3).
- Enable local template once: `git config commit.template .gitmessage.txt`.

## Current Stage

- Stage 02 (Smart Contract Workspace) completed.
- Stage 03 (On-Chain Domain Logic) completed.
- Stage 04 (Contract Hardening & Invariant Matrix) completed.
- Stage 05 (Backend Foundation) completed.
- Stage 06 (Backend to Blockchain Integration) completed.
- Stage 07 (ML Service Foundation) next.

## Quick Start (Foundation)

1. Copy and configure environment files per module:
   - `contracts/.env.example`
   - `backend/.env.example`
   - `ml-service/.env.example`
   - `infra/.env.example`
   - `shared/.env.example`
2. Install module dependencies once each module baseline is initialized:
   - `contracts/` with `npm install`
   - `backend/` with `npm install`
   - `ml-service/` with `python -m venv .venv` then `pip install -r requirements.txt`
3. Follow the execution playbook in `docs/Implementation-Step-By-Step.md`.

Node is pinned by `.nvmrc` (20.10.0) and `engines` in each package, matching CI.

### Run the local stack (contracts + backend)

Full procedure with expected output and failure modes:
**[`docs/runbooks/local-stack.md`](docs/runbooks/local-stack.md)**. Short version:

```bash
cd contracts && npx hardhat node             # terminal 1: chain on 127.0.0.1:8545
cd contracts && npm run deploy:localhost     # terminal 2: writes deployments/localhost.json
cd contracts && npm run reserve:fund:localhost  # required before any policy can be created
cd backend   && npm run start:dev            # terminal 2: API on http://localhost:3000
```

Point the backend at that chain with `BLOCKCHAIN_NETWORK=localhost` and
`RPC_URL=http://127.0.0.1:8545` in `backend/.env`.

> Use the `localhost` network, not `hardhat`, for anything that runs the
> backend. `hardhat` is an in-process chain that exists only for the lifetime of
> the command that created it, so the addresses in `deployments/hardhat.json`
> are not reachable over RPC.

The backend boots fail-fast against the Stage 04 outputs (`shared/abi`,
`contracts/deployments/<network>.json`). Health: `GET /health`; readiness:
`GET /health/ready`.

### Stage gates

Each module has one canonical gate, run locally and in CI:

```bash
cd contracts && npm run stage4:check   # compile, tests, solhint, slither, size/gas baseline, stress, ABI sync
cd backend   && npm run stage5:check   # chain-free: build, lint, audit, unit + e2e, startup, OpenAPI drift
cd backend   && npm run stage6:check   # the above plus live-chain e2e and coverage thresholds
```

`stage6:check` needs a running local chain with the contracts deployed and the
reserve funded (steps above); the integration it validates cannot be proven
without one.

## Credentials Guidance

- Stages 01 to 05 (completed): no real credentials required. The full local
  stack — compile, tests, both stage gates, a local chain, and the backend —
  runs with empty `.env` values.
- Stage 06 onward: an RPC endpoint is required, and a deployment/signer private
  key once transactions are submitted. A local Hardhat node covers this for
  development; testnet needs real values.
- Deployed profiles (staging/testnet/production) refuse to start without
  `JWT_SECRET`, `RPC_URL`, and `CORS_ORIGINS`. This is enforced at boot, not
  reported later as a readiness failure.
- Configure secrets only in local `.env` files derived from `.env.example`,
  never in committed files.

## Stage 02 Scalability Extensions

- Optional backlog for expanding Stage 02 toward larger-scale architecture:
  - `docs/architecture/Stage-02-Scalability-Backlog.md`

Detailed execution plan: `docs/Implementation-Step-By-Step.md`.
