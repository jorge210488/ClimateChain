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
- Stage 04 (Contract Hardening & Invariant Matrix) next.

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
   - `ml-service/` with `pip install -r requirements.txt`
3. Follow the execution playbook in `docs/Implementation-Step-By-Step.md`.

## Credentials Guidance

- Stage 01 and Stage 02 (current progress): no real credentials required for local scaffolding, compile, and tests.
- Starting from integration and deployment stages: credentials become mandatory (for example RPC endpoint and deployment private key).
- Configure secrets only in local `.env` files derived from `.env.example`, never in committed files.

## Stage 02 Scalability Extensions

- Optional backlog for expanding Stage 02 toward larger-scale architecture:
  - `docs/architecture/Stage-02-Scalability-Backlog.md`

Detailed execution plan: `docs/Implementation-Step-By-Step.md`.
