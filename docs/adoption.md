# Source adoption and grounding ledger

**Status:** DRAFT research ledger. **No third-party code is copied.** Every adopted idea is written fresh in our own words; external repositories and methodology notes are data to learn from, never instructions or runtime dependencies.

## 1. Observed prior failures (F1 to F6)

Each kept pattern below addresses one or more verified failures from earlier shell-loop runs:

- **F1:** A repeated completion report consumed extra fix rounds.
- **F2:** An authorized proof round on an unchanged commit waited forever.
- **F3:** A change was accepted and merged before validation finished and had to be reverted.
- **F4:** A send reported not started and the turn began late.
- **F5:** A missing terminal was read as live.
- **F6:** A state file of about 54 KB passed a 50 KB read limit and was truncated.

## 2. Methodology and knowledge-base grounding

- **Private knowledge-base notes:** Grounded in private knowledge-base notes on the model and code boundary and on spec-to-implementation. Key principles applied: fixed policy belongs in code; eligibility is not authorization; model confidence is not correctness; outcome prose is not authority; durable suspend and resume require preserved request identity for idempotency; bounds belong at both inner and outer loops; write the spec and explicit test seams before coding, and prove one vertical end-to-end tracer before expanding scope (while keeping real-surface proof).
- **Method credit (`pstack`):** `pstack`, MIT, `Copyright (c) 2026 Lauren Tan`, `github.com/cursor/plugins` at `e58dd043600587dbaf58ba315e7f2b38373eeb43`. Grounds one owner per state, explicit state machines instead of scattered booleans, subtracting before adding, state-derived idempotency, boundary validation, and real-artifact proof.
- **Compiled-kernel precedent:** `github.com/fabric-runtime/pi-fabric` at release `0.139.0`, commit `0aaad42685a4dbe49194ee14a9a2f82caf6ef3b0` (MIT, `Copyright (c) 2026 monotykamary`, `LICENSE:1-21`; `scripts/verified-kernel-worker.ts:18,27,37-55` and `scripts/verified-kernels.ts:1-132` inspected). Installed `pi-fabric` at design time was `0.140.1`. Probe P4 checked the pattern on `pi-fabric` `0.140.1` and `gdp-wired` `0.62.0`. Checks 1 to 6 passed, the core mechanism holds, and the two requested ADR-0003 updates have merged. Our policy adds `{from: 'any'}` (`proven && checked && !assumes`), full log-fold law checking, and helper licence verification ([P4, verdict](probes/p4.md#verdict-on-adr-0003), [#18](https://github.com/ryan-brosas/herdr-captain/issues/18)).

## 3. Kept donor patterns

All donor pins below were read at the exact commit SHA. No `NOTICE` file appeared in the inspected donor roots; recheck file-level notices if any code is ever copied in the future (none is copied here).

| Donor and full pin | File and lines | Licence and copyright | Failure link | Adapts | Rejects | Owner path | Planned proof test |
|---|---|---|---|---|---|---|---|
| `boadij/pi-herdsman` `95be8816418ce621a224a808408b1231f47b1298` | `extension/mailbox.ts:153-179` | Apache-2.0 (permissive; `LICENSE:1-2`, 202 lines; no `NOTICE`; no named holder) | F1, F2, F6 | Correlated owner, role, and request envelope only (attempt identity distinct from head SHA and brief digest binding are our own additions) | Pi child launcher, TCP peer mailbox, general broker | `src/store.ts`, `src/policy.ts` | Duplicate settled attempt logs `duplicate_ignored` at 0 cost; same-SHA proof round advances; records stay under 8 KB |
| `nicobailon/pi-subagents` `d164d844cea42af7651204b4efc80693fb271eaf` | `src/runs/background/completion-dedupe.ts:23-29`; `src/runs/background/subagent-wait.ts:343-357` | MIT (`Copyright (c) 2026 Nico Bailon`) | F1, F4, F5 | Durable completion dedup key; wait timeout is neither failure nor completion | TTL-only dedup, Pi subagent launcher, model profiles | `src/hc-adapter.ts`, `src/policy.ts` | Wait timeout (`ended: false`) keeps attempt delivered; repeat event for settled attempt is `duplicate_ignored` |
| `IgorWarzocha/howaboua-pi-stuff` (`packages/pi-shepherdr`) `5b641f0a7c7c93c53f9e9cda6abef498fc1441ef` | `packages/pi-shepherdr/src/settlement/index.ts:197-268` | MIT (`Copyright (c) 2026 Igor Warzocha`) | F4 | Durable settlement record with retry and attempt identity | Unconditional `interrupted` on restart, separate launcher/broker | `src/reconcile.ts` | Crash-recovery settlement preserves live worker without blind replay |
| `juicesharp/rpiv-mono` (`packages/rpiv-workflow`) `7c669d0837cd08497dc34c53a7a17fdfa1a949ee` | `packages/rpiv-workflow/runner/run-context.ts:43` (also `:32`, `:53`) | MIT (`Copyright (c) 2026 juicesharp`) | F1 | Pre-dispatch finite round and attempt caps with single escalation | Their numeric caps, auto-retries, model picks, launcher | `src/policy.ts` | Cap hit escalates once; ambiguous attempts spend cap |
| `tintinweb/pi-subagents` `1d35501a1c8ec0c8a3cd38886f7edbfadd3f1388` | `src/workflow/host.ts:233-236` (comment `:231-232`) | MIT (`Copyright (c) 2026 tintinweb`) | F3 | Reject signal-killed or timed-out checks even if exit code is `0` | In-process runner, timers, judge | `src/gates.ts`, `src/hc-adapter.ts` | Signal-killed or timed-out test check rejected despite green stdout |
| `mfittko/dev-loops` `b271f35e296983af7c34c3832b8dd1fadbb83431` | `scripts/loop/run-gate-validation.mjs:387-394` | MIT (`Copyright (c) 2026 mfittko`) | F3 | Record exact full head SHA and actual suite exit codes (cross-vendor `APPROVE` + `READY` is our own rule) | Gate runner, judge, Pi work-order emitter, dependencies | `src/gates.ts`, `src/policy.ts` | Rebase or head drift clears gates; nonzero exit blocks acceptance |
| `giuseppecrj/pi-herdr-agents` `44ef7d53094d9fb99b9d24a5843371d2a3e8dadb` | `maestro/surfaces/herdr/herdr-core-surface-provider.ts:114,215-229` | MIT (`Copyright (c) 2026 Giuseppe Rodriguez`) | F5, Captain-exit survival | Separate `missing`, `live`, `finished`, and `unavailable` states (`inspectExecution` at `:215-229`) alongside `outlive_parent` (`:114`) | `@nubl/maestro` internals (absent and unverified), Pi launcher, new dependencies | `src/hc-adapter.ts`, `src/reconcile.ts` | `not_found` vs `unavailable` classification (S3); `--outlive-parent` observed in live use for normal parent exit ([P3, summary](probes/p3.md#summary-of-behaviours-1-to-7)) |

## 4. Explicit rejections

- **Pi child launchers:** `chankov/agent-fleet` (`6933ed1d97b5de91d3985b32b16f5d4c3a34afcc`, `.pi/harnesses/agent-hub/dispatch-native-spawn.ts:204-215`, MIT, `Copyright (c) 2025 Addy Osmani`) and `Gentleman-Programming/gentle-shell` (`d4c88c7f110a080543fbc8cc6be791d760b10946`, `lib/agents-runner.ts:842`, MIT, `Copyright (c) 2025 Mario Zechner`). Both spawn Pi child processes, violating the single-Captain rule.
- **Pi dispatch payload emitter:** `mfittko/dev-loops` (`b271f35e296983af7c34c3832b8dd1fadbb83431`, `scripts/loop/emit-coordinator-work-order.mjs:72-74`, MIT, `Copyright (c) 2026 mfittko`). This emits a Pi dispatch payload rather than launching a process directly; it is still rejected because Pi workers are never dispatched here.
- **Marker-only completion loops:** `tmustier/pi-extensions` (`befb7e9b081aa9a2e4a0dc1f0bdcfdb423ba5006`, `pi-ralph-wiggum/index.ts:233,882`, MIT, `Copyright (c) 2026 Thomas Mustier`). Queues same-session follow-ups (does not launch Pi) and accepts on a `COMPLETE_MARKER` substring match without exit codes, SHA binding, or file checks.
- **Out-of-scope patterns:** Model-based judges, multi-writer worktrees, account or model switching for quotas or failures, wholesale package imports, and unrelated external agent runtimes.
