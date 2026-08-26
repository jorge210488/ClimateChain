# Stage 07 - ML Service Foundation

## Scope completed

- **Objective achieved:** `ml-service/` is a running FastAPI service that prices
  parametric rainfall policies from a loaded model artifact, with fail-fast
  startup, readiness that reflects real model availability, and a single gate
  command covering lint, artifact drift, tests, and a real process boot.
- **Purpose and value:** This is the first module that turns coverage into a
  number, and the number has to be one the chain will accept. Pricing lives
  behind the same domain rules the contracts enforce, so a quote can always be
  taken to `POST /policies` rather than reverting there. It also closes the last
  module with no CI: contracts and backend each had a gate, Python had none.
- **Functional result:** `GET /health`, `GET /health/ready`, and `POST /predict`
  serve over HTTP. A premium is returned in wei and ETH, floored at the
  provider's minimum ratio, with the model version and the risk estimate behind
  it. The service refuses to start without a valid artifact.
- **Integrated previous-stage outputs:** Two prior artifacts are read directly
  rather than copied. `docs/api/backend-openapi.json` (Stage 05) is parsed in
  tests to assert this service accepts every field `QuoteRequestDto` carries and
  returns every field `QuoteResponseDto` requires.
  `backend/src/modules/policies/policy.constants.ts` (Stage 05, verified against
  the deployed contracts at boot in Stage 06) is parsed to assert the domain
  mirror here agrees with the backend's — minimum premium ratio, basis-point
  denominator, maximum duration, region byte budget, and ETH decimals.
- **Runtime data sources (real vs test-only):** Real — the model artifact, read
  from disk at startup and used on every `/predict`. No hardcoded premium exists
  on any runtime path. **Transitional** — the artifact was fitted on synthetic
  rainfall, so it is not predictive of real climate; it is explicitly tagged as
  such in the file, the build script, and the README, and cannot be used to
  claim production pricing readiness. Test-only — nothing; the tests exercise the
  same artifact the service loads.
- No external service is called. The weather provider and the backend
  integration belong to Stages 08 and 09.

## Files changed

- `ml-service/app/core/config.py` — fail-fast settings with profile, port, log
  level, and provider validation.
- `ml-service/app/core/domain.py` — on-chain domain mirror and the minimum
  premium calculation.
- `ml-service/app/core/money.py` — exact ETH string ↔ integer wei conversion.
- `ml-service/app/models/artifact.py` — artifact schema, checksum, and loading.
- `ml-service/app/models/registry.py` — model lifecycle and readiness status.
- `ml-service/app/models/baseline.py` — risk evaluation from fitted coefficients.
- `ml-service/app/services/pricing.py` — premium computation and the floor.
- `ml-service/app/schemas/pricing.py`, `app/schemas/health.py` — request,
  response, and probe payloads.
- `ml-service/app/api/routes.py`, `app/main.py` — HTTP surface and lifespan.
- `ml-service/serve.py` — real entrypoint, replacing the Stage 01 placeholder.
- `ml-service/scripts/build_baseline_model.py` — reproducible fit and artifact.
- `ml-service/scripts/startup_check.py`, `scripts/stage7_check.py` — runtime
  boot verification and the stage gate.
- `ml-service/app/models/artifacts/baseline-premium-v1.json` — the artifact.
- `ml-service/tests/` — 95 tests across contract, pricing, API, config, money,
  and artifact integrity.
- `ml-service/requirements.txt`, `pyproject.toml`, `.env.example`, `README.md`,
  `conftest.py`.
- `.github/workflows/ml-service-quality-gates.yml` — CI for this module.
- `README.md` — stage status and onboarding.

## Decisions made

- **The artifact is JSON, not a pickle.** Unpickling executes whatever the file
  contains, and this file is read at every boot from an operator-controlled
  path. JSON is also reviewable. It carries a `sha256` over its own contents, so
  a truncated or edited copy fails to load rather than pricing from wrong
  numbers.
- **Stage 07 fits a real model on synthetic data rather than hardcoding a
  formula.** The acceptance criteria require a real artifact while the training
  pipeline is Stage 08, which is a genuine tension. Resolved by generating a
  documented, seeded dataset, measuring trigger frequencies in it, and fitting
  log-odds against threshold, duration, and region wetness. The coefficients come
  from measurements — their signs are asserted in tests — and the synthetic
  origin is tagged as transitional wherever it appears. Hardcoding a premium
  would have violated the runtime-mocking policy the backend already honours by
  returning 501 instead of a fake price.
- **The premium is floored at the on-chain minimum.** A quote below
  `MIN_PREMIUM_BPS` of coverage is arithmetically correct and commercially
  useless: the caller learns it is unusable only after paying gas. The floor uses
  the same ceiling division as the contract, and `flooredToMinimum` tells the
  caller when the floor rather than the model set the price.
- **Inputs are bounded by what the chain will accept.** A window beyond
  `MAX_DURATION_DAYS` or a region beyond the `bytes32` budget is rejected rather
  than quoted, because the policy it describes could not be created. Region
  length is measured in UTF-8 bytes, not characters.
- **No float touches a monetary value.** Amounts arrive as decimal strings and
  are computed as integers, mirroring the backend. The probability is scaled into
  an integer rate before multiplying coverage, so the bottom of a large value is
  not lost.
- **Liveness and readiness are separate.** A failing liveness probe means
  restart; a failing readiness probe means withhold traffic. A model that failed
  to load needs the second — restarting would not fix it.
- **Readiness reports which model, not just that one exists.** During an
  incident the question is whether an instance is running the current artifact,
  and two instances on different versions look identical without the checksum.
- **The artifact is committed and its rebuild is verified.** The gate rebuilds it
  and fails on any difference, the same guarantee the contracts module enforces
  for shared ABIs. Rebuilds are byte-identical: the timestamp is preserved when
  nothing substantive changed, so the drift check is meaningful rather than
  always red.
- **The startup check passes configuration explicitly.** A gate whose result
  depends on a developer's untracked `.env` is not a gate. Passing it through the
  environment is also how a deployment supplies it, so realism is preserved.
- **CI runs Python 3.11 while local development runs 3.13.** 3.11 is the floor
  declared in `pyproject.toml`; testing the floor is what makes the floor a
  claim rather than a hope.

## Commands executed

- `cd ml-service && python -m pip install -r requirements.txt`
- `cd ml-service && python scripts/build_baseline_model.py`
- `cd ml-service && python -m ruff check --fix . && python -m ruff format .`
- `cd ml-service && python -m pytest`
- `cd ml-service && python scripts/startup_check.py`
- `cd ml-service && python scripts/stage7_check.py`

## Tests executed and results

- `python scripts/stage7_check.py`: passed end to end.
- Lint and format: clean across 29 files.
- Artifact drift: the committed artifact matches its build script byte for byte.
- Tests: **144 passing** after the review rounds below, comprising
  - 10 contract tests against the backend's published OpenAPI document and
    domain constants;
  - 24 API tests, including three that assert the service refuses to boot —
    without an artifact, on a corrupted one, and on one from another provider;
  - 18 pricing tests covering the floor across magnitudes down to one wei,
    determinism, and the direction of every risk factor;
  - 43 configuration, money, and artifact-integrity tests, including tampering,
    truncation, schema-version, and key-order cases.
- Runtime startup: a real uvicorn process bound a socket, answered `/health` and
  `/health/ready`, and served a `POST /predict` returning
  `premiumWei=10000000000000000` for 1 ETH of Valencia coverage.

One behaviour was discovered by a failing test rather than assumed: below the
premium floor, distinct risks price identically, so two dry regions return the
same premium while reporting different `triggerProbability`. The test was wrong,
not the code, and the behaviour is now pinned by
`test_the_floor_compresses_low_risk_quotes`.

## Review round

Five findings on the code above, all real and all fixed. Four were defects in
what this stage had just claimed.

**The quote → create promise failed at valid limits.** The amount pattern here
was written to match the backend's rather than copied from it, and diverged in
both directions: it refused `"01.0"` the backend accepts and accepted 31 integer
digits it refuses. `rainfallThresholdMm` had no upper bound, so a value past
2^53 passed here and would be rejected there as already-corrupted. Worst of the
three: a 30-digit coverage the backend accepts, priced at maximum risk, produced
a 31-digit premium the backend would then refuse — the invariant this service
advertises, broken at its own boundary. The pattern is now copied character for
character, the threshold is bounded, and every premium is checked against the
backend's pattern before the response is sent, returning 422 when a coverage
cannot be priced within the shared format.

**A valid-looking artifact could load and break `/predict`.** Loading verified
the checksum and the feature/coefficient count, but not that the features were
ones the evaluator computes or that the numbers were finite. An artifact with
`features=["unsupported_feature"]` loaded, readiness reported ready, and the
first quote returned 500 — the precise failure fail-fast exists to prevent.
Reproduced with four more cases beyond the one reported: NaN coefficient,
infinite loading, duplicated feature, missing feature. Loading now rejects all
six.

**The gate would fail falsely on a fresh Windows clone.** The build script wrote
with the platform's newline while the committed file is LF, and the drift check
compares raw bytes. It passed locally only because that working tree already
held CRLF; a clean checkout under `core.autocrlf=input` gets LF, rebuilds to
CRLF, and fails on a change that never happened. Fixed on both sides — explicit
`newline="
"` on write, and a `.gitattributes` pinning `*.json` to LF, which
also covers the ABI and deployment manifests other gates compare.

**The startup check could pass without starting anything.** A fixed port meant
any listener already on it could answer the probes while the process under test
failed to bind and died. It now reserves an ephemeral port, verifies the
responder reports the checksum this run built, and confirms the child is still
alive after the requests.

**Warnings were emitted and ignored.** With open dependency ranges, a
deprecation is how an incompatibility announces itself before it breaks. The
suite now treats warnings as errors, with one documented ignore for a
test-only Starlette notice. It immediately caught a deprecated status constant
in the code written minutes earlier.

Gate after the round: lint and format clean, artifact drift clean, **109 tests
passing**, and a real startup verified by checksum.

## Second review round

Four findings, all real. One of them exposed a gap in the round before it.

**The two services did not agree on what a request is.** Field names and
published limits matched, and every contract assertion passed, while the backend
accepted an ISO timestamp the ML service rejects, accepted a region of only
whitespace, and preserved padding that the ML service trimmed. The last one is
the consequential one: the backend encodes the region into `bytes32` exactly as
sent, so a quote for `"  Valencia  "` returned `"Valencia"` and the policy
created would have carried a different region code than the one priced.

Resolved by fixing both sides rather than either. Dates are calendar dates on
both — coverage is measured in whole days and a time component invites two
readings of one window. A region of only whitespace is refused on both;
`@IsNotEmpty()` only ever rejected the empty string, and a bytes32 of spaces
would have gone on chain. Padding is now preserved on both, because the region
identifier is the caller's, and normalisation happens only where risk is looked
up.

**An artifact could still load and fail on the first quote.** The loader
required `premiumLoading` to be finite, which `1e308` is — and pricing then
scales it into an overflow. Readiness green, `/predict` returning 500. A negative
loading was worse than an error: it loaded, priced every policy at the minimum
floor, and looked like it was working. Loading now rejects a negative loading
and proves the scaled worst case is finite, using the same constant pricing
multiplies by.

**Two spellings of one region resolved by JSON key order.** `regionRisk` keys
are normalised for lookup, so `"Valencia"` and `"valencia"` are one region with
two risks, and the winner was whichever appeared last in the file. Collisions and
keys that normalise to nothing now fail the load.

**The gate did not cover everything its guarantee rests on.** `.gitattributes`
decides the line endings the byte-for-byte artifact check compares, and the
backend's DTO, validators, and amount utilities decide what the contract tests
are checking against — none of them triggered this workflow.

The deeper half of that finding was the important one: the contract test compared
published *shape*, which is why it did not catch the date and region divergence
above. There are now shared acceptance vectors in
`shared/contracts/pricing-request-vectors.json`, run by both
`ml-service/tests/test_shared_contract_vectors.py` and
`backend/src/modules/pricing/dto/quote-request.dto.spec.ts`. Adding a vector
tests both services; a rule changed on one side fails on the other.

Running them immediately found a divergence nobody had reported: the backend's
pricing DTO had no maximum-duration check, so it accepted windows longer than
any policy the provider will create. Added.

Gate after the round: ML 144 tests, backend 352, both gates green.

## Risks or pending items

- **The model is not predictive.** It is fitted on synthetic rainfall and must
  not be used to price real risk. Stage 08 owns replacing the dataset and the
  fit; the artifact shape and this service do not need to change for that.
- **The premium loading is a judgement, not a measurement.** 0.35 over expected
  loss is a commercial choice recorded in the artifact. Estimating it from
  synthetic data would have dressed a decision up as a finding.
- **No authentication.** `/predict` is open. Stage 09 defines how the backend
  reaches this service, and until that topology exists — service mesh, network
  policy, or a shared secret — there is nothing concrete to authenticate against.
  It must not be exposed publicly before then.
- **No rate limiting or request budget.** Pricing is cheap and in-process, so
  there is no downstream to protect yet, but the same reasoning ends when
  Stage 08 introduces an external weather provider.
- **Single artifact, loaded once.** Rolling out a new model means restarting the
  process. Hot reload is not implemented and should not be until there is a
  reason to prefer it over a rolling deploy.
- **Region coverage is narrow.** Eight regions are known; anything else is
  priced at the mean risk. That is deliberate — refusing unknown regions would
  reject business the service can reasonably quote — but the fallback is a
  placeholder, not a risk assessment.

### Credentials status

- `Credentials required now:` No
- `Credentials list:` `WEATHER_API_BASE_URL`, `WEATHER_API_KEY` (declared,
  unused, and empty in Stage 07)
- `Purpose:` reserved for the Stage 08 data pipeline, which fetches observed
  rainfall to train on. Nothing in Stage 07 reads them, and the service starts
  and prices with both empty.

## Next stage handoff notes

- Stage 08 replaces `scripts/build_baseline_model.py` with a real data pipeline.
  Keep the artifact contract — `schemaVersion`, `checksum`, `features`,
  `coefficients`, `provider` — or bump `SUPPORTED_SCHEMA_VERSION` and update the
  loader together with it. A new provider means adding a value to the
  `MODEL_PROVIDER` validator, which currently accepts only `baseline` so a typo
  cannot resolve to something unevaluable.
- Stage 09 wires the backend's `PricingService` to this endpoint, replacing its
  501. The field names already match, and `tests/test_backend_contract.py` will
  fail if either side drifts before then. That test is the reason the wiring
  should be mechanical rather than a renegotiation.
- The premium floor is duplicated in three places by design — contract, backend,
  and here — and the contract test is what keeps them honest. If Stage 08 or 09
  changes any of them, run `python scripts/stage7_check.py`, which reads the
  backend's files directly and will fail on the mismatch.
- Do not expose `/predict` publicly. See the authentication note above.
