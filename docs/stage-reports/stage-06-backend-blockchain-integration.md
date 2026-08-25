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

## External review round (findings applied)

An external review raised nine findings. Six were code defects and are fixed;
three are contract-level design decisions and are recorded rather than changed
unilaterally, because each alters on-chain behavior and reopens Stage 03/04.

### Fixed

- **R1 (high): the chain-id check was vacuous.** The provider is created with
  `staticNetwork` when `CHAIN_ID` is set, and `provider.getNetwork()` then
  returns the configured value **without contacting the node**. Bootstrap was
  therefore comparing configuration with itself — a check that passed against
  any chain, including the wrong one. Verified independently: `getNetwork()`
  resolves against an unreachable URL. Now asked with a raw `eth_chainId`
  request, and readiness re-asks on every probe instead of replaying the value
  recorded at boot, so a repointed `RPC_URL` is caught at runtime too.

  The unit test that "covered" this stubbed `getNetwork()`, so it exercised a
  path production could not take — it validated the mock, not the system. It now
  stubs at the raw-RPC level, plus an assertion that the request is actually
  issued.

- **R2 (high): no idempotency on creation.** `POST /policies` now **requires** an
  `Idempotency-Key`. A repeat replays the original result, reusing a key with a
  different body is a 409, and keys are scoped per actor and bound to a payload
  hash. The header is mandatory rather than optional because an ordinary client
  timeout on a request that already reached the chain is indistinguishable from a
  new request; refusing beats accepting one the server cannot deduplicate.

  A follow-up review found the first implementation still admitted the expensive
  duplicate, and it was right — see R8 below.

- **R3 (medium): DTOs accepted integers JavaScript cannot represent.**
  `Number("9007199254740993")` silently becomes `9007199254740992`, satisfies
  `@IsInt()`, and is then rejected by ABI encoding as an overflow — surfacing as
  a generic 500 for what is a bad input. Added `@IsSafeInteger()` to the
  affected fields, and mapped `INVALID_ARGUMENT` / `NUMERIC_FAULT` to 400 as a
  backstop.

- **R4 (medium): reads were not a coherent snapshot.** A policy is assembled
  from a dozen calls with no `blockTag`, so a settlement mined midway through
  could yield `status: active` beside `settlementType: expiry` — a state that
  never existed. Every read in a response now carries one pinned block.

- **R5 (operations): the audit gate was too weak, and the tree was not clean.**
  The gate blocked only on `critical` across all dependencies. An earlier
  conclusion in this report — that no fixes were available — was wrong: `npm
  audit` reported `fixAvailable` for all eleven advisories. Applying the
  non-breaking fixes resolved seven roots (multer, form-data, fast-uri, ws,
  body-parser, joi, ethers). The remainder are `brace-expansion` and `js-yaml`
  reported once per package in the jest/eslint chain, which is why the raw count
  appeared to grow from 8 to 28 — it counts affected packages, not advisories.

  `js-yaml` was the only advisory reachable from **production** dependencies,
  via `@nestjs/swagger@11.4.6` pinning `5.2.1` against a `5.0.0–5.2.1` range.
  Forced to `5.2.2` with an override scoped to that path; a global override
  would hand eslint and ts-jest a major version they were never written
  against. The gate now blocks on **high severity in production dependencies**
  (`--omit=dev --audit-level=high`), which reports zero, and dev-tooling
  advisories are reported non-blocking.

- **R6 (medium): `MAX_REQUEST_BODY_SIZE` accepted any string.** Both failure
  modes are silent and opposite: an unparseable value leaves body-parser with no
  limit at all, while a near-miss (`64kbb`) parses as 64 *bytes* and rejects
  every request. Constrained to a byte-size pattern.

- **R7 (documentation):** the runbook still said the backend does not verify
  bytecode and that the check belonged to Stage 06, which Stage 06 implemented.
  Corrected.

### Second review round

- **R8 (critical): the first idempotency implementation still allowed the
  duplicate it existed to prevent.** It deleted the record on any failure, on the
  reasoning that a failed operation had no effect. That reasoning is wrong for
  exactly the case that matters: `createPolicy` receives a `TransactionResponse`,
  meaning the node has already accepted the transaction, and only then waits for
  a receipt. When that wait times out the transaction can still confirm minutes
  later — the error message even says so. Deleting the record there let a retry
  submit a *second* transaction, and both could be mined, locking the reserve
  twice.

  The record now moves through `in-flight → submitted → completed`. Reaching
  submission is reported by the operation itself (`markSubmitted`, carrying the
  transaction hash, chain id, and nonce), and from that point a failure **keeps**
  the record. A retry receives a 409 naming the hash to reconcile, never a
  resubmission. Failures before submission still release the key, because
  nothing happened.

- **R9 (high): the in-flight record could be released while the work was still
  running.** A five-minute timer evicted any in-flight entry without checking
  whether the operation was alive, so a retry could start a second one — and the
  test asserted that behavior with a promise that never resolved, encoding the
  bug as intent. In-flight records are no longer evicted on a timer at all: this
  store lives in the process running the operation, so an in-flight record means
  the work is still alive, and if the process dies the map dies with it. Only
  terminal states expire.

- **R10 (medium): the documented testnet command could not use a testnet.**
  `test:e2e:chain` set `CHAIN_E2E_RPC_URL` through `cross-env`, which overrides
  the caller's value — verified directly: an operator-provided endpoint was
  silently replaced by `127.0.0.1:8545`. Split into `test:e2e:chain` (reads the
  environment) and `test:e2e:chain:local` (pins the local node, used by the gate
  and CI).

- **R11 (low): `MAX_REQUEST_BODY_SIZE=0`, `0b`, and `0kb` passed validation** and
  produce a limit that rejects every non-empty body — a misconfiguration that
  presents as an outage. Validation now parses the value and enforces a workable
  floor and an operational ceiling, with regressions for each case.

- **R12 (low): health and bootstrap read the block height from the provider's
  cache** while the health comment claimed both values came from the node.
  `getBlockNumberFromNode` existed for precisely that reason and is now used in
  both, so a probe cannot report a healthy height for an endpoint that has
  stopped responding.

- **R13 (low): this report contradicted itself**, claiming idempotency was added
  and later that none existed. The pending-items entry now states the real
  limitation.

## Resolved: the insured is now an explicit beneficiary

The headline blocker of this stage is fixed, by the route the product owner
chose: an explicit beneficiary on the contract rather than user-signed
transactions. This reopened Stage 03/04 deliberately.

**Contract.** `createPolicyWithMetadata` takes an `insuredAddress`. The policy is
constructed with it, indexed under it in `policiesByInsured`, and `PolicyCreated`
is emitted for it. A zero address is rejected in
`_validatePolicyCreationInputs`, before the reserve is touched, so no coverage is
ever locked for a policy that could not pay anyone. The legacy `createPolicy`
still insures its caller and is unchanged.

Naming another account is safe by construction: the caller still pays the
premium, so the parameter can only ever give coverage away, never let someone
else fund a policy that pays out to you.

**Backend.** `insured` is required on `POST /policies`. The service always takes
the beneficiary-aware entry point — the legacy one cannot name an insured, so
routing to it would silently make the operator's signer the owner of the policy.
A request without a region gets the contract's own `LEGACY_REGION_CODE`, which
the backend mirrors and boot verification compares against the deployed
constant, so the mirror cannot drift.

Two consequences worth stating: the response's `insured` is now the requested
beneficiary rather than the signer, and `GET /policies?insured=…` returns a
user's own policies rather than everything the relayer paid for.

This also removed the `RequiresRegion` validator. It existed because only the
metadata path honored an explicit start; now that path is always used, so the
coupling it enforced no longer exists and keeping it would have rejected valid
requests.

**What this does not solve.** The operator still funds premiums from its own
account, so collecting from the user is an off-chain concern this stage does not
address, and the backend can name any beneficiary — authorization for *who may
be named* belongs with the user model in Stage 11.

### Stranded deferred payouts

The explicit beneficiary made a previously theoretical defect reachable, so it
was fixed in the same pass rather than recorded. `executePayout` parks coverage
in `pendingPayoutWei` when the transfer to the insured fails, and until now only
`claimPendingPayout` — insured-only, paying only the insured — could release it.
A beneficiary that can neither receive ETH nor call the contract left the
coverage stranded forever. Before this stage the insured was always the backend's
own externally owned account, so it could not happen; now the API can name a
contract address, by mistake or otherwise.

Two exits, deliberately asymmetric:

- `claimPendingPayoutTo(recipient)` — the insured nominates who receives the
  funds. This is the normal escape and it needs no privileged party: a contract
  beneficiary that can call but not receive still collects, and the operator
  never takes custody. A zero recipient is rejected.
- `recoverUnclaimedPayout()` — owner-only and time-locked at
  `PENDING_PAYOUT_CLAIM_WINDOW_SECONDS` (365 days) from `pendingPayoutSince`.
  Before the window closes it reverts with `PendingPayoutStillClaimable`,
  carrying the timestamp at which recovery becomes possible.

Recovery credits `coverageReserveWei`, not any individual. The provider's
`recoverUnclaimedPolicyPayout` asserts the policy is one it created, calls the
policy, and books the amount back into the reserve, so recovered coverage can
only ever back future policies — it cannot be routed to the owner as profit
without going through the existing, separately-audited reserve withdrawal.

The ordering matters: the insured has a full year during which the owner cannot
touch the money, and the insured's own exit has no time limit at all.

Gate after both changes: contracts 117 tests with Slither clean (47 contracts,
55 detectors, 0 findings) and both contracts far inside the 24 KB limit
(`InsurancePolicy` 5,755 bytes, `InsuranceProvider` 16,311); backend 235 unit,
34 no-chain e2e, 19 live-chain e2e, 288 in the combined coverage run at 97.19%
statements and 90.09% branches. The size baseline was re-recorded for the
intentional 880-byte growth.

### The ambiguous send

A later review pass found the last hole in the idempotency state machine, and it
was mine: the earlier fix closed the window *after* `tx.hash` was known and left
open the one during the send itself.

`sendTransaction` signs and broadcasts in one step, so the hash arrives with the
node's reply. If that reply is lost in transport — a socket hang-up, a proxy
timeout — the caller sees a plain failure for a transaction the node may already
have accepted. `submitTransaction` then reset the nonce, `markSubmitted` never
fired, and the idempotency record was deleted on the grounds that "nothing was
handed to the chain". That premise was false, and the retry created a second
policy that locked the reserve again.

`submitSignedTransaction` splits the step. The transaction is signed locally,
which determines its hash before anything touches the network, and `onSigned`
fires first. A failure after that point is *ambiguous rather than clean*, and it
carries a concrete hash to reconcile against.

Two consequences follow from the same reasoning:

- The nonce is **not** rewound when a broadcast fails. Rewinding would hand the
  next send a nonce the node may be holding, replacing a policy already on its
  way. It is rewound only when nothing was signed.
- An idempotency key is burned by an ambiguous send even if the node in fact
  rejected the transaction. That is the safe direction, and the `staticCall` dry
  run already catches the deterministic rejections beforehand.

The remaining findings in that pass addressed files that do not exist in this
repository — a Flask service, a TypeORM indexer, React views, a paywall
contract — and one flagged the in-process idempotency and nonce scope that this
report already documents below as a Stage 11/12 prerequisite.

Gate after the change: backend 241 unit, 34 no-chain e2e, 19 live-chain e2e, 294
in the combined coverage run at 97.03% statements and 90.12% branches. The
live-chain run is what matters here, since the split path exercises
`populateTransaction`, gas estimation, and EIP-1559 fields that a stub cannot.

### Third review round

Eleven findings; six named files that do not exist here, and five held up.

**The retention window reopened the duplicate.** A `submitted` record — the one
that exists precisely because nobody knows the outcome — was expiring after 24
hours like any completed one. A transaction accepted but never reconciled can
still be mined later, so a retry past the window could submit a second policy.
Only `completed` expires now: its effect is known and was reported, so retention
there is a convenience, not a safety property. The earlier test stopped at 12
hours, inside the window, and so never touched the boundary; it now runs to a
week.

**An unbounded start immobilized the reserve.** Coverage is drawn at creation
and released only at settlement, and the contract bounded the start only from
below. A policy starting decades out locked its coverage for that whole span
while paying the 1% minimum premium, and creation is permissionless on the
contract, so nothing stopped a third party doing it deliberately.
`MAX_POLICY_START_LEAD_TIME_SECONDS` caps it at 365 days; with the existing
duration cap the worst case is two years. The API rejects the same input with a
400 rather than letting it revert.

**`PayoutClaimed` misreported the insured.** Introduced with
`claimPendingPayoutTo` in the previous round: the event emitted the nominated
recipient in a field declared as `insured`, so an indexer would record whoever
received the money as the policy's beneficiary. It now carries both.

**Bytecode verification verified nothing in particular.** Boot confirmed that
*some* code existed at each address, which any contract satisfies. Deployment now
records the runtime bytecode hash in the manifest and boot compares it, so an
address holding a different contract — an old provider, a pasted address from
another network — fails immediately instead of at the first decode error. A
manifest without the field is reported rather than silently treated as a pass.

**One test was named for something it never did.** The e2e case called "the
legacy path" exercises the placeholder region code; the service always uses
`createPolicyWithMetadata`.

The rest belong to stages that own them: a real oracle adapter and owner-only
settlement operations to Stage 10, roles and multisig with timelock to Stage 13,
pricing and premium collection to Stage 09, the read model to Stage 11, and
horizontal scaling to Stage 11/12. Whether policy creation should stay
permissionless is a product question for the Stage 11 user model; the bound
above makes the griefing uneconomic in the meantime.

### Fourth review round

Eleven findings; seven were real and are fixed, four belong to the stages that
own them.

**The broadcast ignored its own timeout.** Splitting sign-then-broadcast in the
previous round left the broadcast outside `call()`, and therefore outside
`CHAIN_RPC_TIMEOUT_MS`. A socket the node never answers would hold the request
until ethers or the OS gave up — and because submission is serialized, every
write queued behind it too. It is now bounded by the configured timeout and
still never retried: a timeout here is the ambiguous case, so the hash was
already reported and the nonce is deliberately left alone.

**A deployed profile could be ready and unable to write.** `RPC_URL` was
required for deployed profiles; `PRIVATE_KEY` was not, with a comment deferring
the question to Stage 06. Stage 06 answered it — the backend signs — so an
unsigned deployed instance passed readiness and failed every `POST /policies`
with a 503. It is now required there, and this report's own credentials section
claimed it already was: the code was the side that was wrong.

**Readiness could not see a node reset.** It compared chain id and height, which
a Hardhat node restarted from scratch reproduces exactly while holding no
contracts; an RPC failing over to a fork does the same on a public network. The
probe now re-checks deployment identity against the manifest's bytecode hashes,
cached for 30 seconds so it does not become an `eth_getCode` flood, and fails
closed when the check itself cannot complete.

**One confirmation was allowed anywhere.** Correct on a local node, wrong on a
public one, and the Sepolia runbook's instruction to raise it is advice rather
than an invariant. Deployed profiles now require at least two.

**`trust proxy` was never configured.** The rate limiter keys on the address
Express reports, so behind a proxy every caller shared one budget. Enabling it
unconditionally would be worse — any caller could then forge `X-Forwarded-For` —
so it is a deliberate `TRUST_PROXY` setting with no default.

**Policy creation was authenticated but not authorized.** Every token today
comes from `ADMIN_API_KEY`, so requiring the admin role changes nothing now and
fails closed later: when Stage 11 introduces end-user identities, a plain user
must not inherit the ability to spend the reserve.

**The single-replica constraint was documented in this report and nowhere an
operator would look.** It is now in the backend README as a deployment
constraint, alongside the read-budget arithmetic: one `limit=50` page costs
about 702 RPC calls, so the default 60/minute budget permits roughly 42,000
calls per minute from one client. Sizing guidance is explicit until Stage 11
replaces direct reads.

Not fixed, because they belong elsewhere: durable idempotency and distributed
nonce coordination (Stage 11/12 — the constraint above is the interim answer),
weighted read cost and a read model or `Multicall3` (Stage 11), binding the
caller to the beneficiary they may name (Stage 11), and the real oracle
adapter (Stage 10).

Gate after the round: contracts 120 tests with Slither clean; backend 265 unit,
34 no-chain e2e, 19 live-chain e2e, 318 in the combined coverage run at 97.14%
statements and 89.78% branches.

### Closing pass

Three follow-ups, all consequences of the previous round rather than new
discoveries.

**The defense-in-depth check had fallen behind its own promise.** The config
factory re-asserts deployed-profile invariants so no path can boot on
development credentials even if Joi is bypassed — but the previous round added
`PRIVATE_KEY` and the confirmation floor to the schema without mirroring them
here, leaving the guarantee partly untrue. Both are mirrored now, with a note
saying that adding one without the other is how this drifts.

**A missing bytecode hash is now fatal on deployed profiles.** It logged a
warning and fell back to checking that *some* code existed — the weak check the
hash was introduced to replace, reinstated silently exactly where identity
matters most. Local profiles keep the warning so a manifest predating the field
still runs.

**The queue's recovery is now asserted, not assumed.** Bounding the broadcast is
only worth having if the queue survives the timeout, and the existing test
proved the first call failed on time, which is not the same claim. A second
write now has to reach `broadcastTransaction` after the first one hangs.

Gate: contracts 120 tests with Slither clean; backend 269 unit, 34 no-chain e2e,
19 live-chain e2e, 322 in the combined coverage run at 97.16% statements and
89.86% branches.

### Recorded, not changed

This one changes on-chain behavior. Implementing it means editing a contract,
redeploying, and re-running the Stage 04 gates — a scope decision that belongs
to the product owner, not to a review pass.

- **The weather-request lifecycle is ambiguous for an asynchronous oracle.**
  `activate()` opens and emits a request before the weather window can be open,
  and retries reuse the request id while emitting a fresh timestamp. An external
  adapter can therefore try to fulfill too early and revert, or fail to tell a
  retry from a duplicate. Worth resolving before Stage 10 wires a real oracle:
  either open requests only from `startTimestamp`, or model attempts with
  unambiguous identifiers.

## Risks or pending items

- **Premiums are paid by the operator's signer.** The beneficiary is now
  explicit, but the ETH still leaves the backend's own account, so collecting
  from the user is an off-chain concern. Whoever may be named as beneficiary is
  likewise unconstrained until there is a user model. Both belong to Stage 11.
- Nonce tracking is per process. Running several instances against one signer
  reintroduces the race, because each process would track its own counter for
  the same account; give each instance its own signing account, or add external
  nonce coordination.
- Rate limiting is also per process and keys on the client address Express
  reports. Behind a load balancer, enable `trust proxy` or the limiter meters
  the proxy; across instances the effective budget multiplies by instance count.
  Both are Stage 12/13 topology decisions.
- Idempotency on policy creation is **required but not durable**. The header is
  mandatory and the record survives an accepted-but-unconfirmed submission, so a
  retry is refused rather than allowed to submit again. What it cannot do is
  survive a process restart or span instances, because the store is an in-process
  map. Two replicas therefore do not deduplicate each other, and a restart loses
  every record. Durable idempotency, shared nonce coordination, and mutual
  exclusion are prerequisites for running more than one instance — not
  optimizations.
- ~~Public-testnet validation is outstanding.~~ **Done on 2026-07-28.** The
  contracts run on Ethereum Sepolia and one policy went through creation,
  trigger, and payout with the backend driving it; see
  [the Sepolia runbook](../runbooks/sepolia-testnet.md). Creation takes 24
  seconds there — two confirmations at ~12-second blocks — against milliseconds
  locally, which makes the synchronous `POST /policies` a queueing question for
  Stage 11 rather than a correctness one. The idempotent replay of that same
  request took 24 ms, since it never reaches the chain.
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
- Credentials list: `RPC_URL`, `PRIVATE_KEY`. Both are now required for deployed
  profiles. This paragraph previously claimed `PRIVATE_KEY` already was, while
  the schema left it optional — a review caught the contradiction, and the code
  was the side that was wrong: Stage 06 settled that this service signs its own
  transactions, so a deployed instance without a key passes readiness and then
  fails every write.
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
- Keep `npm run stage6:check` green and extend it; the live-chain suite is the
  only thing that actually proves this integration works.

## Where the numbers stand

Each "gate after…" line above is a snapshot taken when that change landed, kept
so the history reads honestly. This is the current state, and the only figure to
quote:

| | Count |
| --- | --- |
| Contract tests (`contracts/npm test`) | 120 |
| Backend unit | 269 |
| Backend e2e, no chain | 34 |
| Backend e2e, live chain | 19 |
| **Combined coverage run** | **322** |
| Statements / branches | 97.16% / 89.86% |

Slither reports no findings across 47 contracts and 55 detectors.
`InsurancePolicy` is 5,755 bytes and `InsuranceProvider` 16,311, both far inside
the 24 KB limit.

Sepolia was redeployed onto this bytecode and re-verified end to end; addresses
and measurements are in [the Sepolia runbook](../runbooks/sepolia-testnet.md).
The redeploy confirmed the new boot check works against a live chain, and turned
up something worth recording: `MockWeatherOracle`'s logic was untouched, yet its
deployed bytecode changed anyway, because Solidity's trailing metadata hash
covers every source file in the compilation unit — including the interface whose
event was corrected. Reasoning about whether a change "should" affect bytecode is
not a substitute for hashing both and comparing.
