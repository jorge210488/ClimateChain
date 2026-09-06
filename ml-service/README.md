# ML Service Module

Python service that prices parametric rainfall policies. It answers one
question — what premium should this coverage cost — and answers it from a model
artifact, not from a formula in the request handler.

Stage 07 delivered the serving stack, the model lifecycle, and the pricing
arithmetic. Stage 08 replaced the synthetic fit with one trained on thirty years
of observed rainfall, evaluated on years it never saw. Stage 09 wires the
backend to call this service. Nothing here calls the backend or the chain, and
nothing on the serving path calls the network.

## Why the premium is never below 1% of coverage

`InsuranceProvider` reverts with `PremiumBelowMinimum` when a premium is under
`MIN_PREMIUM_BPS` of coverage. A quote below that line is arithmetically fine
and commercially useless: the caller takes it straight to `POST /policies` and
the transaction reverts.

Every quote is therefore floored at the on-chain minimum, using the same
ceiling division the contract uses. `flooredToMinimum` in the response says
when the floor rather than the model set the price.

The same reasoning bounds the rest of the inputs. A coverage window longer than
`MAX_DURATION_DAYS`, or a region longer than the `bytes32` budget, is rejected
here instead of quoted, because the policy it describes could never be created.

**A consequence worth knowing:** below the floor every risk prices identically,
so two dry regions can return the same premium while reporting different
`triggerProbability` values. That is the floor working, not the model failing.

### The promise is checked on the way out, too

Bounding the inputs is not sufficient. The amount format both sides share caps
integer digits at 30, and the loading multiplies — so a coverage at the top of
the accepted range can price *above* it, and the backend would refuse the quote
it asked for. Every premium is therefore checked against the backend's own
pattern before the response is sent; a coverage that cannot be priced within the
format returns 422 naming the reason, rather than a number that reverts.

The amount pattern here is copied character for character from the backend's
`POSITIVE_ETH_AMOUNT_REGEX`, not approximated. Approximating it produced
divergences in both directions: refusing `"01.0"` the backend accepts, and
accepting 31 integer digits it rejects.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness. Independent of model availability. |
| `GET` | `/health/ready` | Readiness. 503 when no model is loaded. |
| `POST` | `/predict` | Price coverage. |

Liveness and readiness are separate for the reason the backend separates them:
a failing liveness probe means restart me, a failing readiness probe means stop
sending traffic. A service whose model failed to load needs the second, and
restarting it in a loop would not help.

Interactive docs are mounted at `/docs` for local profiles and withheld on
deployed ones, matching the backend.

### `POST /predict`

Request and response use the backend's `QuoteRequestDto` / `QuoteResponseDto`
field names. `tests/test_backend_contract.py` checks that against the committed
`docs/api/backend-openapi.json` rather than against a copy kept here, so the two
cannot drift apart before Stage 09 connects them.

```jsonc
// Request
{
  "region": "Valencia",
  "startDate": "2026-04-01",
  "endDate": "2026-04-30",
  "coverageEth": "1.0",
  "rainfallThresholdMm": 50
}
```

```jsonc
// Response
{
  "region": "Valencia",
  "premiumEth": "0.01",
  "premiumWei": "10000000000000000",
  "currency": "ETH",
  "startDate": "2026-04-01",
  "endDate": "2026-04-30",
  "modelVersion": "baseline-premium-v2",
  // Beyond the backend contract, so a quote can be explained rather than
  // merely trusted. Additive: a consumer that ignores them is unaffected.
  "triggerProbability": 0.0042,
  "durationDays": 30,
  "regionKnown": true,
  "flooredToMinimum": true
}
```

`premiumWei` is the authoritative amount and is a string: wei for a large
coverage exceeds what JSON consumers parse losslessly as a number. `premiumEth`
is the same value and round-trips to the same wei, so it can be fed back into
policy creation unchanged.

## The model artifact

`app/models/artifacts/baseline-premium-v2.json` holds fitted coefficients,
region risk factors, the premium loading, and a `training` block recording
where the numbers came from. It is committed, and the stage gate retrains it
from the committed dataset and fails if the result differs — the same drift
guarantee the contracts module enforces for its ABIs.

**It is JSON, not a pickle.** Unpickling executes whatever the file contains,
which is not an acceptable property for something read at every boot from an
operator-controlled path. JSON also lets a reviewer read what the service prices
with. The file carries a `sha256` over its own contents, so a truncated or
edited copy fails to load instead of pricing from wrong numbers.

Loading also rejects anything the evaluator could not use: an unknown, missing,
or duplicated feature, and any non-finite coefficient, region risk, or loading.
Those used to pass the checksum and fail at the first quote — which meant
readiness reported a model that could not price.

Rebuild it with:

```bash
python scripts/train_rainfall_model.py
```

### What the model actually is

`scripts/train_rainfall_model.py` reads `data/rainfall-history-v1.json` — daily
precipitation for every known region from 1995 to 2024 — rolls each coverage
window across the *training years only*, measures how often the trigger would
have fired, and fits the log-odds of that frequency against threshold, duration,
and the region's mean rainfall. The premium is expected loss plus a loading.

The model family is the one Stage 07 served; what changed is the evidence
behind the coefficients. The runtime did not change to load it.

**The data is observed, not synthetic.** It is ERA5 reanalysis served by the
Open-Meteo Historical Weather API: assimilated observations, not a random draw
from a distribution somebody chose. The artifact says so in its `training`
block (`kind: "observed"`, `transitional: false`), and readiness reports the
same three facts so an operator can tell which model an instance is running and
what it was trained on.

### How it is evaluated

The split is by calendar date, not at random: fitted on 1995-2018, scored on
2019-2024. A random split would leak the holdout's weather into training
through overlapping windows and flatter the model.

Scoring uses proper scoring rules — log-loss and Brier — computed by the
runtime's own evaluator, so the numbers describe the code path that prices,
not a re-implementation of it. The superseded synthetic artifact is kept in
`app/models/artifacts/archive/` and scored on the *same* holdout, which is what
makes the comparison a comparison:

| Model | Data | Holdout log-loss | Holdout Brier | Predicted / observed trigger rate |
| --- | --- | --- | --- | --- |
| `baseline-premium-v2` | observed (ERA5) | **0.1823** | **0.0555** | 0.101 / 0.097 |
| `baseline-premium-v1` | synthetic | 0.2883 | 0.0804 | 0.022 / 0.097 |

The synthetic model under-priced by more than four times on the years it was
never fitted to. That is the number this stage exists to produce, and it is
regenerated — and checked for drift — on every gate run; the full figures are
in `app/models/artifacts/baseline-premium-v2.metrics.json`.

### The dataset

`data/regions.json` is the registry: the eight regions the model knows, with the
coordinates they were fetched at. `data/rainfall-history-v1.json` is the
observed series for each — committed, checksummed, and validated on load
(shape, day count, no negatives, no missing days). It is the only network
product in the module, and it is produced deliberately rather than by any gate:

```bash
python scripts/fetch_rainfall_history.py
```

A refresh that returns the same observations leaves the file byte-identical, so
`git status` reports a change in the source and never a mere re-run. Adding a
region means adding it to the registry, refetching, and retraining; the gate
fails if the registry and the dataset disagree.

No key is needed: Open-Meteo's archive endpoint is open, which is why the
`WEATHER_API_*` variables remain empty.

## Configuration

Copy `.env.example` to `.env`. No secrets are required for this stage.

| Variable | Purpose |
| --- | --- |
| `APP_ENV` | `development`, `test`, `staging`, `testnet`, or `production`. |
| `APP_PORT` | Local serving port. |
| `LOG_LEVEL` | `debug` … `critical`. |
| `MODEL_PROVIDER` | Must match the artifact's own provider, or startup aborts. |
| `MODEL_PATH` | Artifact location, absolute or relative to `ml-service/`. |
| `WEATHER_API_*` | Reserved. The Stage 08 source needs no key; left for a provider that does. |

Validation is fail-fast: an unknown profile, an out-of-range port, or a provider
that does not exist is rejected at startup rather than at the first request.

## Commands

```bash
python -m venv .venv                          # once
pip install -r requirements.txt

python scripts/train_rainfall_model.py        # retrain the artifact from data/
python scripts/fetch_rainfall_history.py      # refresh the dataset (network)
python serve.py                               # run locally
python -m pytest                              # tests
python -m ruff check . && python -m ruff format --check .
python scripts/startup_check.py               # boot a real process and probe it
```

## Stage gate

```bash
python scripts/stage8_check.py
```

Runs lint, format, dataset integrity (checksum, shape, and agreement with the
region registry), a full retrain that must reproduce the committed artifact and
metrics byte for byte, the test suite, and a real startup that binds a socket
and serves a quote. The test suite alone would not prove the packaged entrypoint
boots, which is why the last step exists. `scripts/stage7_check.py` is the
Stage 07 subset and still runs, but the gate is `stage8_check.py`.

Nothing in the gate reaches the network: a gate that could pass or fail on a
remote service's mood is not a gate.

CI runs the same command on Python 3.11 — the floor in `pyproject.toml` — so an
incompatibility with the oldest supported version is caught here rather than by
whoever installs it next.
