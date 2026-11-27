# herdr-captain agent guide

`herdr-captain` is a public standalone Pi package for deterministic single-Captain execution tracking over `pi-fabric` and `herdr-core` (`hc`).

## Read before proposing changes

1. Read [CONTEXT.md](CONTEXT.md) and the ADRs in [docs/adr/](docs/adr/) before proposing any design or code change.
2. Use the exact terms defined in [CONTEXT.md](CONTEXT.md) and avoid the rejected synonyms listed there.

## Repository layout

- [README.md](README.md): project overview, consumption contract, review state, and next steps.
- [CONTEXT.md](CONTEXT.md): execution glossary for this repository.
- [docs/architecture.md](docs/architecture.md): architecture, data model, state machine, crash recovery, and boundaries.
- [docs/adr/](docs/adr/): architectural decision records (`0001` to `0004`).
- [docs/adoption.md](docs/adoption.md): prior failures F1 to F6, method credits, donor pins, and rejections.
- [docs/proof-plan.md](docs/proof-plan.md): pre-build probes P1 to P5, slices S1 to S4, and trial protocol.
- Future implementation paths: `src/`, `proofs/`, `generated/`, and `test/` (none exist yet).

## Issues and public hygiene

- Track work in this repository's GitHub issues.
- This repository is public. Never commit runtime state, session files, logs, operational briefs, receipts, private fleet configuration, or secrets.

## Build and tests

No build or test command exists yet because this repository contains only design documents. Add the real commands here when Slice 1 lands.
