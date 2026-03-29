# Infrastructure Module

Infrastructure assets for local development and CI workflows.

## Planned Contents

- `docker/` Dockerfiles for backend and ML service
- `compose/` local and test compose profiles
- CI workflows will live in root `.github/workflows/` when CI is enabled

## Standards

- Keep build contexts minimal.
- Never store secrets in repository files.
- Use reproducible commands for local and CI execution.
