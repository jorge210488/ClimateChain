# Stage 06 - Backend to Blockchain Integration

## Scope completed

- Objective achieved: The backend now creates and reads parametric policies
  against the deployed `InsuranceProvider` / `InsurancePolicy` contracts over a
  real JSON-RPC connection. The HTTP 501 placeholders left by Stage 05 are gone;
  every policy endpoint executes on chain.
- Purpose and value: This is the stage where the API stops describing a domain
  and starts operating it. It also converts the failure modes that were
  previously invisible — a stale manifest, a chain that does not match the
  backend's assumptions, a revert with no explanation — into boot-time aborts
  and explicit, actionable HTTP responses.
- Functional result: `POST /policies` submits a transaction and returns its
  address, hash, block, gas, and the account the contract recorded as insured.
  `GET /policies` and `GET /policies/:address` read live state with on-chain
  pagination. Reverts arrive decoded with their on-chain arguments.
  `/health/ready` reports live chain reachability. The Stage 06 gate
  (`npm run stage6:check`) passes end to end against a real node.
- Integrated previous-stage outputs: Contract instances are built from the ABIs
  `ContractRegistryService` validated at boot (Stage 04/05) and the addresses in
  `contracts/deployments/<network>.json` — there is no second copy of an ABI or
  an address anywhere in the backend. The DTO validation and error contract from
  Stage 05 are unchanged and now sit in front of real execution;
  `POLICY_DOMAIN`, `PolicyStatus`, and `PolicySettlementType` are verified
  against the deployed contract rather than only against checked-in source.
- Runtime data sources (real vs test-only): Real — a JSON-RPC endpoint and the
  deployed contracts, for every profile. Test-only — the unit suites construct
  error shapes and stub configuration; no mocked chain adapter exists on any
  runtime path, and the live-chain e2e suite runs against an actual node.
- Premium quoting remains HTTP 501 until Stage 09, unchanged from Stage 05.

## Files changed

- `backend/src/modules/blockchain/chain-provider.service.ts` (+ spec) — RPC
  connection, signer, per-call timeout, retry policy, transaction serialization.
- `backend/src/modules/blockchain/chain-retry.util.ts` (+ spec) — transient vs
  deterministic classification and jittered exponential backoff.
- `backend/src/modules/blockchain/chain-error.mapper.ts` (+ spec) — revert
  decoding and mapping of reverts and submission failures to HTTP statuses.
- `backend/src/modules/blockchain/contract-factory.service.ts` — contract
  instances and cached interfaces built from the registry's ABIs.
- `backend/src/modules/blockchain/chain-bootstrap.service.ts` — boot-time chain
  verification.
- `backend/src/modules/blockchain/blockchain.module.ts` — exports the chain seam.
- `backend/src/modules/policies/policy-chain.service.ts` — domain reads and
  writes.
- `backend/src/modules/policies/policy.mapper.ts` (+ spec) — chain view to DTO.
- `backend/src/modules/policies/policies.service.ts`, `policies.controller.ts`,
  `policies.module.ts`, `dto/policy-response.dto.ts`.
- `backend/src/modules/health/indicators/chain.health.ts`,
  `health.controller.ts`, `health.module.ts` — chain readiness.
- `backend/src/common/utils/region-code.util.ts` (+ spec) — `bytes32` region
  codec.
- `backend/src/common/filters/all-exceptions.filter.ts` (+ spec) — structured
  payload passthrough and cause logging.
- `backend/src/config/*` — chain client configuration and validation.
- `backend/scripts/startup-check.ts` — readiness now has a legitimate degraded
  state.
- `backend/test/chain.e2e-spec.ts` (new), `backend/test/app.e2e-spec.ts`.
- `contracts/scripts/fund-coverage-reserve.ts`, `contracts/package.json`.
- `.github/workflows/backend-quality-gates.yml` — CI runs a real chain.
- `docs/runbooks/local-stack.md`, `README.md`, `backend/README.md`,
  `backend/.env.example`, `docs/api/backend-openapi.json`.

## Decisions made

- **Reads are retried; writes never are.** A retry after an ambiguous timeout
  could submit the same policy twice, and a duplicate policy spends the coverage
  reserve a second time. Only idempotent reads go through the retry policy.
- **Transaction submission is serialized per process.** ethers derives the nonce
  per transaction, so two concurrent submissions read the same value and the
  second is rejected. This was not theoretical: it appeared during verification
  as `NONCE_EXPIRED` and would have been reachable with two simultaneous
  requests. A promise-chained queue makes ordering deterministic.
- **Every write is dry-run first.** `staticCall` executes the transaction
  against current state without spending gas, so a request that would revert
  fails immediately with a decoded reason instead of costing gas and surfacing
  as a mined-but-failed transaction.
- **Reverts are mapped by who can act on them**: 400 when the caller can fix the
  request, 404 for an unknown subject, 409 when it conflicts with current
  on-chain state, 503 when the operator must act. A test enumerates the custom
  errors declared by both contracts and fails if any is unmapped — it caught
  eight, including the inherited OpenZeppelin ones.
- **Boot verification is fatal.** Chain id, contract bytecode at every configured
  address, and the on-chain values of the constants `POLICY_DOMAIN` mirrors are
  all checked before the service accepts traffic. A constants mismatch means
  validation would disagree with what the chain enforces, so it aborts rather
  than serving requests that silently revert.
- **Readiness performs a live call** rather than reporting the boot verdict: a
  node can go down or be swapped underneath a long-running process.
- **The policy address comes from the `PolicyCreated` event**, not from
  predicting a CREATE address, so it stays correct regardless of nonce ordering
  or future changes to how the provider deploys policies.
- **Pagination is delegated to the contract.** The policy list grows without
  bound; reading it whole and slicing in the backend would make every list
  request more expensive than the last. `CHAIN_MAX_PAGE_SIZE` additionally caps
  RPC fan-out per request.
- **The chain-free gate and the Stage 06 gate are separate.** `stage5:check`
  stays runnable without infrastructure; `stage6:check` adds the live-chain
  suite and coverage thresholds. The live suite is skipped, never silently
  passed, when no endpoint is configured.

## Commands executed

- `cd backend && npm install ethers@^6.13.0`
- `cd contracts && npx hardhat node`
- `cd contracts && npm run deploy:localhost && npm run reserve:fund:localhost`
- `cd backend && npm run build && npm run lint && npm run format:write`
- `cd backend && npm test && npm run test:e2e && npm run test:e2e:chain`
- `cd backend && npm run test:cov && npm run api:export`
- `cd backend && npm run stage6:check`
- `cd contracts && npm run quality:check`

## Tests executed and results

- `npm run stage6:check`: passed end to end (exit 0).
- Unit: 163 passing across 16 suites.
- e2e without a chain: 32 passing — asserts the degraded contract (readiness 503
  with `chain: down`, policy endpoints 503 naming `RPC_URL`).
- e2e against a live chain: 10 passing — creation through both contract entry
  points, read-back of written state, on-chain pagination, case-insensitive
  insured filtering, empty page, 404 for an unknown address, revert mapping with
  decoded arguments, and rejection of unauthenticated creation.
- Combined coverage (unit + both e2e suites): 205 passing, 95.26% statements,
  86.78% branches, 96.83% functions, above the configured thresholds.
- `cd contracts && npm run quality:check`: passed — solhint, Prettier, and
  Slither (16 contracts, 55 detectors, 0 findings).
- Live verification against a running node, outside the test suites:
  - Boot log: `Chain verified: chainId=31337 block=4 provider=0xe7f1… (15037
    bytes) oracle=0x5FbD… signer=0xf39F… coverageReserveWei=10000000000000000000`.
  - `POST /policies` → 201 with address `0xcafac3dd…`, tx hash, block 5, gas
    1541309.
  - `GET /policies/<address>` → 200 with the exact values written, region
    decoded back to `Valencia`.
  - Coverage above the reserve → 503: *"The provider's coverage reserve cannot
    back this policy … (InsufficientCoverageReserve: available=9000000000000000000,
    requiredAmount=999000000000000000000)"*.

Three defects were found and fixed during verification, none of which the unit
suites alone would have surfaced:

- The global exception filter reshaped Terminus' health payload into the generic
  error contract, so a degraded `/health/ready` returned 503 with no indication
  of *which* dependency failed. The filter now passes structured payloads
  through untouched.
- `NONCE_EXPIRED` under concurrent submission (see Decisions).
- A mapped 500 discarded its cause, making the generic response undebuggable.
  The cause is now attached to the exception and logged with its stack.

## Pre-merge audit (findings applied)

A review before merging, aimed specifically at production readiness and
integration completeness, found six defects. All are fixed.

- A1 (high): **Pagination could silently skip records.** `CHAIN_MAX_PAGE_SIZE`
  capped the page read from chain, but the response reported the *requested*
  limit. A client asking for 100, receiving 50, and advancing its offset by 100
  would drop fifty policies without any error. `listPolicies` now returns the
  applied limit and the response reports that.
- A2 (high): **Nonce assignment was still unreliable.** Serializing submission
  was not sufficient, because ethers asks the node for the nonce per
  transaction and the pending count can lag a transaction the node has already
  accepted. The signer is now wrapped in a `NonceManager` that tracks the nonce
  locally, and a failed submission resets it so a counter that advanced past a
  dropped transaction cannot poison every later send. Covered by a live-chain
  test that creates three policies concurrently and asserts three distinct
  addresses and transaction hashes.
- A3 (medium): **Unbounded RPC fan-out.** A page issued one `Promise.all` over
  every policy, each costing about a dozen calls — a 50-item page meant roughly
  700 simultaneous requests, enough to push a node into rate limiting. Reads now
  run in bounded batches.
- A4 (medium): **Public reads had no rate limit** while amplifying each HTTP
  request into many RPC calls, letting a caller convert modest traffic into RPC
  load and cost. The read endpoints are now metered per client address, with a
  budget separate from the credential-guarding limiter.
- A5 (medium): **Two `ThrottlerModule.forRoot` registrations silently
  conflicted.** Registering per feature module does not give each module its own
  limiter: the later registration replaces the earlier one's limits. Both named
  limiters are now declared in a single `ThrottlingModule`, and routes opt out
  of the ones that do not apply.
- A6 (low): **An unrepresentable region returned 500 instead of 400.** The DTO
  rejects oversized regions first, so this was only reachable from another
  caller of the service — which Stage 10 will be. Encoding failures are now
  reported as client errors.

The audit also removed dead code (`PolicyChainService.isEnabled`,
`effectiveGasPriceWei`, a no-op line in the chain e2e setup) and closed the
largest test gap: the boot-abort paths — wrong chain, missing bytecode,
constant drift — had 59% branch coverage, meaning the safety net that stops the
service running against the wrong chain was largely an assumption. They now have
dedicated specs, as do the chain readiness indicator and the policy chain
service.

Gate after the audit: 200 unit, 33 no-chain e2e, 12 live-chain e2e, 245 in the
combined coverage run at 97.06% statements and 89.48% branches (up from 95.26%
and 86.78%).

## Verification round 2: lifecycle and load

A follow-up pass asked which of the deferred verifications could be completed
without starting Stage 07. Two could, and both found something.

### Lifecycle reads were untested

Every earlier chain test observed a freshly created policy, so the suite only
ever exercised `active` / `settlementType: none` / `pendingPayoutWei: 0`. The
status and settlement mappings exist precisely for the *other* states, and
nothing verified them against real on-chain state — a mapping error would have
surfaced the first time a policy actually paid out, in production.

The live suite now drives a policy through its full lifecycle and asserts what
the **API** reports at each step:

| Transition | Driven by | API reports |
| --- | --- | --- |
| Oracle reports rainfall ≥ threshold | `MockWeatherOracle.pushWeatherData` | `status: triggered`, `conditionMet: true`, `latestRainfallMm`, `lastOracleUpdateTimestamp` |
| Provider executes payout | `executePolicyPayout` | `status: paid_out`, `paidOut: true`, `settlementType: payout`, `settledAt` |
| Window closes, provider expires | `expirePolicy` | `status: expired`, `settlementType: expiry`, `settledAt` |

The transitions are owner-only contract operations the backend does not drive
until Stage 10, so the harness performs them directly against the contracts.
This tests the read path, not a backend capability that does not exist yet.

The deferred-claim path (`pendingPayoutWei > 0`) is not reachable here: it needs
an insured that rejects ETH, and the insured is always the backend's own
account. The contract tests cover it.

### A clock assumption, found by the load run

The load harness failed on its first run with every creation rejected. The cause
was real: the default start timestamp was derived from **server** time, while
the contract validates it against **`block.timestamp`**. On any chain whose
clock has drifted from the server's, the computed start lands in the chain's
past and the transaction reverts. The service now reads the latest block
timestamp, falling back to server time if that read fails.

Wall-clock and chain time agree within seconds on a healthy network, so this was
invisible locally until a test moved the chain clock — exactly the kind of
assumption that survives until the environment stops cooperating.

### Load results

`npm run load:check` (new, opt-in, not in the gate) asserts behavior under
concurrency and reports timings. On a local node, 10 concurrent writes and 40
concurrent reads at page size 25:

- All creations succeed with distinct addresses and transaction hashes — the
  nonce path holds under real concurrency.
- All list reads succeed — the bounded fan-out holds.
- The read limiter sheds traffic once its window is exhausted.
- **Latency: creation p50 ~1.5s; list reads p50 ~6.4s.**

The read number is the honest weak point. A 25-policy page costs roughly 325 RPC
calls because each policy is assembled from about a dozen reads. Nothing breaks,
but multi-second reads are not production numbers for a public endpoint. This is
the inherent cost of reading normalized state directly from chain, and the
structural answer is the off-chain read model in Stage 11 — not a cache bolted
on here.

Gate after this round: 203 unit, 33 no-chain e2e, 16 live-chain e2e, 252 in the
combined coverage run at 97.08% statements and 89.96% branches.

## Risks or pending items

- **The contract assigns the insured from `msg.sender`.** A policy created
  through this API is therefore beneficiary-bound to the backend's signer, not
  to an end user, and a payout would go to the backend. The response returns
  `insured` explicitly so this is visible rather than assumed, but it is a
  product-level gap: resolving it needs either an `insured` parameter on
  `InsuranceProvider` or a user-signed transaction flow. **This blocks any
  real-user deployment** and is the most important open item.
- Nonce tracking is per process. Running several instances against one signer
  reintroduces the race, because each process would track its own counter for
  the same account; give each instance its own signing account, or add external
  nonce coordination.
- Rate limiting is also per process and keys on the client address Express
  reports. Behind a load balancer, enable `trust proxy` or the limiter meters
  the proxy; across instances the effective budget multiplies by instance count.
  Both are Stage 12/13 topology decisions.
- There is no idempotency key on policy creation. A client that retries after a
  timeout creates a second policy and spends the reserve twice. The dry run and
  the mined-status check make silent duplicates unlikely, but a caller-supplied
  idempotency key is the real fix and belongs with the user-facing flow.
- Reads are uncached and always hit the chain, which is correct for
  consistency and expensive under load. A read-through cache with explicit
  invalidation is worth considering if list traffic grows.
- `CHAIN_CONFIRMATIONS` defaults to 1, correct for a local node. Public networks
  should raise it: a single confirmation can still be reorganized away, which
  would report a policy as created that no longer exists.
- Integration is validated against a real node over real RPC, but that node is
  local. Validation against a public testnet needs operator-provided credentials
  and is the natural first task of Stage 16. Everything for it is parameterized
  and the checklist is in `docs/runbooks/local-stack.md`; note that the lifecycle
  tests advance the chain clock with `evm_increaseTime`, which no public network
  supports, so those transitions must be driven by real elapsed time there.
- List read latency is multi-second under concurrent load (measured, see above).
  Acceptable for now, structurally addressed by Stage 11.
- The DTO validates a caller-supplied start against server time while the
  contract validates against chain time. The default start now uses chain time,
  but an explicit one supplied by a caller is still pre-checked against the
  server clock. On a healthy network these agree; when they do not, the contract
  is authoritative and its revert is mapped to an actionable 400.
- No write path exists yet for the owner-only operations (`requestPolicyWeatherData`,
  `executePolicyPayout`, `expirePolicy`); those belong to the Stage 10 oracle and
  automation flow.
- Production blockers and owner: the insured-assignment gap above, owned by the
  domain/contract decision that precedes Stage 10.

## Credentials status

- Credentials required now: No, for local development. The full stack runs on a
  local Hardhat node using its published development accounts.
- Credentials list: `RPC_URL`, `PRIVATE_KEY` (both already required for deployed
  profiles by the Stage 05 boot invariants).
- Purpose: `RPC_URL` is the JSON-RPC endpoint the chain client connects to.
  `PRIVATE_KEY` signs policy-creation transactions and pays their gas. For any
  non-local network use a dedicated account holding only what it needs; never
  reuse a key that holds real funds.

## Next stage handoff notes

- Stage 07 builds the ML service; it does not touch this seam. The backend's
  pricing path still returns 501 and is wired in Stage 09.
- Stage 10 extends `PolicyChainService` with the owner-only oracle and
  settlement operations. The error mapping, retry policy, and transaction
  serialization already cover those paths — reuse them rather than adding a
  second client.
- Resolve the insured-assignment question before any user-facing deployment. It
  is a contract-shape decision, so it likely reopens Stage 03.
- Keep `npm run stage6:check` green and extend it; the live-chain suite is the
  only thing that actually proves this integration works.
