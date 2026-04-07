# ClimateChain Implementation Step-by-Step (Detailed)

This document is the operational playbook for execution. It expands the implementation stages with concrete tasks, acceptance criteria, risks, and handoff checkpoints.

## 1. Execution Principles

- Use incremental delivery by stage.
- Keep one source of truth for architecture decisions in `docs/`.
- Prefer small, reviewable commits aligned to one logical change.
- Validate each stage with tests before moving to the next one.
- Keep all code identifiers and environment variables in English.
- Treat every stage as production-oriented, not as a lightweight placeholder checkpoint.
- Ensure each stage integrates and executes with artifacts from previous completed stages.
- Avoid runtime mock dependencies in dev/staging/testnet/prod profiles; mocks are for tests only.
- Define one reproducible stage verification command per stage and keep it green before closure.
- Preserve previously established quality gates when adding new complexity; only tighten, never bypass.

## 2. Stage Completion Rule (Mandatory)

When a stage is completed, create a report file under:

- `docs/stage-reports/stage-XX-<short-name>.md`

The report must be written in English and include these exact sections:

1. Scope completed
2. Files changed
3. Decisions made
4. Commands executed
5. Tests executed and results
6. Risks or pending items
7. Next stage handoff notes

## 2.1 Credentials and Secrets Policy (Mandatory)

- Do not configure real credentials in source-controlled files.
- Keep local secrets only in module-level `.env` files created from `.env.example`.
- A stage must explicitly state whether credentials are required now or deferred.
- For local-only stages (for example, compile/test scaffolding), use empty placeholders and avoid requesting private keys unnecessarily.
- For integration/deployment stages, document the minimum required keys and their purpose.

Required credential declaration format in stage reports:

- `Credentials required now:` Yes/No
- `Credentials list:` variable names only (no values)
- `Purpose:` one line per credential explaining why it is needed

## 2.2 Stage Communication Standard (Mandatory)

To ensure operational clarity, each completed stage report must include objective and purpose details inside `Scope completed`.

The first bullets inside `Scope completed` must always be:

- `Objective achieved:` what was completed in this stage.
- `Purpose and value:` why this stage matters for system scalability, security, or delivery flow.
- `Functional result:` what is now working after this stage.

## 2.3 Commit Message Standard (Mandatory)

All commit messages must be written in English and follow one consistent style.

Required header format:

- `<type>(<scope>): <short imperative summary>`

Allowed `type` values:

- `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, `build`, `perf`, `security`, `revert`

Header rules:

- Use lowercase `type` and lowercase `scope`.
- Keep summary concise and imperative (for example, "add", "fix", "remove", "update").
- Keep header under 72 characters when possible.
- Do not end the summary with a period.

Recommended body template:

- `Why:` business or technical motivation.
- `What:` key implementation changes.
- `Test:` commands executed and result.

Examples:

- `feat(contracts): add minimum premium ratio validation`
- `fix(provider): prevent duplicate settlement accounting`
- `docs(stage-02): record strict lint gate decisions`

Git template setup (local repository):

- `git config commit.template .gitmessage.txt`

## 2.4 Integration Continuity Standard (Mandatory)

- A stage is complete only if it consumes and validates outputs from previous stages.
- Stage reports must list which previous-stage artifacts were integrated (for example ABIs, manifests, DTO contracts, model schemas).
- "Compiles locally" is not sufficient as completion evidence when cross-module integration is in scope.
- If a dependency stage output is unavailable, mark the stage as blocked or partial; do not label it complete.

## 2.5 Runtime Data and Mocking Policy (Mandatory)

- Mock data is allowed only in automated tests and deterministic local test harnesses.
- Runtime application paths (backend, oracle integration, ML calls, indexing) must use real integrations for dev/staging/testnet/prod profiles.
- Any temporary simulation in non-test runtime must be explicitly tagged as transitional and cannot be used to declare production readiness.
- Stage reports must declare runtime data sources used and whether each source is real or test-only.

## 2.6 Production-Readiness Gate (Mandatory)

- Each stage must define and run one stage gate command that validates the full scope claimed for that stage.
- Stage completion requires passing local gate execution and CI execution when CI exists for that module.
- Gate evidence must cover correctness, security checks, observability basics, and operational reproducibility relevant to that stage.
- Each stage handoff must include explicit unresolved risks, production blockers, and mitigation ownership.

## 3. Recommended Repository Structure

```text
ClimateChain/
  docs/
    Guide.md
    Implementation-Step-By-Step.md
    stage-reports/
    architecture/
    api/
    runbooks/
  contracts/
    contracts/
    scripts/
    test/
    hardhat.config.ts
  backend/
    src/
    test/
  ml-service/
    app/
    tests/
  infra/
    docker/
    compose/
  shared/
    abi/
    schemas/
```

## 4. Stage-by-Stage Plan

### Cross-Stage Completion Contract (Mandatory)

- Do not close a stage if implemented behavior is isolated and not integrated with prior-stage outputs.
- Do not close a stage if runtime behavior still depends on mocks outside test environments.
- Keep previous stage gates active and include them in newer stage gates when applicable.
- Require at least one end-to-end scenario per stage that exercises the new capability together with prior completed capabilities.

## Stage 01 - Repository Foundation

### Objective

Create a stable baseline for all modules and development workflows.

### Inputs

- Product scope from `docs/Guide.md`
- Toolchain constraints (Node 18+, Python 3.11+)

### Tasks

- Create root directories for `contracts`, `backend`, `ml-service`, `infra`, `shared`, `docs/stage-reports`.
- Define root `.gitignore` and `.dockerignore`.
- Add `.env.example` files for each module.
- Add root `README.md` with prerequisites and quick-start.
- Define package manager strategy (npm/pnpm, pip).

### Acceptance Criteria

- Project starts with a clear, navigable structure.
- Secret files are ignored.
- New contributors can understand project layout from README.

### Risks

- Ambiguous folder ownership may create duplicated logic.
- Missing env templates blocks onboarding.

### Exit Deliverables

- Working repository skeleton.
- Ignore rules and baseline docs.

## Stage 02 - Smart Contract Workspace

### Objective

Initialize contract development environment with repeatable compilation/testing.

### Inputs

- Stage 01 repository structure

### Tasks

- Bootstrap Hardhat with TypeScript.
- Add OpenZeppelin dependencies.
- Configure compiler version and network profiles.
- Create initial contracts: `InsuranceProvider.sol`, `InsurancePolicy.sol`.
- Add local mock contracts for oracle behavior.
- Add interface-first boundaries in `contracts/interfaces/` to decouple provider, policy, and oracle adapters.
- Add ABI export automation from Hardhat artifacts to `shared/abi/` for downstream backend integration.
- Add deterministic deployment metadata output (per-network JSON) for reproducible environment promotion.
- Add baseline quality gates at workspace level: Solidity linting, formatting, and static analysis placeholders.
- Add gas/bytecode baseline checks to prevent uncontrolled growth before Stage 04.
- Add local stress scripts to simulate high policy-creation volume and catch early storage/indexing bottlenecks.

### Additional Acceptance Criteria

- ABI artifacts required by backend are exportable with one command.
- Deployment addresses are reproducibly generated and persisted per environment.
- Contract quality gates can be executed locally before opening pull requests.
- Basic gas/size telemetry exists for top contract methods.

### Acceptance Criteria

- Contracts compile with no warnings that affect behavior.
- Local tests can run from a single command.
- ABI export and deployment manifest generation are reproducible and consumed as integration outputs.
- Stage quality and baseline gates pass locally and are ready to be promoted into CI.
- Non-local deployment path supports real external oracle address configuration (no implicit mock fallback).

### Risks

- Compiler mismatch between local and CI.
- Unclear interface boundaries between provider and policy contracts.

### Exit Deliverables

- Hardhat workspace committed.
- Initial contracts and mock contracts scaffolded.

### Stage 02 Reusable Foundation (Mandatory for Stage 03+)

- Preserve and extend interface-first boundaries in `contracts/interfaces/` before introducing new provider/policy/oracle behavior.
- Keep ABI export (`npm run artifacts:sync`) and deployment manifest generation (`contracts/deployments/<network>.json`) as canonical integration outputs.
- Treat quality and baseline commands as required engineering guardrails:
  - `npm run quality:check`
  - `npm run baseline:check`
- Run local burst stress harness (`npm run stress:policies:local`) when lifecycle, reserve accounting, or policy creation paths change.
- Avoid bypassing existing Stage 02 checks in later stages; extend them when new complexity is introduced.

## Stage 03 - On-Chain Domain Logic

### Objective

Implement policy lifecycle, payout logic, and oracle callback flow safely.

### Inputs

- Contract skeleton from Stage 02
- Stage 02 interface boundaries and adapter contracts (`contracts/interfaces/`)
- Stage 02 ABI/index export and deployment manifest outputs
- Stage 02 quality/baseline/stress command set

### Tasks

- Define state machine for policy lifecycle.
- Add custom errors/events for observability.
- Implement policy creation, active tracking, expiry, payout eligibility.
- Implement oracle request and fulfill handlers.
- Add reentrancy and access control protections.
- Extend behavior through interface contracts first, then wire provider/policy/oracle implementations.
- Keep `shared/abi` compatibility and deployment-manifest compatibility for backend consumers.
- Validate each Stage 03 increment with `npm run quality:check` and `npm run baseline:check`.

### Acceptance Criteria

- Single payout guarantee is enforced.
- Policy transitions are deterministic and testable.
- Oracle callback updates state correctly.
- Existing Stage 02 quality and baseline gates remain green after each feature addition.
- New complexity does not break interface compatibility required by downstream modules.
- Non-local deployment path remains compatible with real oracle adapter addressing and fail-fast validation.
- Lifecycle observability is sufficient for backend/indexer consumers without relying on implementation internals.

### Risks

- Incorrect payout conditions.
- Missing edge-case validations for dates/thresholds.

### Exit Deliverables

- Functional contract logic for end-to-end policy lifecycle.

## Stage 04 - Contract Testing and Quality Gates

### Objective

Establish high-confidence contract correctness with unit and property-focused tests.

### Inputs

- On-chain logic from Stage 03
- Stage 02 baseline scripts (`analyze:static`, `gas:report`, `size:check`, `baseline:check`)
- Stage 02 stress harness script for burst creation paths

### Tasks

- Add unit tests for creation, expiry, payout, and oracle updates.
- Add negative tests for unauthorized calls and invalid states.
- Add invariant-style assertions where possible.
- Keep gas and bytecode baseline checks active on every release candidate.
- Run burst stress harness after major lifecycle or accounting changes.
- Promote quality and baseline checks into CI as required gates.
- Add ABI drift detection in CI to prevent contract-interface desynchronization in shared artifacts.
- Configure branch protection to require the contracts quality gate job before merge.

### Acceptance Criteria

- Core happy paths and critical failure paths are covered.
- No unresolved failing tests.
- Baseline checks pass (size growth within tolerance and gas report produced).
- Stress harness executes successfully under agreed local workload profile.
- CI quality gate is mandatory for contracts-related pull requests.
- Shared ABI synchronization checks pass in CI for contract/interface changes.
- Branch protection is configured so failing contract gates block merge.

### Risks

- Overfitting tests to implementation details.
- Insufficient coverage on state transitions.

### Exit Deliverables

- Contract test suite and reproducible execution commands.

## Stage 05 - Backend Foundation (NestJS)

### Objective

Build a production-oriented API foundation with modular architecture, runtime validation, and direct compatibility with existing on-chain artifacts.

### Inputs

- API responsibilities from `docs/Guide.md`
- Stage 04 contract outputs (`shared/abi/index.json`, `contracts/deployments/<network>.json`)

### Tasks

- Initialize NestJS app in `backend/`.
- Create modules: `policies`, `pricing`, `blockchain`, `auth`, `health`.
- Configure validation pipes and exception filters.
- Add structured logging and environment config module.
- Define DTOs and response contracts.
- Add startup validation for required ABI/manifests and fail-fast boot behavior on invalid integration metadata.
- Add readiness endpoint that validates critical runtime dependencies expected at this stage.
- Add Stage 05 gate command covering build, lint, tests, and startup checks.

### Acceptance Criteria

- Service boots in local environment with health endpoint.
- Validation rejects malformed payloads.
- Readiness checks verify configured dependencies and fail with actionable diagnostics when misconfigured.
- Backend runtime can load and parse shared ABI/deployment metadata without manual edits.
- Stage 05 gate command passes locally and in CI (when backend CI is enabled).

### Risks

- Contract drift between DTOs and actual on-chain requirements.

### Exit Deliverables

- Stable backend skeleton with module boundaries.

## Stage 06 - Backend to Blockchain Integration

### Objective

Enable backend to create and query policies via smart contracts.

### Inputs

- Deployed contract addresses and ABI artifacts

### Tasks

- Create blockchain adapter service using ethers.
- Load ABI/address per environment.
- Implement policy creation and status query methods.
- Add retry/error mapping strategy for RPC failures.
- Add startup-time validation that required contracts exist at configured addresses on target network.
- Add transaction observability (request id, tx hash, network, block number, revert reason mapping).
- Ensure runtime profile uses real RPC endpoints for dev/staging/testnet/prod (no mocked blockchain client outside tests).

### Acceptance Criteria

- Backend can create a policy and return transaction metadata.
- Backend can query and normalize policy state.
- Integration is validated against real deployed contracts on at least one non-local environment.
- Reverted transactions are mapped to explicit API error contracts.
- No mocked chain adapter is used in runtime application profiles.

### Risks

- Inconsistent chain state across environments.
- Poor handling of reverted transactions.

### Exit Deliverables

- Production-shaped blockchain client in backend.

## Stage 07 - ML Service Foundation

### Objective

Stand up a production-oriented pricing inference API with deterministic interfaces and real model loading behavior.

### Inputs

- Pricing contract requirements from backend

### Tasks

- Initialize FastAPI app in `ml-service/`.
- Implement `/health` and `/predict` endpoints.
- Add request/response schemas.
- Add baseline pricing strategy and deterministic fallback behavior.
- Implement model-loading lifecycle and fail-fast startup when the required model artifact is missing.
- Add readiness check that validates model availability and dependency health.
- Add Stage 07 gate command covering lint, tests, and runtime startup checks.

### Acceptance Criteria

- API returns predictable JSON schema.
- Invalid payloads are rejected with clear messages.
- Runtime `/predict` path uses a real model artifact, not hardcoded mock responses.
- Service readiness reflects true model availability status.

### Risks

- Tight coupling to backend DTO version.
- Unstable prediction output formats.

### Exit Deliverables

- Running ML service with baseline inference endpoint.

## Stage 08 - Data Pipeline and Model Training

### Objective

Implement repeatable model training from climate historical data.

### Inputs

- Data sources and region definitions

### Tasks

- Build ETL scripts for weather datasets.
- Clean and normalize data.
- Train baseline forecasting model.
- Evaluate with time-based validation.
- Serialize model artifact with version tag.
- Record data provenance metadata and training configuration hashes for reproducibility and auditability.
- Define dataset and model versioning contract consumed by backend/ML runtime.

### Acceptance Criteria

- Training process is reproducible from scripts.
- Metrics are documented and comparable.
- Model artifact metadata is sufficient for traceability (data version, feature schema, training commit/config).
- Produced artifact is directly loadable by Stage 07 runtime without manual patching.

### Risks

- Data quality inconsistencies.
- Model drift across regions.

### Exit Deliverables

- Versioned model artifact and training notes.

## Stage 09 - Backend to ML Integration

### Objective

Connect quote flow to ML prediction service reliably.

### Inputs

- Backend module contracts
- ML API endpoints

### Tasks

- Add pricing service client in backend.
- Configure timeouts, retry policy, and fallback mode.
- Map prediction output to policy quote DTO.
- Add telemetry for latency and failures.
- Enforce schema-contract validation between backend DTOs and ML request/response schemas.
- Ensure runtime profile calls a real running ML service endpoint for dev/staging/testnet/prod (no mock prediction service outside tests).

### Acceptance Criteria

- Quote endpoint works end-to-end with ML service.
- Failures degrade gracefully with explicit error handling.
- Integration tests verify real network calls between backend and ML service under normal and degraded conditions.
- No mocked prediction responses are used in runtime application profiles.

### Risks

- Network instability causing cascading failures.
- Incompatible schema versions between services.

### Exit Deliverables

- Stable quote integration path.

## Stage 10 - Oracle and Automation Integration

### Objective

Wire climate data updates to policy state transitions.

### Inputs

- Chainlink integration strategy
- Weather data provider specs

### Tasks

- Implement request/fulfill integration paths.
- Configure per-environment oracle metadata.
- Define update schedule and timeout strategy.
- Add sanity bounds for anomalous weather data.
- Validate full callback path on testnet with real oracle configuration and external weather source adapter.
- Add operational safeguards for delayed/missing callbacks (timeouts, alerting hooks, replay protection checks).

### Acceptance Criteria

- Local simulation exists only for deterministic tests; release validation uses real oracle flow on testnet.
- Policy conditions update correctly after real callbacks and are observable through backend/indexer read paths.
- Oracle integration runbook documents setup, failure modes, and recovery actions.

### Risks

- Incorrect parser path for weather API payloads.
- Oracle job misconfiguration in testnet.

### Exit Deliverables

- Documented oracle integration with tested callback paths.

## Stage 11 - Optional Off-Chain Persistence

### Objective

Persist derived operational data for admin/reporting needs.

### Inputs

- Reporting and audit requirements

### Tasks

- Add PostgreSQL schema for users/policies/claims (derived data).
- Implement sync/index strategy from chain events.
- Add repository layer and admin query endpoints.

### Acceptance Criteria

- Off-chain records are traceable to chain events.
- No source-of-truth conflict with on-chain state.

### Risks

- Data divergence between event indexer and API reads.

### Exit Deliverables

- Read models for operations and analytics.

## Stage 12 - Containerization and Local Orchestration

### Objective

Make local startup reproducible for all services.

### Inputs

- Working contracts/backend/ml-service modules

### Tasks

- Create Dockerfiles for backend and ml-service.
- Create compose stacks for local and test profiles.
- Validate build contexts and startup dependencies.

### Acceptance Criteria

- One command starts full local stack.
- Containers pass health checks.

### Risks

- Oversized images due to incorrect ignore patterns.
- Startup race conditions.

### Exit Deliverables

- Reliable local container stack.

## Stage 13 - Security and Observability Hardening

### Objective

Increase operational resilience and reduce exploitable surfaces.

### Inputs

- Running integration stack

### Tasks

- Add centralized structured logging.
- Add health/readiness endpoints and uptime checks.
- Validate env handling and secret loading.
- Add abuse controls and payload sanitization.

### Acceptance Criteria

- Critical paths are observable.
- Security controls exist for sensitive operations.

### Risks

- Logging sensitive data accidentally.
- Missing operational alerts.

### Exit Deliverables

- Hardened baseline for staging/testnet.

## Stage 14 - End-to-End Integration Tests

### Objective

Validate real workflow from quote to payout trigger paths.

### Inputs

- Integrated backend, contracts, and ML service

### Tasks

- Create end-to-end test harness.
- Simulate quote, policy creation, oracle update, and payout eligibility.
- Validate API responses and on-chain state at each step.

### Acceptance Criteria

- End-to-end test suite passes consistently.
- Failures provide actionable diagnostics.

### Risks

- Flaky tests from asynchronous blockchain timing.

### Exit Deliverables

- Stable integration test flows in CI-ready format.

## Stage 15 - CI/CD Pipeline

### Objective

Automate quality checks and ensure repeatable build/test execution.

### Inputs

- Test suites and Docker assets

### Tasks

- Add workflows for contracts, backend, and Python tests.
- Add lint checks and optional security scans.
- Build Docker images in CI.
- Publish test reports and artifacts.

### Acceptance Criteria

- Every push triggers reliable validation workflow.
- Pipeline failures identify root module quickly.

### Risks

- Slow pipelines reducing iteration speed.
- Environment drift between local and CI.

### Exit Deliverables

- CI pipeline with enforceable quality gates.

## Stage 16 - Testnet Release and Operational Handoff

### Objective

Deploy safely to testnet and document operational ownership.

### Inputs

- Green CI and validated integration tests

### Tasks

- Deploy contracts to target testnet.
- Configure backend and oracle environment variables.
- Execute smoke tests on deployed stack.
- Record addresses, job IDs, and runbook notes.

### Acceptance Criteria

- Core user flow runs in testnet.
- Deployment metadata is documented and traceable.

### Risks

- Misconfigured external services (RPC/oracle/weather API).
- Incomplete runbooks for incident handling.

### Exit Deliverables

- Testnet deployment documentation and support handoff.

## 5. Global Execution Order

1. Stage 01 to Stage 04 (on-chain baseline + tests)
2. Stage 05 to Stage 07 (service foundations)
3. Stage 08 to Stage 10 (pricing + oracle integration)
4. Stage 11 to Stage 14 (persistence, containers, hardening, E2E)
5. Stage 15 to Stage 16 (CI/CD and testnet rollout)

This sequence minimizes rework by stabilizing core domain behavior first, then integrations, then deployment operations.

## 6. Stage Report Template

Use this template for every completed stage report file.

```md
# Stage XX - <Name>

## Scope completed

- Objective achieved:
- Purpose and value:
- Functional result:
- Integrated previous-stage outputs:
- Runtime data sources (real vs test-only):
-

## Files changed

-

## Decisions made

-

## Commands executed

-

## Tests executed and results

-

## Risks or pending items

-
- Production blockers and owner:

## Credentials status

- Credentials required now:
- Credentials list:
- Purpose:

## Next stage handoff notes

-
```
