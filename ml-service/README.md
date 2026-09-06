# ML Service Module

Python service that prices parametric rainfall policies. It answers one
question — what premium should this coverage cost — and answers it from a model
artifact, not from a formula in the request handler.

Stage 07 delivered the serving stack, the model lifecycle, and the pricing
arithmetic. Stage 08 replaced the synthetic fit with one trained on thirty years
of observed rainfall, evaluated on years it never saw, and hardened through
three review rounds into a model that prices by region, by season, and never
below what the record proves. Stage 09 wires the backend to call this service.
Nothing here calls the backend or the chain, and nothing on the serving path
calls the network.

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
  "modelVersion": "baseline-premium-v3",
  // Beyond the backend contract, so a quote can be explained rather than
  // merely trusted. Additive: a consumer that ignores them is unaffected.
  "triggerProbability": 0.0042,
  "durationDays": 30,
  "regionKnown": true,
  "flooredToMinimum": true,
  // True when the window or threshold lies outside the grid the model was
  // fitted on (7..365 days, 10..300 mm): the estimate extends the model's
  // form rather than a frequency anyone counted.
  "extrapolated": false,
  // True when the training record, not the fitted model, set the
  // probability: see "the evidence floor" below.
  "pricedFromEvidence": false
}
```

`premiumWei` is the authoritative amount and is a string: wei for a large
coverage exceeds what JSON consumers parse losslessly as a number. `premiumEth`
is the same value and round-trips to the same wei, so it can be fed back into
policy creation unchanged.

The start date is part of the price. The same product quoted for a window
starting in November and one starting in July returns different premiums in a
region with seasons, because they are different risks.

## The model artifact

`app/models/artifacts/baseline-premium-v3.json` holds fitted coefficients, a
per-region effect, per-region monthly offsets, per-region evidence floors, the
premium loading, and a `training` block recording where every number came from.
It is committed, and the stage gate retrains it from the committed dataset and
fails if the result differs — the same drift guarantee the contracts module
enforces for its ABIs.

Two commands, two intents. `python scripts/train_rainfall_model.py` is a
**release**: it stages the artifact and its metrics beside their destinations,
loads the staged artifact exactly as the runtime would, and only then moves
both into place — metrics first, artifact second, and the metrics are put back
if the second move fails, so the pair on disk stays a pair. The same script
with `--check` writes nothing and fails unless the committed files match a
fresh run; that is what the gate runs, so the gate can never create or replace
an artifact as a side effect of verifying one. A missing artifact fails the
gate instead of being regenerated quietly.

A `training` block that claims observed data must carry what makes the claim
checkable — dataset version and checksum, a named source with provider and URL,
the date range, and the configuration hash — or the artifact does not load. An
artifact with no block still loads, and reports `trainingKind: null,
transitional: null`: unknown, never mistaken for clean.

**It is JSON, not a pickle.** Unpickling executes whatever the file contains,
which is not an acceptable property for something read at every boot from an
operator-controlled path. JSON also lets a reviewer read what the service prices
with. The file carries a `sha256` over its own contents, so a truncated or
edited copy fails to load instead of pricing from wrong numbers.

Loading also rejects anything the evaluator could not use: an unknown or
missing feature, a seasonal feature without its offsets (or offsets without the
feature), an offset row that is not twelve numbers, an evidence cell for a
region the model does not know, and any non-finite coefficient, region risk,
or loading. Those used to pass the checksum and fail at the first quote — which
meant readiness reported a model that could not price.

Rebuild it with:

```bash
python scripts/train_rainfall_model.py
```

### What the model actually is

`scripts/train_rainfall_model.py` reads `data/rainfall-history.json` — daily
precipitation for every known region over the thirty most recent complete
years — rolls each coverage window across the *training years only*, measures
how often the trigger would have fired, and fits three things, each of which
the data demanded:

1. **A linear model of trigger log-odds** on log threshold, log window length,
   and one fitted effect per region. The region effect is what the artifact
   carries as `regionRisk`: log-odds, driest region at zero, unit coefficient.
   A single "mean rainfall" feature was tried first and could not hold a desert
   and a tropical city on one line. The region means are kept in
   `training.regionMeanMmPerDay` as the plain-units description of the same
   climates.
2. **A seasonal offset per region and calendar month** (`seasonRisk`), fitted
   on the residuals of the linear model and centred at zero per region. At
   quote time it is applied in proportion to the share of the window falling
   in each month, so a thirty-day window starting on 20 March is one third
   March and two thirds April, and a full year sees almost none of it.
   Amplitudes are what the climates say: ±1.7 log-odds in Cartagena and ±1.6
   in Santiago, ±1.0 in Sevilla and Valencia, ±0.2 in Lima.
3. **An evidence floor per region and grid cell** (`evidenceFloor`): the
   one-sided 95% lower confidence bound of the trigger frequency observed on
   the training years. A quote is never priced below the bound of any cell it
   *dominates* — same region, a window at least as long, a threshold at least
   as low — because the true probability is monotone in both. This is what
   holds the long-window, moderate-threshold products the linear form cannot
   reach: a 30 mm day in Valencia within any given year is close to certain,
   and twenty-four training years prove it far better than a fitted slope
   does. The response says when the floor set the price
   (`pricedFromEvidence`); on the holdout it does so for 12% of windows.

The premium is the resulting probability times one plus the loading. The
runtime evaluates all three from the artifact alone, in plain Python.

**The data is observed, not synthetic.** It is ERA5 reanalysis served by the
Open-Meteo Historical Weather API: assimilated observations, not a random draw
from a distribution somebody chose. The artifact says so in its `training`
block (`kind: "observed"`, `transitional: false`), and readiness reports the
same three facts so an operator can tell which model an instance is running and
what it was trained on.

### How it is evaluated

The split is by calendar date, not at random, and it moves with the data: the
six most recent complete years are held out (currently 2020–2025) and the
twenty-four before them are fitted. A random split would leak the holdout's
weather into training through overlapping windows and flatter the model.

Scoring uses proper scoring rules — log-loss and Brier — computed by the
runtime's own evaluator with each window's real start date, so the numbers
describe the code path that prices, not a re-implementation of it. Every
superseded artifact is kept in `app/models/artifacts/archive/` and scored on
the *same* holdout, which is what makes the comparison a comparison:

| Model | Data | Holdout log-loss | Holdout Brier | Predicted / observed trigger rate | Cells under-priced with 95% confidence |
| --- | --- | --- | --- | --- | --- |
| `baseline-premium-v3` | observed, seasonal, evidence floor | **0.1640** | **0.0506** | 0.124 / 0.101 | **6** of 448 |
| `baseline-premium-v2` | observed, region effects | 0.1761 | 0.0551 | 0.107 / 0.101 | 16 |
| `baseline-premium-v1` | synthetic | 0.3022 | 0.0837 | 0.022 / 0.101 | 167 |

The synthetic model under-priced by more than four times on the years it was
never fitted to. That is the number this stage exists to produce, and it is
regenerated — and checked for drift — on every gate run; the full figures are
in `app/models/artifacts/baseline-premium-v3.metrics.json`.

The same scores are reported **per region**, **per duration**, **per start
month**, and **per grid cell**, because each level hides what the one above it
cannot see: an aggregate can hide one region, a region can hide one duration,
a duration can hide one month.

The risk-acceptance policy is stated where it is enforced, in the tests:

- **Solvency, per region, per duration, and per start month.** Over the six
  held-out years, what the pool would have charged (`loadedPremiumRate`, the
  predicted rate times 1.35) must be at least what it would have paid
  (`observedTriggerRate`) in every region, at every duration in the grid
  pooled across regions and thresholds — which is how the long windows with
  six holdout observations per cell get a real sample — and in every start
  month for windows of a month or less. All pass; the synthetic model failed
  the first in every wet region.
- **Cells, judged by what their sample can prove.** A cell is under-priced
  *with confidence* when the loaded premium is below the one-sided 95% lower
  bound of its observed frequency. Six of six proves 0.607, not 1.0, and the
  criterion says so. The bar is to stay within what chance alone would flag
  for a perfectly calibrated model — with 448 cells at 95%, about 22, and 30
  as the bound — because zero is a promise no honest model can make about six
  years of weather. This release flags 6; the previous observed one flagged
  16; the synthetic one 167. The six are named in the metrics file: Valencia
  and Sevilla at 90–365 days and 30–80 mm, where 2020–2025 was wetter than
  the record the floor was built from.

Two things remain visible and recorded rather than hidden. Lima is still
over-predicted (0.015 against 0.001 observed) — the buyer pays for risk that is
not there, though far less than before. And extrapolation was not fixed by
widening the training grid: that was measured, and it degraded calibration on
the domain most policies live in, so the response flags it instead.

### Which models a deployment may serve

`staging`, `testnet`, and `production` refuse to start on anything but an
artifact that says `kind: "observed", transitional: false` with the evidence
behind it. The archived synthetic model, or an artifact with no provenance,
boots a laptop and never a deployment. The one override is
`MODEL_ALLOW_TRANSITIONAL=true`: named, defaulted off, logged as a warning at
startup, and readiness keeps reporting the model's real provenance while it is
in effect.

### The dataset

`data/regions.json` is the registry: the eight regions the model knows, with the
coordinates they were fetched at. `data/rainfall-history.json` is the observed
series for each — committed, checksummed, and validated on load (shape, day
count, no negatives, no missing days, nothing above the physically plausible
daily maximum, a named source). It names its own range in `datasetVersion`,
currently `rainfall-history-1996-2025`. It is the only network product in the
module, and it is produced deliberately rather than by any gate:

```bash
python scripts/fetch_rainfall_history.py
```

The window rolls: thirty complete years ending at the most recent complete
calendar year at the time of the fetch, so a refresh refreshes the evidence
instead of re-downloading the same decades. The gate enforces a freshness
policy — a dataset more than two complete years behind the latest fails it — so
the refresh is a planned act each year rather than a slow drift nobody noticed.
A refresh is a model release: retrain, review the metrics diff, commit the
dataset, the artifact, and the metrics together.

A refresh that returns the same observations leaves the file byte-identical, so
`git status` reports a change in the source and never a mere re-run. A refresh
that returns something the loader refuses — a boolean, a NaN, a shifted
calendar, a missing day, an impossible value — is rejected value by value
before anything is built, and the new file is written beside the old one and
verified before it replaces it, so a bad fetch cannot destroy the dataset the
gate depends on. Adding a region means adding it to the registry, refetching,
and retraining; the registry is validated on load (canonical keys, coordinates
in range) and the gate fails if it and the dataset disagree.

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
| `MODEL_ALLOW_TRANSITIONAL` | Deployed profiles only: serve a non-observed model anyway. Off by default; logged when on. |
| `WEATHER_API_*` | Reserved. The Stage 08 source needs no key; left for a provider that does. |

Validation is fail-fast: an unknown profile, an out-of-range port, or a provider
that does not exist is rejected at startup rather than at the first request.

## Commands

```bash
python -m venv .venv                          # once
pip install -r requirements.txt

python scripts/train_rainfall_model.py        # release: retrain the artifact from data/
python scripts/train_rainfall_model.py --check  # verify only; writes nothing
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

Runs lint, format, dataset integrity (checksum, shape, agreement with the
region registry, and freshness), a retrain in check mode that must reproduce
the committed artifact and metrics byte for byte without writing either, the
test suite, and a real startup that binds a socket and serves a quote. The test
suite alone would not prove the packaged entrypoint boots, which is why the
last step exists. `scripts/stage7_check.py` is the Stage 07 subset and still
runs, also in check mode, but the gate is `stage8_check.py`.

Nothing in the gate reaches the network: a gate that could pass or fail on a
remote service's mood is not a gate.

CI runs the same command on Python 3.11 — the floor in `pyproject.toml` — so an
incompatibility with the oldest supported version is caught here rather than by
whoever installs it next.
