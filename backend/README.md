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
| POST   | `/auth/token`            | public | Exchange `ADMIN_API_KEY` for a JWT (when enabled) |
| GET    | `/auth/me`               | admin  | Authenticated principal                          |
| POST   | `/policies`              | public | Create policy (live execution: Stage 06 → 501)   |
| GET    | `/policies`              | public | List policies (live reads: Stage 06 → 501)       |
| GET    | `/policies/:address`     | public | Get policy (live reads: Stage 06 → 501)          |
| POST   | `/pricing/quote`         | public | Premium quote (live ML: Stage 09 → 501)          |

Interactive API docs are served at `/docs`. A committed OpenAPI snapshot lives
at `docs/api/backend-openapi.json` (regenerate with `npm run api:export`).

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
- Canonical error response contract via a global exception filter.
- Fail-fast boot: invalid config or unreadable ABI/manifest aborts startup.

## Configuration

Copy `.env.example` to `.env`. The environment is validated at boot with a Joi
schema; defaults cover local/dev/test. Deployed profiles
(staging/testnet/production) must supply real secrets (e.g. `JWT_SECRET`,
`RPC_URL`). See `.env.example` for the full list.

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
npm run start:check    # boot + probe /health, /health/ready, /blockchain/deployment
npm run api:export     # write docs/api/backend-openapi.json
npm run stage5:check   # full Stage 05 gate (build + quality + tests + startup)
```

## Stage gate

`npm run stage5:check` is the canonical local gate and the CI gate
(`.github/workflows/backend-quality-gates.yml`). It runs build, lint, format
check, unit tests, e2e tests, and the startup smoke check in one pass.
