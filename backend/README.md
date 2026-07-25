# Backend Module (NestJS)

Production-oriented API foundation that coordinates policy lifecycle, premium
pricing, and on-chain integration. Built with NestJS 11 and TypeScript.

## Architecture

```text
src/
  main.ts                 # Bootstrap (pino logger, Swagger, shutdown hooks)
  app.module.ts           # Root module + global pipe/filter/guards
  app-setup.ts            # Shared runtime + Swagger configuration
  config/                 # Typed config, Joi env validation, AppConfigService
  logging/                # Structured pino logging (request-id, redaction)
  common/                 # Exception filter, response contracts, pipes, decorators
  modules/
    blockchain/           # Contract registry: loads shared ABIs + deployment manifest
    health/               # Liveness + readiness probes (terminus)
    auth/                 # JWT auth, roles, admin token issuance
    policies/             # Policy lifecycle DTOs + endpoints
    pricing/              # Premium quote DTOs + endpoints
```

## Endpoints

| Method | Path                     | Auth   | Notes                                            |
| ------ | ------------------------ | ------ | ------------------------------------------------ |
| GET    | `/health`                | public | Liveness probe                                   |
| GET    | `/health/ready`          | public | Readiness (config + on-chain metadata)           |
| GET    | `/blockchain/deployment` | public | Loaded network, addresses, contract ABIs         |
| POST   | `/auth/token`            | public | Exchange `ADMIN_API_KEY` for a JWT (when enabled); rate limited |
| GET    | `/auth/me`               | admin  | Authenticated principal                          |
| POST   | `/policies`              | bearer | Create policy (live execution: Stage 06 → 501)   |
| GET    | `/policies`              | public | List policies (live reads: Stage 06 → 501)       |
| GET    | `/policies/:address`     | public | Get policy (live reads: Stage 06 → 501)          |
| POST   | `/pricing/quote`         | public | Premium quote (live ML: Stage 09 → 501)          |

Reads are public because on-chain state is world-readable; creation requires a
bearer token because, from Stage 06, it submits a transaction and draws on the
provider's coverage reserve. Which identities may create a policy, and on whose
behalf, is refined in Stage 06 and Stage 11.

Interactive API docs are served at `/docs` on local profiles and are opt-in on
deployed ones (`SWAGGER_ENABLED`). A committed OpenAPI snapshot lives at
`docs/api/backend-openapi.json` (regenerate with `npm run api:export`).

### Stage boundaries

Stage 05 delivers the foundation: modules, validation, structured logging,
configuration, and real loading of the Stage 04 artifacts (shared ABIs +
deployment manifest). Operations that require a live chain or ML connection
respond with HTTP `501` until their integration stage, instead of returning mock
data (per the no-runtime-mocks policy):

- Policy creation/reads → Stage 06 (Backend to Blockchain Integration)
- Premium quoting → Stage 09 (Backend to ML Integration)

## Standards

- TypeScript identifiers and DTOs in English.
- Validation-first request handling (`whitelist` + reject unknown + transform).
- Canonical error response contract via a global exception filter, including for
  errors raised by middleware below Nest (e.g. an oversized body is a 413, not
  a 500).
- Fail-fast boot: invalid config or unreadable ABI/manifest aborts startup.
- Security headers via helmet, an explicit request body cap, and an origin
  allowlist that deployed profiles must declare.

## Configuration

Copy `.env.example` to `.env`. The environment is validated at boot with a Joi
schema; defaults cover local/dev/test. See `.env.example` for the full list.

Deployed profiles (staging/testnet/production) fail to boot unless they supply:

- `JWT_SECRET` — a real secret, minimum 16 characters. The insecure local
  placeholder is rejected outright for these profiles.
- `RPC_URL` — a real JSON-RPC endpoint. Enforced at boot rather than only
  surfacing as a readiness failure once the process is already serving traffic.
- `CORS_ORIGINS` — an explicit origin allowlist. Local profiles may leave it
  empty (reflect any origin); deployed profiles may not.

Credential-shaped values are format-checked wherever a malformed value would
otherwise fail later, on the first transaction instead of at startup:

- `PRIVATE_KEY` — must be a `0x`-prefixed 32-byte hex string when set. Whether a
  backend-held signer is required at all is a Stage 06 decision.
- `ADMIN_API_KEY` — optional (unset disables `POST /auth/token`), but minimum 32
  characters when set: it is the only credential guarding JWT issuance. That
  endpoint is additionally rate limited per client address via
  `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_TTL_SECONDS`.

> **Operational note:** the rate limiter keys on the client address reported by
> Express. Behind a reverse proxy or load balancer, enable `trust proxy` so it
> keys on the real client rather than the proxy, otherwise all traffic shares one
> bucket. Deferred to Stage 12/13, when the deployment topology is defined.

### Working-directory convention (operational)

> **Run all backend processes from the `backend/` package directory.**

The shared-ABI and deployment-manifest paths default to locations resolved
**relative to the current working directory** (`SHARED_ABI_DIR=../shared/abi`,
`CONTRACTS_DEPLOYMENTS_DIR=../contracts/deployments`), as do the OpenAPI
export/check scripts (`../docs/api`). The `npm run` scripts always set the
working directory to `backend/`, so this holds for normal usage. If a process is
launched from elsewhere (e.g. `node dist/main.js` from the repo root, or a
container with a different `WORKDIR`), set those two env vars to **absolute
paths** instead of relying on the defaults.

> **Known tech debt:** path resolution is anchored to `process.cwd()` rather than
> the module location. This is intentional for Stage 05 (it matches the NestJS
> `ConfigModule` convention and keeps `src`/`dist` resolution simple) but should
> be revisited if the launch directory ever becomes non-deterministic.

## Commands

```bash
npm install            # install dependencies
npm run start:dev      # run with watch mode
npm run build          # compile to dist/
npm run lint           # ESLint (max-warnings 0)
npm run format:check   # Prettier check
npm test               # unit tests
npm run test:e2e       # end-to-end tests
npm run test:cov       # unit + e2e together, with coverage thresholds
npm run audit:check    # blocking dependency audit (critical severity)
npm run start:check    # boot + probe /health, /health/ready, /blockchain/deployment
npm run api:export     # write docs/api/backend-openapi.json
npm run stage5:check   # full Stage 05 gate
```

## Stage gate

`npm run stage5:check` is the canonical local gate and the CI gate
(`.github/workflows/backend-quality-gates.yml`). It runs, in order: build, lint,
format check, dependency audit, unit tests, e2e tests, combined coverage
thresholds, the startup smoke check, and the OpenAPI drift check.

### Coverage

Coverage is measured over the unit **and** e2e suites together
(`jest.coverage.json`). Measuring units alone would understate reality, since
controllers, guards, and health indicators are exercised end to end; it would
also push toward writing redundant unit tests purely to move the number.

The run uses the `v8` coverage provider rather than the istanbul default. With
swc's decorator-metadata emit, istanbul charges the generated `__decorate`
helpers to the decorator lines and reports roughly half the branches as
uncovered on files whose logic is fully tested — the numbers describe the
transform instead of the code.

### Dependency audit

`audit:check` blocks on `critical`. High-severity advisories are reported
non-blocking in CI: today every one is transitive through NestJS 11's own
dependencies with no fixed release available, so a blocking `high` gate would
sit permanently red. Revisit when NestJS ships updates.
