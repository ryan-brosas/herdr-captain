# ADR-0004: Public standalone Pi package and pinned private consumption

**Status:** PROPOSED (separates accepted user direction from proposed package and consumption wiring; design draft, not implementation approval).
**Date:** 2026-11-27.

## Context

Storing reusable execution-ledger code inside the fleet configuration repository (private) mixes general Pi extension code with private operational rules, forces private setup allowlists to track extension internals, and couples package tests to private fleet fixtures. At the same time, private credentials, fleet policies, briefs, receipts, logs, session files, and incident evidence must never enter a public repository.

## Decision

### Accepted user direction

1. Host the extension in the public repository `ryan-brosas/herdr-captain` as a standalone Pi package.
2. Keep strict separation between public package contents and private fleet configuration, runtime state, and incident records.
3. Publish nothing to package registries or upstream repositories without the user's explicit ask.

### Proposed technical mechanism

1. **Public repository contents:** `ryan-brosas/herdr-captain` owns `src/`, `proofs/`, `generated/` (compiled policy artifact and manifest), `test/`, and `docs/`. It never stores credentials, fleet policy or configuration, operational briefs, receipts, logs, session files, or incident evidence.
2. **Pinned private consumption:** The fleet configuration repository (private) consumes `herdr-captain` through one Pi `packages` entry pinned to a full commit SHA:
   `git:github.com/ryan-brosas/herdr-captain@<sha>`
   (Pi `docs/packages.md`, git sources, commit pinning, `pi install`, and `pi update --extensions`). Rollback restores the previous commit SHA. Probe P1 confirmed pinned-commit install end to end, checking out the exact SHA and passing all `fleet` provider checks on `pi-fabric` `0.140.1` ([docs/probes/p1.md](../probes/p1.md#adr-0004-standalone-package-and-pinned-consumption), finding 3).
3. **Offline fixture parity:** Offline validator fixtures in the fleet configuration repository (private) install from a local clone at the exact same commit SHA using Pi's local-path package source, requiring zero network access during validation. Zero runtime `dependencies` in `package.json` is a tested property: local-path `pi install` passes online and offline inside `unshare -rn` ([docs/probes/p1.md](../probes/p1.md#adr-0004-standalone-package-and-pinned-consumption), finding 1). A local-path install stores a path relative to `settings.json`, so fixtures reading `settings.json` must expect relative paths ([docs/probes/p1.md](../probes/p1.md#adr-0004-standalone-package-and-pinned-consumption), finding 2).
4. **Separate test and issue ownership:** Package unit, proof, and scratch-`hc` tests live in `ryan-brosas/herdr-captain`. Private-integration tests and fleet-side integration work (terminal watching, ticket pipeline, resume after stop, launch readback) stay owned by the fleet configuration repository (private)'s existing open issues, named by role only.

## Alternatives considered

- **In-tree inside the fleet configuration repository (private):** Rejected. Mixes reusable extension code with private fleet rules, complicates setup allowlists, and prevents clean standalone package testing.
- **Publishing to npm:** Deferred. Adds registry release overhead and requires the user's explicit ask before any external publication; pinned git commit SHAs already provide immutable versions and simple rollback.

## Consequences

- **Benefits:** Clean public/private boundary, independent package CI and proof checks, immutable SHA pinning with trivial rollback, and offline fixture parity from a local clone.
- **Costs and limits:** Rolling a package change into the private fleet requires bumping the pinned commit SHA in the fleet configuration repository (private) and running its separate integration check. In probe P1's pinned-commit install, the post-clone step added no packages. Zero npm registry fetches for `herdr-captain` is inferred from the zero-dependency manifest, not measured ([docs/probes/p1.md](../probes/p1.md#adr-0004-standalone-package-and-pinned-consumption), finding 3).

## Revisit conditions

Pinned-commit install and `fleet` provider checks held on `pi-fabric` `0.140.1` in probe P1, so its revisit rule did not trigger ([docs/probes/p1.md](../probes/p1.md#adr-0004-standalone-package-and-pinned-consumption), finding 3). Captain and user should revisit this ADR if the user asks to publish `herdr-captain` to npm, if Pi's git package pinning semantics change, or if a later Pi or `pi-fabric` release breaks pinned-commit install in fixture Pi homes.
