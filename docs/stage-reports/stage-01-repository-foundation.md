# Stage 01 - Repository Foundation

## Scope completed

- Objective achieved: Established the foundational monorepo baseline and module boundaries for ClimateChain.
- Purpose and value: Provide a clean, scalable starting point that reduces onboarding friction and prevents early architecture drift.
- Functional result: Repository skeleton, module docs, and environment templates are in place for staged development.
- Created the initial monorepo directory structure for contracts, backend, ML service, infrastructure, shared assets, and docs support folders.
- Added baseline project documentation files at root and module level.
- Added module-specific `.env.example` files for contracts, backend, ML service, infrastructure, and shared.
- Finalized ignore-rule baseline to keep documentation and stage reports versioned.
- Added minimal bootstrap placeholders for backend and ML service entrypoints.

## Files changed

- `README.md`
- `.gitignore`
- `.dockerignore`
- `contracts/README.md`
- `contracts/.env.example`
- `contracts/hardhat.config.ts`
- `backend/README.md`
- `backend/.env.example`
- `backend/src/main.ts`
- `ml-service/README.md`
- `ml-service/.env.example`
- `ml-service/serve.py`
- `infra/.env.example`
- `infra/README.md`
- `shared/.env.example`
- `shared/README.md`

## Decisions made

- Keep the repository split by domain responsibilities to minimize coupling.
- Use explicit module-level README files to document ownership and standards.
- Start with placeholders for runtime entrypoints to reduce ambiguity before full framework initialization.
- Keep environment templates per module to avoid mixed configuration concerns.
- Keep `docs/` tracked in git to preserve architecture records and mandatory stage reports.

## Commands executed

- Directory scaffolding and file creation were performed with workspace tooling.
- Tree verification executed via shell command:
  - `find . -maxdepth 4 -type f | sort`

## Tests executed and results

- No runtime or unit tests executed in this stage.
- Structural validation completed by listing created files and directories.

## Risks or pending items

- `hardhat.config.ts` is a placeholder and requires full plugin/network configuration in Stage 02.
- Backend and ML entrypoints are placeholders and require framework bootstrap in later stages.
- Package manifests (`package.json`, `requirements.txt`) are not created yet.

## Credentials status

- Credentials required now: No.
- Credentials list: None for repository scaffolding.
- Purpose: Stage 01 is structural and documentation-focused; credentials are deferred to integration and deployment stages.

## Next stage handoff notes

- Stage 02 should initialize the contracts workspace with Hardhat dependencies, contract skeletons, and baseline tests.
- After Stage 02, ABI artifacts strategy for `shared/abi` should be defined.

## Amendment (audited before Stage 06)

A re-audit of the Stage 01 exit deliverable ("working repository skeleton")
against a fresh clone found two defects. Both are fixed.

- A1: The documented module structure did not survive a clone. `ml-service/app/*`,
  `ml-service/tests`, `ml-service/notebooks`, `infra/compose`, `infra/docker`,
  and `shared/schemas` existed only as empty directories, and git does not track
  those. `git ls-files` returned zero entries for every one of them, so a new
  contributor cloning the repository received none of the layout this stage
  claims to deliver. Added `.gitkeep` placeholders naming what each directory is
  for and which stage fills it.
- A2: `ml-service/requirements.txt` did not exist, while the root README
  instructed contributors to run `pip install -r requirements.txt`. The
  documented onboarding command failed outright. Added a baseline
  `requirements.txt` (pydantic, pydantic-settings, python-dotenv, pytest) that
  Stages 07 and 08 extend. The `pydantic` floor is 2.11 because earlier releases
  ship no `pydantic-core` wheel for Python 3.13 and fall back to a Rust source
  build that fails on a clean machine — verified by installing into a throwaway
  virtual environment on Python 3.13.0.

Verification: `python -m venv` + `pip install -r requirements.txt` completes
(exit 0), all four packages import, and `pytest tests` runs (exit 5, no tests
collected yet, as expected before Stage 07).
