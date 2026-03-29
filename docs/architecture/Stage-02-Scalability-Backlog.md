# Stage 02 Scalability Backlog

This backlog captures optional Stage 02 enhancements for teams targeting larger-scale delivery from early phases.

## Priority A - High value, low coupling

- Interface-first contract boundaries (`contracts/interfaces/`).
- ABI export pipeline to `shared/abi/`.
- Per-network deployment manifest generation.
- Solidity lint + format commands integrated in npm scripts.

## Priority B - Medium complexity, strong long-term payoff

- Gas usage baseline reporting for critical flows.
- Bytecode size budget checks for contract growth control.
- Reproducible fixture seeds for larger local test datasets.

## Priority C - Useful but can wait for later stages

- Local stress harness for burst policy creation.
- Static security analysis preset and report directory conventions.
- Contract package versioning strategy for ABI consumers.

## Recommended sequencing

1. Priority A in Stage 02 extension pass.
2. Priority B before Stage 04 hard quality gates.
3. Priority C before Stage 10 oracle productionization.

## Credentials status

- Credentials required now: No for all Priority A/B baseline tasks in local mode.
- Credentials list: None, unless external testnet deployment is included.
- Purpose: Keep Stage 02 fast and deterministic while deferring secrets to integration stages.
