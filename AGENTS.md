# Working in this repository

Orientation for any assistant — human or AI — arriving without context. This
file is a map, not a manual: it says where things are and which rules apply.
It deliberately duplicates nothing, so the documents it points to remain the
only source of truth.

## What this is

ClimateChain is a parametric climate micro-insurance platform: Solidity
contracts hold coverage and pay out on rainfall triggers, a NestJS backend
operates them over JSON-RPC, and a Python service prices premiums from a model
artifact. The product rationale is in `docs/Guide.md`; the module layout and
toolchain are in `README.md`.

## Where to look first

| Question | Read |
| --- | --- |
| What is being built, and why | `docs/Guide.md` |
| How work is organised, and the rules every change must follow | `docs/Implementation-Step-By-Step.md` — sections 1 through 2.6 are **mandatory** |
| Which stage is current, and which are done | `README.md` → "Current Stage", then `docs/stage-reports/` |
| Why a given decision was made | The relevant `docs/stage-reports/stage-XX-*.md`, section "Decisions made"; then `git log` — commit bodies explain the *why* |
| How to run things locally | `docs/runbooks/local-stack.md` (contracts + backend), each module's `README.md` |
| How to run against a public testnet | `docs/runbooks/sepolia-testnet.md` |
| The backend's published HTTP contract | `docs/api/backend-openapi.json` (generated — never edit by hand; `npm run api:export` in `backend/`) |
| What the backend and ML service must agree on | `shared/contracts/pricing-request-vectors.json` — executed by both services' test suites |
| Contract ABIs and deployment addresses | `shared/abi/` and `contracts/deployments/` (both generated; the gates check for drift) |

Read the stage report for the stage you are touching **before** changing code.
Each one records what was tried, what was rejected, and what was deliberately
deferred to a later stage. Reopening a settled decision without that context is
the most common way to undo work.

## The rules, in one paragraph

Every stage has one gate command and it must be green before the stage is
closed. No mocks on any runtime path outside tests. Each stage must consume and
validate the outputs of earlier stages, not sit beside them. Commits follow
`<type>(<scope>): <imperative summary>` with a body explaining why. All of this
is specified precisely in `docs/Implementation-Step-By-Step.md`; this paragraph
is a reminder, not a substitute.

## Verifying your work

One command per module. Run the one for every module you touched, and the
backend gate whenever the contracts change.

| Module | Command | Notes |
| --- | --- | --- |
| `contracts/` | `npm run stage4:check` | Needs Slither (`pip install slither-analyzer`) |
| `backend/` | `npm run stage6:check` | Needs a local node: see `docs/runbooks/local-stack.md` |
| `backend/` (no chain) | `npm run stage5:check` | The chain-free subset |
| `ml-service/` | `python scripts/stage7_check.py` | Rebuilds the model artifact and fails on drift |

CI runs the same gates on every push to `main`; a change that passes locally
and fails in CI is usually a platform difference, and the workflows under
`.github/workflows/` say which.

## Things that are easy to get wrong here

- **Money is never a float.** Amounts cross every boundary as decimal strings
  and are computed as integers in wei. Both the backend and the ML service
  enforce this; `shared/contracts/pricing-request-vectors.json` pins the exact
  acceptance rules.
- **The two services must accept identical inputs.** Field names matching is
  not enough — the shared vectors exist because the services disagreed on
  dates, whitespace, and numeral systems while every schema-shape check passed.
  Add a vector when you add a rule.
- **Generated files are checked, not edited.** ABIs, deployment manifests, the
  OpenAPI document, and the ML model artifact are all produced by commands and
  verified for drift by the gates. Edit the source, rerun the generator.
- **`.env` files are yours and stay local.** Copy from `.env.example`; never
  commit one, never read another person's. No stage so far requires secrets
  for local work.
- **Windows path length.** Clone into a short path; see `README.md` → Quick
  Start. A deep clone fails the contracts gate with an unrelated-looking error.
- **A lone surrogate cannot be written to a UTF-8 file.** `write()` truncates
  the target before failing. Tests that need one build it with `chr(0xD800)`.

## When you finish a stage

Write `docs/stage-reports/stage-XX-<name>.md` with the exact sections listed in
`docs/Implementation-Step-By-Step.md` § 2, update "Current Stage" in
`README.md`, and make sure the gate and CI are green. A stage is not complete
until its report exists.
