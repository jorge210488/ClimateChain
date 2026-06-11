# Stage 05 - Backend Foundation (NestJS)

## Scope completed

- Objective achieved: Established a production-oriented NestJS API foundation in
  `backend/` with modular boundaries (`policies`, `pricing`, `blockchain`,
  `auth`, `health`), runtime validation, structured logging, typed
  configuration, and direct, fail-fast loading of the Stage 04 on-chain
  artifacts.
- Purpose and value: Provides the stable, observable, security-aware service
  skeleton that later stages extend, while enforcing the project guardrails
  (no runtime mocks, fail-fast on misconfiguration, one reproducible stage
  gate). It makes downstream integration (Stage 06 chain, Stage 09 ML) additive
  rather than structural.
- Functional result: The service boots locally, serves liveness (`GET /health`)
  and readiness (`GET /health/ready`) probes, exposes loaded deployment metadata
  (`GET /blockchain/deployment`), validates and rejects malformed payloads
  (HTTP 400), issues and verifies administrative JWTs, and returns explicit
  HTTP 501 for operations whose live integration lands in later stages. The
  Stage 05 gate (`npm run stage5:check`) passes end-to-end.
- Integrated previous-stage outputs: Consumes `shared/abi/index.json` plus the
  `InsuranceProvider` and `InsurancePolicy` ABIs, and the per-network deployment
  manifest `contracts/deployments/hardhat.json` (network, chainId `31337`,
  `insuranceProvider` address). The on-chain `PolicyStatus` enum order and the
  `InsuranceProvider` domain constants (`MAX_DURATION_DAYS=365`,
  `MIN_PREMIUM_BPS=100`) are mirrored for status mapping and DTO validation.
- Runtime data sources (real vs test-only): Real — shared ABI bundle and
  deployment manifest are read and validated from disk at boot for every
  profile. Test-only — unit/e2e tests construct stubs and sign test JWTs; no
  mock data is used on any runtime application path.
- Live chain RPC and ML calls are intentionally out of Stage 05 scope (Stage 06
  and Stage 09); chain/ML-dependent endpoints respond with HTTP 501 rather than
  mock data, honoring the no-runtime-mocks policy.

## Files changed

- `backend/package.json`, `backend/package-lock.json` — NestJS 11 toolchain,
  dependencies, Jest config, and scripts (incl. `stage5:check`).
- `backend/tsconfig.json`, `backend/tsconfig.build.json`, `backend/nest-cli.json`
  — TypeScript and Nest build configuration.
- `backend/eslint.config.mjs`, `backend/.prettierrc.json`,
  `backend/.prettierignore` — lint/format quality gates.
- `backend/src/main.ts` — real bootstrap (pino logger, Swagger, shutdown hooks,
  fail-fast error handling).
- `backend/src/app.module.ts`, `backend/src/app-setup.ts` — root module with
  global validation pipe, exception filter, and JWT + roles guards; shared
  runtime/Swagger setup.
- `backend/src/config/*` — `config.defaults.ts`, `config.types.ts`,
  `env.validation.ts` (Joi), `configuration.ts`, `app-config.service.ts`,
  `config.module.ts`.
- `backend/src/logging/logger.module.ts` — structured pino logging with
  request-id correlation and secret redaction.
- `backend/src/common/*` — `constants.ts`, `decorators/` (`@Public`, `@Roles`),
  `dto/` (error, pagination response contracts), `filters/all-exceptions.filter.ts`,
  `pipes/parse-evm-address.pipe.ts`, `utils/` (evm-address, eth-amount).
- `backend/src/modules/blockchain/*` — `contract-registry.service.ts` (+ types,
  spec), `blockchain.controller.ts`, `dto/deployment-info.dto.ts`,
  `blockchain.module.ts`.
- `backend/src/modules/health/*` — `health.controller.ts`, config + contract
  registry readiness indicators, `health.module.ts`.
- `backend/src/modules/auth/*` — JWT strategy, guards (jwt + roles), token
  service (+ spec), controller, DTOs, `current-user.decorator.ts`,
  `auth.module.ts`.
- `backend/src/modules/policies/*` — DTOs, `policy-status.enum.ts` (+ spec),
  `policy.constants.ts`, controller, service, module.
- `backend/src/modules/pricing/*` — DTOs, controller, service, module.
- `backend/scripts/startup-check.ts`, `backend/scripts/export-openapi.ts` —
  startup smoke check and OpenAPI exporter.
- `backend/test/app.e2e-spec.ts`, `backend/test/jest-e2e.json` — e2e suite.
- `backend/.env.example`, `backend/README.md` — updated configuration and module
  documentation.
- `docs/api/backend-openapi.json` — committed OpenAPI snapshot.
- `.github/workflows/backend-quality-gates.yml` — backend CI gate + OpenAPI
  drift check.
- `README.md` — stage status (Stage 05 completed, Stage 06 next) and backend
  quick start.
- `docs/stage-reports/stage-05-backend-foundation.md` — this report.

## Decisions made

- Loaded and validated `shared/abi` + deployment manifest at boot via a
  `ContractRegistryService` that fails fast on any missing/malformed/inconsistent
  artifact; this is the critical runtime dependency owned by Stage 05. Live
  ethers/RPC usage is deferred to Stage 06 to keep stage boundaries clean and
  avoid mock chain clients.
- Returned HTTP 501 (`NotImplementedException`) for chain-dependent
  (Stage 06) and ML-dependent (Stage 09) operations instead of mock data, so
  validation and contracts are real now while integration remains additive.
- Chose `nestjs-pino` for structured JSON logging with request-id correlation
  and redaction. `Guide.md` mentions Winston only as an example ("por ejemplo");
  pino better fits the structured-logging requirement and Stage 13 hardening.
- Enforced configuration with a fail-fast Joi schema; deployed profiles
  (staging/testnet/production) require real secrets, while local/dev/test use
  safe defaults to keep onboarding credential-free.
- Registered the validation pipe, exception filter, and JWT + roles guards
  globally via `APP_PIPE`/`APP_FILTER`/`APP_GUARD` so protection and the error
  contract apply uniformly, including under test.
- Gated administrative token issuance behind `ADMIN_API_KEY` (constant-time
  comparison); the endpoint is disabled when unset, avoiding mandatory local
  credentials. A persistent user store is deferred to the optional Stage 11.
- Mirrored the contracts module conventions: a single canonical stage gate
  (`stage5:check`), a CI workflow, and a committed integration artifact
  (`docs/api/backend-openapi.json`) with a drift check analogous to ABI drift.
- Treated empty `.env` values as absent (`.empty("")`) so real `.env` files
  resolve defaults instead of failing validation, while deployed profiles still
  require real secrets; bootstrap writes fail-fast errors to stderr so silent
  startup failures cannot occur even with log buffering enabled.

## Commands executed

- `cd backend && npm install`
- `cd backend && npm run build`
- `cd backend && npm run format:write`
- `cd backend && npm run lint`
- `cd backend && npm test`
- `cd backend && npm run test:e2e`
- `cd backend && npm run start:check`
- `cd backend && npm run api:export`
- `cd backend && npm run stage5:check`

## Tests executed and results

- `npm test` (unit): passed — 14 passing across 4 suites (contract registry
  load + fail-fast cases, auth token issuance, policy status mapping,
  environment validation incl. empty-`.env` and deployed-profile cases).
- `npm run test:e2e`: passed — 14 passing (liveness/readiness, deployment
  metadata, policy validation 400 + whitelist + 501, address-pipe 400,
  pricing validation 400 + 501, auth 401/403 and full admin token flow,
  error-contract shape).
- `npm run build`: passed (clean TypeScript compile).
- `npm run lint`: passed (ESLint, max-warnings 0).
- `npm run format:check`: passed (Prettier).
- `npm run start:check`: passed — booted and probed `/health`,
  `/health/ready`, `/blockchain/deployment` (all HTTP 200), exit code 0.
- `npm run stage5:check`: passed end-to-end (build + lint + format + unit +
  e2e + startup).
- Live server verification (`node dist/main.js` on port 3000, real HTTP):
  - Booted with the actual `.env`; structured logs confirm "Contract registry
    ready" and "listening on port 3000".
  - `GET /health` 200; `GET /health/ready` 200 (config + contract-registry up);
    `GET /blockchain/deployment` 200 with provider + oracle addresses.
  - `POST /policies` invalid 400 (full error contract + `requestId`), valid 501;
    `POST /pricing/quote` valid 501; `GET /policies/<bad>` 400.
  - Auth: `/auth/me` 401 without token, `POST /auth/token` issues a JWT, `/auth/me`
    200 with `{ userId: admin, roles: [admin] }`, wrong key 401; `/docs` 200.
  - Fail-fast verified: invalid `BLOCKCHAIN_NETWORK` aborts boot (exit 1) with an
    actionable stderr diagnostic naming the missing manifest.

Two defects were found and fixed during live verification (they were masked by
`NODE_ENV=test` ignoring the `.env` file in automated tests):

- Empty `.env` values (e.g. `JWT_SECRET=`) bypassed Joi `.default()` and aborted
  boot. Fixed with `.empty("")` on defaulted fields; covered by a new
  `env.validation.spec.ts` regression suite.
- `bufferLogs: true` discarded fail-fast boot diagnostics, producing a silent
  exit. Bootstrap now writes the failure to stderr directly so the diagnostic is
  always visible.

## Risks or pending items

- Policy/pricing data operations are intentionally HTTP 501 until Stage 06/09;
  these are stage-scoped boundaries, not defects.
- Readiness validates configuration and on-chain metadata only; live RPC
  liveness (Stage 06) and ML liveness (Stage 09) are added to the readiness
  aggregate in their stages.
- The domain constants mirrored from `InsuranceProvider` should be cross-checked
  against on-chain public constants once the live client exists (Stage 06).
- Stage 13 will harden security/observability further (rate limiting, payload
  sanitization, centralized logging tuning); Stage 05 ships the foundation.
- CI workflow is added; repository branch protection still needs to mark the
  `backend-stage5-gates` job as required in repository settings.
- Production blockers and owner: None for Stage 05 (foundation). Live
  integration readiness is owned by Stage 06 (chain) and Stage 09 (ML).

## Credentials status

- Credentials required now: No.
- Credentials list: None required for local build/test/startup. Optional:
  `JWT_SECRET` (real value required only for deployed profiles),
  `ADMIN_API_KEY` (optional; enables admin token issuance when set).
- Purpose: `JWT_SECRET` signs/verifies administrative JWTs; `ADMIN_API_KEY`
  authorizes issuance of an administrative JWT. `RPC_URL`/`PRIVATE_KEY` remain
  deferred to Stage 06.

## Next stage handoff notes

- Stage 06 builds the live ethers client inside `BlockchainModule` from the
  exported `ContractRegistryService` (ABIs + provider address) and replaces the
  policy HTTP 501 paths with real creation/read flows plus transaction
  observability and revert mapping.
- Set `RPC_URL`, `PRIVATE_KEY`, and (for non-hardhat networks) `CHAIN_ID` /
  `BLOCKCHAIN_NETWORK`; add an RPC liveness indicator to `/health/ready`.
- Keep `npm run stage5:check` green and extend it; do not bypass the validation,
  exception-contract, or fail-fast boot guarantees.
- Regenerate `docs/api/backend-openapi.json` (`npm run api:export`) whenever
  controllers/DTOs change to keep the OpenAPI drift gate green.
