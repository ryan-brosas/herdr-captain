# herdr-captain

`herdr-captain` is a standalone Pi package that adds deterministic, crash-recoverable ticket execution on top of `pi-fabric` and `herdr-core` (`hc`). It gives one user-started Pi Captain a project-scoped append-only commit log, a single-owner process lease, and exact-head acceptance gates. Existing workflow documents, GitHub issues, and skills keep planning, research, grilling, readiness, and multi-ticket pacing.

## Status

Probes P1 through P4 have run. Probe P5 has not run yet, and no implementation slice is built. This repository holds design documents, probe records in `docs/probes/`, and probe code under `probes/`. It also holds the P1 package stub (`package.json` and `src/index.ts`) ([docs/proof-plan.md](docs/proof-plan.md#1-pre-build-probes-walking-skeleton), [#28](https://github.com/ryan-brosas/herdr-captain/issues/28)).

- **P1:** Checks 1 to 5 passed in both normal and poisoned-environment runs ([P1, summary](docs/probes/p1.md#summary)).
- **P2:** Complete. The holder-process owner lease works on Linux under Bun. Rules `(a)` through `(f)` each need a design change before Slice S1 ([P2, verdicts](docs/probes/p2.md#verdicts-for-section-5-rules-a-to-f)).
- **P3:** Completed with gaps and design changes. Observed in live use on `hc` `0.1.22`, with no scratch `hc` session ([P3, method](docs/probes/p3.md#method-and-why-no-scratch-core-was-used)).
- **P4:** Checks 1 to 6 passed, and the core mechanism holds. The two requested ADR-0003 updates have merged ([P4, verdict](docs/probes/p4.md#verdict-on-adr-0003), [#18](https://github.com/ryan-brosas/herdr-captain/issues/18)).
- **P5:** Not run yet. Part 1 tests a recovery tracer against a fake `hc`. Part 2 waits for the owner's go-ahead before one live run under P3's rules ([#7](https://github.com/ryan-brosas/herdr-captain/issues/7)).

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
| [docs/proof-plan.md](docs/proof-plan.md) | Probes P1 to P5, build order, slices S1 to S4, one-issue trial, pass and abort rules | Active |
| [docs/probes/](docs/probes/) | Result documents for probes P1 to P4 | Recorded |

## How it will be consumed

The fleet configuration repository (private) will consume this public repository (`ryan-brosas/herdr-captain`) through one Pi `packages` entry pinned to a full commit SHA:

```text
git:github.com/ryan-brosas/herdr-captain@<sha>
```

Per Pi `docs/packages.md` (git sources and pinning), git commit pins stay fixed under `pi install` and `pi update --extensions`. Rollback restores the previous commit SHA. Offline validator fixtures will install from a local clone at the exact same SHA using Pi's local-path package source.

This public repository will hold only source code, proofs, the compiled policy artifact with its manifest, tests, and documentation. Credentials, fleet policy or configuration, briefs, receipts, logs, session files, and incident evidence never belong here. Package tests live here; private-integration tests stay in the fleet configuration repository (private). See [docs/adr/0004-package-home.md](docs/adr/0004-package-home.md).

## Review state

Two model review seats (Claude, Gemini) and an advisor attack on the planning brief and on the draft are complete, and their findings are folded into this revision. The third seat (Codex) declined under the vendor-independence rule because a GPT model co-wrote the planning brief; it is recorded as **unassessed**, never as approval. Planning text came from OpenAI and Anthropic models and the design text from Gemini, so no vendor-independent reviewer exists for this pack. That note covers the initial design pack only. Probes P1 through P4 have since run, and no implementation slice is built yet ([docs/proof-plan.md](docs/proof-plan.md#1-pre-build-probes-walking-skeleton)).

## Next steps

Follow the build order in [docs/proof-plan.md](docs/proof-plan.md#build-order):

1. Merge the P2 lease updates and the proof-plan update, then start **Slice S1**. S1 does not wait for probe P5 ([#8](https://github.com/ryan-brosas/herdr-captain/issues/8), [#20](https://github.com/ryan-brosas/herdr-captain/issues/20), [#28](https://github.com/ryan-brosas/herdr-captain/issues/28)).
2. Run **Probe P5**. Test the recovery tracer against a fake `hc`. Wait for the owner's go-ahead before its one live run under P3's rules ([#7](https://github.com/ryan-brosas/herdr-captain/issues/7)).
3. Decide how a worker sees an `attemptId` and returns it ([#27](https://github.com/ryan-brosas/herdr-captain/issues/27)).
4. Build **Slices S2, S3, and S4** after their gates merge, then run the one-issue trial ([docs/proof-plan.md](docs/proof-plan.md#2-ordered-implementation-slices)).

## Licence

MIT. See [LICENSE](LICENSE).
