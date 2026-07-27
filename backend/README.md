# Backend Module (NestJS)

Production-oriented API foundation that coordinates policy lifecycle, premium
pricing, and on-chain integration. Built with NestJS 11 and TypeScript.

## Architecture

```text
src/
  main.ts                 # Bootstrap (pino logger, Swagger, shutdown hooks)
  app.module.ts           # Root module + global pipe/filter/guards
  app-setup.ts            # Shared runtime, security headers, Swagger, body limits
  config/                 # Typed config, Joi env validation, AppConfigService
  logging/                # Structured pino logging (request-id, redaction)
  common/                 # Exception filter, response contracts, pipes, validators
    throttling/           # Named rate limiters (auth, policy reads)
    utils/                # EVM address, ETH amount, bytes32 region codecs
  modules/
    blockchain/           # Everything between the backend and the chain
      contract-registry   #   Shared ABIs + deployment manifest (Stage 05)
      chain-provider      #   RPC connection, signer, timeouts, retry, nonce queue
      contract-factory    #   Contract instances built from the registry's ABIs
      chain-bootstrap     #   Boot-time chain verification (fatal on mismatch)
      chain-error.mapper  #   Revert decoding -> explicit HTTP error contracts
      chain-retry.util    #   Transient vs deterministic failure classification
    health/               # Liveness + readiness probes (config, metadata, chain)
    auth/                 # JWT auth, roles, admin token issuance
    policies/             # Policy DTOs, endpoints, and domain chain access
    pricing/              # Premium quote DTOs + endpoints
```

Nothing outside `blockchain/` constructs a provider, a signer, or a contract
instance: contracts are built from the ABIs the registry validated at boot and
the addresses in the deployment manifest, so there is no second copy of either
anywhere in the backend.

## Endpoints

| Method | Path                     | Auth   | Notes                                            |
| ------ | ------------------------ | ------ | ------------------------------------------------ |
| GET    | `/health`                | public | Liveness probe                                   |
| GET    | `/health/ready`          | public | Readiness (config + on-chain metadata + live chain) |
| GET    | `/blockchain/deployment` | public | Loaded network, addresses, contract ABIs         |
| POST   | `/auth/token`            | public | Exchange `ADMIN_API_KEY` for a JWT (when enabled); rate limited |
| GET    | `/auth/me`               | admin  | Authenticated principal                          |
| POST   | `/policies`              | bearer | Submits the creation transaction; returns once mined |
| GET    | `/policies`              | public | Lists policies from chain; rate limited          |
| GET    | `/policies/:address`     | public | Reads one policy from chain; rate limited        |
| POST   | `/pricing/quote`         | public | Premium quote (live ML: Stage 09 → 501)          |

Reads are public because on-chain state is world-readable; creation requires a
bearer token because it submits a transaction signed with the backend's key and
draws on the provider's coverage reserve.

`POST /policies` requires an `insured` address: the contract records it as the
beneficiary, so the payout reaches the end user while this service pays the
premium and the gas. The signer is the payer, never the beneficiary — the
request is refused rather than defaulting to the signer, because a silent
default there would quietly make the operator the owner of every policy.

Interactive API docs are served at `/docs` on local profiles and are opt-in on
deployed ones (`SWAGGER_ENABLED`). A committed OpenAPI snapshot lives at
`docs/api/backend-openapi.json` (regenerate with `npm run api:export`).

### Chain behavior

- **Creation is dry-run first.** `staticCall` executes the transaction against
  current state without spending gas, so a request that would revert fails
  immediately with a decoded reason instead of costing gas and surfacing as a
  mined-but-failed transaction.
- **Reads are retried; writes never are.** A retry after an ambiguous write
  timeout could submit the same policy twice and spend the reserve again. Only
  idempotent reads go through the retry policy.
- **Transaction ordering is managed locally.** Nonces are tracked in-process and
  submissions are queued, because asking the node per transaction returns a
  stale value under concurrency. Each running instance needs its own signing
  account.
- **Reverts are mapped by who can act on them**: `400` the caller can fix the
  request, `404` unknown subject, `409` conflicts with current on-chain state,
  `503` the operator must act (fund the reserve, fund the signer, fix config).
  Messages carry the decoded on-chain arguments.
- **Pagination is delegated to the contract**, and `CHAIN_MAX_PAGE_SIZE` caps
  RPC fan-out per request. Responses report the *applied* limit, which may be
  lower than the one requested — paginate with `meta.limit`, not your own value,
  or you will skip records.
- **The default start comes from chain time, not server time.** The contract
  validates it against `block.timestamp`, so a start derived from a server clock
  running ahead of the chain would land in the chain's past and revert.
- **Reads are answered from one pinned block.** A policy is assembled from a
  dozen calls; unpinned, a settlement mined midway through would produce a
  response that never existed on chain — `status: active` beside
  `settlementType: expiry`.
- **The chain id is asked of the node, never taken from configuration.**
  `provider.getNetwork()` returns the configured value without a round trip when
  `staticNetwork` is active, which would make the check compare configuration
  with itself and pass against any chain.

### Idempotent creation

`POST /policies` **requires** an `Idempotency-Key` header — a unique value per
logical request, reused when retrying. It is mandatory rather than optional
because an ordinary client timeout on a request that already reached the chain is
indistinguishable from a new request, and refusing beats accepting one the server
cannot deduplicate.

The record moves through three states, and the middle one carries the weight:

```
  in-flight  ──submitted to chain──▶  submitted  ──▶  completed
      │                                   │
  released on failure               kept on failure
  (nothing happened)                (it may have happened)
```

| Situation | Response |
| --- | --- |
| First request | Executes normally |
| Repeat after success | `201` replaying the original result |
| Repeat while still running | `409` — retry once it completes |
| Repeat after a transaction was submitted but not confirmed | `409` naming the transaction hash to reconcile — **never** a resubmission |
| Same key, different body | `409` |
| Failure before submission | Key released; retry freely |

That fourth row is the expensive case. Once a node accepts a transaction, waiting
for its receipt can time out while the transaction still confirms minutes later.
Treating that as a plain failure and releasing the key would let a retry submit a
second transaction, and both could be mined — locking the coverage reserve twice.

> **The store is in-process and non-durable.** A restart loses it and two
> instances do not share it, so neither protects against a duplicate on its own.
> Durable idempotency, shared nonce coordination, and mutual exclusion are
> **prerequisites for running more than one instance**, not optimizations. The
> datastore arrives with Stage 11.

> **Read cost.** A page of 25 policies costs roughly 325 RPC calls, because each
> policy is assembled from about a dozen individual reads. Measured on a local
> node, 40 concurrent list readers see multi-second latency. It holds up — the
> batching and the limiter do their job — but this is the weak point of reading
> normalized state straight from chain, and the structural fix is the off-chain
> read model in Stage 11. Run `npm run load:check` to measure it yourself.

### Stage boundaries

Policy creation and reads execute on chain (Stage 06). Premium quoting still
responds with HTTP `501` until Stage 09, rather than returning mock data, per
the no-runtime-mocks policy.

Without `RPC_URL` the service still boots — readiness reports `chain: down` and
policy endpoints return `503` naming the missing variable. That is a supported
local state, not a failure mode.

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

- `PRIVATE_KEY` — must be a `0x`-prefixed 32-byte hex string when set. Required
  for policy creation; reads work without it. Give each running instance its own
  account: nonces are tracked per process, so two instances sharing one signer
  collide.
- `ADMIN_API_KEY` — optional (unset disables `POST /auth/token`), but minimum 32
  characters when set: it is the only credential guarding JWT issuance. That
  endpoint is additionally rate limited per client address via
  `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_TTL_SECONDS`.

### Chain client tuning

| Variable | Default | Why it matters |
| --- | --- | --- |
| `CHAIN_CONFIRMATIONS` | `1` | Correct for a local node. Raise it on public networks: a single confirmation can still be reorganized away, which would report a policy that no longer exists. |
| `CHAIN_RPC_TIMEOUT_MS` | `10000` | Converts a hung socket into a prompt, retryable failure instead of an HTTP request held open. |
| `CHAIN_TX_TIMEOUT_MS` | `120000` | Bounds waiting for a transaction that may never be mined. |
| `CHAIN_RETRY_ATTEMPTS` | `3` | Reads only. Writes are never retried. |
| `CHAIN_RETRY_BASE_DELAY_MS` | `250` | Backoff grows exponentially with jitter, so concurrent retries do not hit a recovering node in lockstep. |
| `CHAIN_MAX_PAGE_SIZE` | `50` | Each policy costs about a dozen RPC calls; this bounds fan-out per request. |
| `CHAIN_READ_RATE_LIMIT_MAX` / `_TTL_SECONDS` | `60` / `60` | The read endpoints are anonymous and amplify each request into many RPC calls; this protects the node and the RPC bill. |

> **Operational note:** both rate limiters key on the client address reported by
> Express, and their state is per process. Behind a reverse proxy or load
> balancer, enable `trust proxy` or the limiter meters the proxy; across several
> instances the effective budget multiplies by instance count. Deferred to
> Stage 12/13, when the deployment topology is defined.

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
npm run test:e2e       # end-to-end tests (no chain required)
npm run test:e2e:chain # end-to-end against a live chain (requires a node)
npm run test:cov       # unit + both e2e suites, with coverage thresholds
npm run load:check     # concurrency + load harness (needs a running chain)
npm run audit:check    # blocking dependency audit (critical severity)
npm run start:check    # boot + probe /health, /health/ready, /blockchain/deployment
npm run api:export     # write docs/api/backend-openapi.json
npm run stage5:check   # chain-free gate
npm run stage6:check   # full gate: the above plus live-chain e2e and coverage
```

## Stage gate

`npm run stage6:check` is the canonical local gate and the CI gate
(`.github/workflows/backend-quality-gates.yml`). It runs, in order: build, lint,
format check, dependency audit, unit tests, no-chain e2e, the startup smoke
check, the OpenAPI drift check, the live-chain e2e suite, and combined coverage
thresholds.

The split exists because the two halves have different requirements:

- `stage5:check` needs no infrastructure and is the fast local loop.
- `stage6:check` needs a running node with the contracts deployed and the
  coverage reserve funded. The integration it validates cannot be proven without
  one — a mocked chain adapter would validate nothing under the no-runtime-mocks
  policy. See [`docs/runbooks/local-stack.md`](../docs/runbooks/local-stack.md).

CI starts a real Hardhat node, deploys, and funds the reserve before running it.

### Coverage

Coverage is measured over the unit **and** both e2e suites together
(`jest.coverage.js`). Measuring units alone would understate reality, since
controllers, guards, health indicators, and the entire chain client are
exercised end to end; it would also push toward writing redundant unit tests
purely to move the number. Because the chain suite is part of the measurement,
the thresholds are only reachable with a node running.

The run uses the `v8` coverage provider rather than the istanbul default. With
swc's decorator-metadata emit, istanbul charges the generated `__decorate`
helpers to the decorator lines and reports roughly half the branches as
uncovered on files whose logic is fully tested — the numbers describe the
transform instead of the code.

### Dependency audit

`audit:check` blocks on **high-severity advisories reachable from production
dependencies** (`npm audit --omit=dev --audit-level=high`) — the code that
actually ships. It currently reports zero.

`audit:report` covers the dev toolchain too and runs non-blocking in CI. Those
advisories reach the build tooling rather than the running service, and they sit
behind transitive ranges this project does not control (`brace-expansion` via
`minimatch` via jest and eslint).

There is one `overrides` entry, and it is deliberate:

```json
"overrides": { "@nestjs/swagger": { "js-yaml": "^5.2.2" } }
```

`@nestjs/swagger@11.4.6` pins `js-yaml@5.2.1`, and `5.0.0–5.2.1` carry a
denial-of-service advisory; `5.2.2` is the patch. This was the only advisory
reachable from production dependencies, so it is worth forcing rather than
waiting for upstream. The override is **scoped to the swagger path on purpose**:
eslint and ts-jest depend on `js-yaml` 3.x and 4.x, and a global override would
hand them a major version they were never written against. Drop it once
`@nestjs/swagger` ships a patched pin.
