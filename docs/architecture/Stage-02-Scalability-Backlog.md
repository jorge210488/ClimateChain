# Stage 02 Scalability Backlog

This backlog captures optional Stage 02 enhancements for teams targeting larger-scale delivery from early phases.

## Current status snapshot

- Implemented in current Stage 02 extension pass:
  - Interface-first contract boundaries.
  - ABI export pipeline.
  - Per-network deployment manifests.
  - Solidity lint/format integration.
  - Static analysis command (`analyze:static`) with optional Slither.
  - Gas usage reporting and contract-size baseline checks.
  - Local stress harness for burst policy creation.
- Remaining or partial:
  - Static analysis report-directory conventions are not standardized yet.
  - Contract package versioning strategy for ABI consumers remains pending.

## Priority A - High value, low coupling

- Interface-first contract boundaries (`contracts/interfaces/`). Status: Implemented.
- ABI export pipeline to `shared/abi/`. Status: Implemented.
- Per-network deployment manifest generation. Status: Implemented.
- Solidity lint + format commands integrated in npm scripts. Status: Implemented.

## Priority B - Medium complexity, strong long-term payoff

- Gas usage baseline reporting for critical flows. Status: Implemented.
- Bytecode size budget checks for contract growth control. Status: Implemented.
- Reproducible fixture seeds for larger local test datasets. Status: Implemented (`loadFixture` usage in tests).

## Priority C - Useful but can wait for later stages

- Local stress harness for burst policy creation (`npm run stress:policies:local` or `npm run stress:policies:localhost`). Status: Implemented.
- Static security analysis preset and report directory conventions. Status: Partial (preset implemented, report conventions pending).
- Contract package versioning strategy for ABI consumers. Status: Pending.

## Recommended sequencing

1. Priority A in Stage 02 extension pass.
2. Priority B before Stage 04 hard quality gates.
3. Priority C before Stage 10 oracle productionization.

## Credentials status

- Credentials required now: No for all Priority A/B baseline tasks in local mode.
- Credentials list: None, unless external testnet deployment is included.
- Purpose: Keep Stage 02 fast and deterministic while deferring secrets to integration stages.
