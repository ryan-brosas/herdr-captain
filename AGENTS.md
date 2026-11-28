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
- [docs/probes/](docs/probes/): result documents for probes P1 to P4 ([docs/proof-plan.md](docs/proof-plan.md#1-pre-build-probes-walking-skeleton)).
- [probes/](probes/): probe scripts and fixtures under `probes/p1/`, `probes/p2/`, and `probes/p4/` ([P1](docs/probes/p1.md), [P2](docs/probes/p2.md), [P4](docs/probes/p4.md)).
- [package.json](package.json) and [src/index.ts](src/index.ts): minimal package stub from probe P1 ([P1, environment](docs/probes/p1.md#environment-and-fixture-isolation)).
- Future implementation paths: `proofs/`, `generated/`, and `test/` do not exist yet ([docs/proof-plan.md](docs/proof-plan.md#2-ordered-implementation-slices)).

## Issues and public hygiene

- Track work in this repository's GitHub issues.
- This repository is public. Never commit runtime state, session files, logs, operational briefs, receipts, private fleet configuration, or secrets.
- A probe result document may quote commands, exit codes, and outputs of its own fixtures and stand-in terminals. For real work sessions, it gives counts and field values only, never a verbatim output or receipt ([P3, method](docs/probes/p3.md#method-and-why-no-scratch-core-was-used), [#28](https://github.com/ryan-brosas/herdr-captain/issues/28)).

## Build and tests

Run the test suite with:

```bash
bun run test
```

This runs `bun test ./test` on Linux with Bun 1.4.0 or newer, no install, and no external dependencies. Older Bun releases reap a killed child and run its exit callback during `spawnSync()`, so tests cannot hold an unreaped zombie holder before that callback runs. The owner lease tests also require `util-linux` `flock` with `--no-fork` and `--conflict-exit-code`, plus readable Linux `/proc`. No package build or type-check command exists yet; Slice S1 adds no development dependencies ([#8](https://github.com/ryan-brosas/herdr-captain/issues/8)).
