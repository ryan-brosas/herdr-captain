# herdr-captain

`herdr-captain` is a standalone Pi package that adds deterministic, crash-recoverable ticket execution on top of `pi-fabric` and `herdr-core` (`hc`). It gives one user-started Pi Captain a project-scoped append-only commit log, a single-owner process lease, and exact-head acceptance gates. Existing workflow documents, GitHub issues, and skills keep planning, research, grilling, readiness, and multi-ticket pacing.

## Status

This repository holds a **design draft** only. Nothing is built, no code is installed, and no test has run. Runtime claims are either cited from observed package documentation or labelled `PROPOSED` or `TO BE PROBED`.

Observed tool versions at design time: `pi-fabric` `0.140.1` (compiled-kernel precedent inspected at `0.139.0`, commit `0aaad42685a4dbe49194ee14a9a2f82caf6ef3b0`), `hc` `0.1.22`, `util-linux` `flock` `2.42.4`, and `gh pr merge --help` listing `--match-head-commit`. `jev-fabric` `0.8.0` was observed and is unused in version 1.

## Document index

| File | Scope | State |
|---|---|---|
| [README.md](README.md) | Overview, consumption, review state, next steps | Draft |
| [AGENTS.md](AGENTS.md) | Project-local instructions for coding agents | Draft |
| [CONTEXT.md](CONTEXT.md) | Execution glossary and avoided terms | Draft |
| [docs/architecture.md](docs/architecture.md) | Scope, Fabric seam, identity, commit log, lease, transitions, recovery, boundaries | Draft |
| [docs/adr/0001-fabric-boundary.md](docs/adr/0001-fabric-boundary.md) | Direct Fabric provider boundary and single execution owner | Proposed |
| [docs/adr/0002-recovery.md](docs/adr/0002-recovery.md) | Worker survival, holder-process lease, commit log, readback recovery | Proposed |
| [docs/adr/0003-deterministic-policy.md](docs/adr/0003-deterministic-policy.md) | Compiled `gdp-wired` transition kernel and advisory-only future Jev | Proposed |
| [docs/adr/0004-package-home.md](docs/adr/0004-package-home.md) | Public standalone Pi package and pinned private consumption | Proposed |
| [docs/adoption.md](docs/adoption.md) | Prior failures F1 to F6, method credits, donor pins, explicit rejections | Draft |
| [docs/proof-plan.md](docs/proof-plan.md) | Ordered probes P1 to P5, slices S1 to S4, one-issue trial, pass and abort rules | Planned |

## How it will be consumed

The fleet configuration repository (private) will consume this public repository (`ryan-brosas/herdr-captain`) through one Pi `packages` entry pinned to a full commit SHA:

```text
git:github.com/ryan-brosas/herdr-captain@<sha>
```

Per Pi `docs/packages.md` (git sources and pinning), git commit pins stay fixed under `pi install` and `pi update --extensions`. Rollback restores the previous commit SHA. Offline validator fixtures will install from a local clone at the exact same SHA using Pi's local-path package source.

This public repository will hold only source code, proofs, the compiled policy artifact with its manifest, tests, and documentation. Credentials, fleet policy or configuration, briefs, receipts, logs, session files, and incident evidence never belong here. Package tests live here; private-integration tests stay in the fleet configuration repository (private). See [docs/adr/0004-package-home.md](docs/adr/0004-package-home.md).

## Review state

Two model review seats (Claude, Gemini) and an advisor attack on the planning brief and on the draft are complete, and their findings are folded into this revision. The third seat (Codex) declined under the vendor-independence rule because a GPT model co-wrote the planning brief; it is recorded as **unassessed**, never as approval. Planning text came from OpenAI and Anthropic models and the design text from Gemini, so no vendor-independent reviewer exists for this pack. This pack is documentation only: nothing is built and no test has run.

## Next steps

Run the five pre-build walking-skeleton probes in [docs/proof-plan.md](docs/proof-plan.md) before writing Slice 1:

1. **P1:** Install by pinned git SHA into a fixture Pi home and prove `fleet` provider register, withdraw, and `/reload`.
2. **P2:** Fault-test the `flock` holder lease under second start, parent `kill -9`, `/reload`, and withdrawal with queued work.
3. **P3:** Probe `hc` `0.1.22` in a scratch `HC_SESSION` (`--outlive-parent`, `first_message.sent`, deterministic name lookup, finished terminal read, absent `HC_TERMINAL_ID`).
4. **P4:** Audit `gdp-wired` compiled-kernel packaging, `{from: 'any'}` proof (`proven && checked && !assumes`), helper licence, and offline execution against installed `pi-fabric` `0.140.1`.
5. **P5:** Run a scratch end-to-end recovery tracer (launch, kill Captain, return, reconcile) before expanding policy coverage.

## Licence

The licence is not chosen yet.
