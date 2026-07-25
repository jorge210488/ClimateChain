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
- `npm run test:e2e`: passed — 20 passing (liveness/readiness, deployment
  metadata, Swagger `/docs` + `/docs-json`, policy validation 400 + whitelist +
  semantic rejections + 501, address-pipe 400, pricing validation 400 + 501,
  auth 401/403 and full admin token flow, error-contract shape).
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

## Post-review hardening (findings applied)

A follow-up code review raised six findings; all were valid and applied:

- F1 (high): `CreatePolicyDto` now enforces the on-chain semantic rules it
  documented but did not validate — minimum premium relative to coverage
  (`coverage * MIN_PREMIUM_BPS / 10000`, ceil-rounded to match the contract) via
  `@IsAtLeastMinPremium`, and minimum start lead time via `@IsAfterMinLeadTime`.
  This rejects requests that would otherwise certainly revert in Stage 06.
- F2 (high): `region` is validated by UTF-8 byte length (`@MaxByteLength`)
  instead of `@MaxLength` (UTF-16 code units), matching what fits in `bytes32`.
- F3 (medium): `startup-check` and the e2e suite now boot through the real
  bootstrap (`configureApp` + `setupSwagger`), so the pino logger, CORS,
  shutdown hooks, and Swagger (`/docs`, `/docs-json`) are exercised by the gate.
- F4 (medium): `stage5:check` now runs `api:check` (cross-platform OpenAPI drift
  check), making the local gate equivalent to CI; the redundant CI drift step
  was removed.
- F5 (medium-low): `/health/ready` exposes minimal detail on deployed profiles
  (status only) and full posture only locally, reducing anonymous recon surface.
  Full security hardening remains Stage 13.
- F6 (low): removed the deprecated `baseUrl` and the unused `src/*` path alias
  from `tsconfig.json` (and matching jest mappers).

New negative tests cover: premium below minimum, `requestedStartTimestamp`
inside the lead-time window (plus an accepted future timestamp), multibyte
`region` exceeding 31 UTF-8 bytes, and `/docs` + `/docs-json` availability.

New/changed files: `common/validation/max-byte-length.validator.ts`,
`modules/policies/validators/min-premium.validator.ts`,
`modules/policies/validators/min-lead-time.validator.ts`,
`scripts/check-openapi.ts`, `common/utils/eth-amount.util.ts` (wei parser),
plus updates to `create-policy.dto.ts`, the health indicators, `app-setup.ts`,
`startup-check.ts`, `export-openapi.ts`, the e2e suite, `tsconfig.json`,
`package.json`, and `backend-quality-gates.yml`.

## Post-review hardening, round 2 (pre-Stage 06)

A second review, run before starting Stage 06, raised findings whose cost rises
sharply once the live chain client exists. The configuration, abuse-control, and
lead-time items were applied; the rest are carried into the handoff below.

- H1 (high): `RPC_URL` is now required at boot for deployed profiles
  (`env.validation.ts`) instead of only being reported as a readiness failure.
  The previous behavior contradicted the stage's own fail-fast principle: a
  staging/production process would start, answer `GET /health` with 200, and
  serve traffic while structurally unable to reach a chain. The readiness
  indicator keeps its check as defense in depth.
- H2 (high): `ADMIN_API_KEY` now requires 32 characters minimum and
  `POST /auth/token` is rate limited per client address (`@nestjs/throttler`,
  configurable via `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_TTL_SECONDS`).
  Together these close a brute-force path that was open from the moment the
  endpoint shipped: the key was the sole credential guarding JWT issuance, had
  no strength requirement, and could be guessed without limit. The limiter is
  scoped to the auth module; blanket throttling remains a Stage 13 decision.
- H3 (high): `IsAfterMinLeadTime` now requires the on-chain minimum plus a
  120-second margin (`POLICY_DOMAIN.startLeadTimeSafetyMarginSeconds`). The
  validator compares against wall-clock time at request time while the contract
  compares against `block.timestamp` at mining time, so a request accepted at
  exactly the on-chain minimum was guaranteed to revert. This would have
  surfaced in Stage 06 as intermittent, hard-to-diagnose reverts.
- H4 (medium): `PRIVATE_KEY` is format-validated (`0x` + 64 hex) at boot, so a
  malformed signer key fails at startup rather than on the first Stage 06
  transaction.
- H5 (medium): `configuration.ts` now asserts deployed-profile invariants
  directly (no local JWT placeholder, RPC endpoint present). The factory
  resolves its own defaults independently of the Joi schema, so this removes a
  latent path where a deployed profile could boot on development credentials if
  schema validation were ever bypassed.

New/changed files: `config/configuration.spec.ts`,
`modules/policies/validators/min-lead-time.validator.spec.ts`, plus updates to
`config/env.validation.ts`, `config/config.defaults.ts`, `config/config.types.ts`,
`config/configuration.ts`, `config/env.validation.spec.ts`,
`modules/auth/auth.module.ts`, `modules/auth/auth.controller.ts`,
`modules/auth/auth.service.spec.ts`, `modules/health/indicators/config.health.ts`,
`modules/policies/policy.constants.ts`,
`modules/policies/validators/min-lead-time.validator.ts`,
`modules/policies/dto/create-policy.dto.ts`, `test/app.e2e-spec.ts`,
`.env.example`, `README.md`, `package.json`, and `docs/api/backend-openapi.json`.

New tests cover: `RPC_URL` required/optional per profile, `PRIVATE_KEY` format,
`ADMIN_API_KEY` strength, rate-limit defaults, the deployed-profile boot
invariants, the lead-time margin, and a `429` on repeated token-issuance
attempts.

Gate after round 2: `npm run stage5:check` passes — 39 unit tests (7 suites) and
25 e2e tests, up from 19 and 24.

## Post-review hardening, round 3 (pre-Stage 06)

The remaining findings from the round 2 review were applied, plus one defect
they uncovered.

### Authorization

- H6 (high): `POST /policies` now requires an authenticated principal; the read
  paths stay public. From Stage 06 creation submits a transaction and draws down
  the provider's coverage reserve, so an anonymous caller could have drained it.
  Reads project world-readable chain state, so gating them would add friction
  without adding confidentiality. Which identities may create a policy, and on
  whose behalf, is refined in Stage 06 and Stage 11; requiring a valid principal
  is the floor, not the final model.

### Contract fidelity

- H7 (high): added source-level drift detection for the mirrored on-chain
  values (`policy.constants.spec.ts`, `policy-settlement.enum.spec.ts`). The
  specs parse `InsuranceProvider.sol` / `InsurancePolicy.sol` and assert that
  `MAX_DURATION_DAYS`, `MIN_PREMIUM_BPS`, `BASIS_POINTS_DENOMINATOR`,
  `MIN_POLICY_START_LEAD_TIME_SECONDS`, and both enum orderings still match.
  The Stage 04 ABI drift gate cannot cover this: an ABI carries neither
  constant values nor enum ordering. This is a source-level guard and does not
  replace the on-chain verification Stage 06 should add once a live client can
  call the public getters — it just catches drift earlier and without a node.
- H8 (medium): `PolicyResponseDto` now exposes `pendingPayoutWei`,
  `lastOracleUpdateTimestamp`, `oracle`, `settlementType`, and `settledAt`. The
  contract settles payouts pull-style (`claimPendingPayout()`), so without
  `pendingPayoutWei` an insured party had no way to learn that money was waiting
  to be claimed — the API contract was describing an incomplete user flow.
  `PolicySettlementType` mirrors the provider's `SettlementType` enum.
- H9 (medium): EVM addresses are normalized at the boundary
  (`normalizeEvmAddress`, applied in `ParseEvmAddressPipe` and the `insured`
  filter) and validated through one shared `@IsEvmAddress` decorator instead of
  a re-implemented regex. Addresses are case-insensitive, so Stage 06 lookups
  would otherwise miss on capitalization alone. Checksum *output* needs keccak
  and arrives with ethers in Stage 06.

### HTTP surface

- H10 (medium): helmet security headers, an explicit request-body cap
  (`MAX_REQUEST_BODY_SIZE`, default 64kb), a CORS origin allowlist
  (`CORS_ORIGINS`, required for deployed profiles), and Swagger mounting that is
  opt-in on deployed profiles (`SWAGGER_ENABLED`). Docs are mounted outside the
  guard chain, so they were anonymously enumerable in production; disabling the
  mount costs nothing offline because `api:export`/`api:check` build the
  document without mounting it.
- H11 (medium, defect found while testing H10): the global exception filter
  collapsed every non-`HttpException` to 500. Errors raised by middleware below
  Nest — body-parser and anything else built on `http-errors` — carry their own
  status, so an oversized body was reported as a server fault instead of 413,
  and logged at error level with a stack. The filter now honors an
  `http-errors`-style status (bounded to 4xx/5xx so an incidental `status`
  field is not mistaken for one) and picks log severity from the resolved
  status. Covered by a new `all-exceptions.filter.spec.ts`.
- H12 (medium, same investigation): `MAX_REQUEST_BODY_SIZE` was inert as first
  written. Nest registers its own body parser at its default limit, which
  consumes the body before any parser added later can see it, so the configured
  value did nothing. Entry points now share `HTTP_APP_OPTIONS`
  (`bodyParser: false`) and register the parsers in `configureApp`, which is
  what makes the setting authoritative.

### Gate

- H13 (medium): coverage thresholds now run in the gate, measured over the unit
  and e2e suites together (`jest.coverage.js`). Measuring units alone would have
  understated reality and rewarded redundant tests for layers the e2e suite
  already covers. Current: 95.2% statements, 86.2% branches, 94.2% functions.
- H14 (medium): migrated both suites from `ts-jest` to `@swc/jest`. Unit runtime
  fell from ~90s to ~16s, and the "worker process has failed to exit gracefully"
  leak warning disappeared with it. Coverage uses the `v8` provider: under
  istanbul, swc's decorator-metadata emit is charged to the decorator lines and
  reports ~54% branches on fully-tested files.
- H15 (low): `npm audit --audit-level=critical` blocks in the gate; a
  high-severity report runs non-blocking in CI. All 9 current advisories are
  transitive through NestJS 11's own dependencies (multer, js-yaml, form-data,
  body-parser, brace-expansion, fast-uri) with no fixed release available, so a
  blocking `high` gate would sit permanently red and train people to ignore it.
  `npm audit fix` was evaluated and rejected: it resolved nothing and inflated
  the count from 9 to 28 by installing nested duplicates.
- H16 (low): CI workflows declare `permissions: contents: read`, cancel
  superseded runs via `concurrency`, and carry job timeouts. Node is pinned
  consistently through `engines` and a repository `.nvmrc`.

### Stage 06 entry conditions (prepared and verified)

- A reachable chain now exists as a committed artifact:
  `contracts/deployments/localhost.json`, produced by `npx hardhat node` plus
  `npm run deploy:localhost`. Previously the only manifest was `hardhat.json`,
  whose addresses belong to the in-process network and are unreachable over RPC
  — Stage 06 had nothing real to connect to. Addresses are deterministic (fresh
  node, deployer at nonce 0), so the committed manifest reproduces exactly.
- Verified end to end: the backend boots with `BLOCKCHAIN_NETWORK=localhost` and
  `RPC_URL=http://127.0.0.1:8545`, `/health/ready` returns 200, and
  `/blockchain/deployment` reports the live provider and oracle addresses.
  Independently, `eth_getCode` returns real bytecode at both
  (`InsuranceProvider` 15037 bytes, `MockWeatherOracle` 2876 bytes), confirming
  the manifest describes deployed code rather than merely parsing.
- `docs/runbooks/local-stack.md` documents the procedure, expected output, and
  seven failure modes. The two boot-abort paths in it were executed to confirm
  the exact diagnostics: a network with no manifest, and a `CHAIN_ID` that
  disagrees with the manifest.
- Remaining Stage 06 work on this seam: readiness still validates only that the
  metadata is well-formed, not that code exists at those addresses. The
  `eth_getCode` check moves into the readiness aggregate once the live client
  exists — that is Stage 06's own deliverable, not a Stage 05 gap.
- The provider's coverage reserve is empty after a fresh deploy, so
  `createPolicy` reverts with `InsufficientCoverageReserve` until funded. Stage
  06 must fund it (or handle the revert explicitly) before the creation path can
  succeed.

### Still open (owned by later stages)

- `trust proxy` is not configured, so behind a load balancer the auth rate
  limiter keys on the proxy and all traffic shares one bucket. Deferred to
  Stage 12/13, when the deployment topology exists.
- Repository branch protection still needs both gate jobs marked as required;
  until then the gates are informative rather than blocking. This is a
  repository-settings change and cannot be made from the codebase.
- `ml-service/` remains scaffolding (Stage 07); `infra/docker` and
  `infra/compose` are empty placeholders (Stage 12).

Gate after round 3: `npm run stage5:check` passes — 85 unit tests (11 suites),
32 e2e tests, 117 under the combined coverage run.
