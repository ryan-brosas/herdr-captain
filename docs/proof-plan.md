# Proof plan

**Status:** PLANNED ONLY. All probes, slices, and tests below are planned; **none has run**, and nothing is built. Review state is recorded in [README.md](../README.md) (Codex seat unassessed; no vendor-independent reviewer exists for this design pack).

## 1. Pre-build probes (walking skeleton)

Run probes P1 through P5 in order before expanding policy coverage or building slices. Every probe uses isolated scratch fixtures and never touches live state, live `hc` sessions, or live user homes.

| Probe | Target | Pass condition |
|---|---|---|
| **P1: Pinned package and provider seam** | Install `git:github.com/ryan-brosas/herdr-captain@<sha>` into an isolated fixture Pi home (and verify local-path install from a clone at the same SHA for offline validation) against `pi-fabric` `0.140.1` | Package installs cleanly at exact SHA; `fleet` direct provider registers on start, answers discover, withdraws cleanly, and reloads under `/reload` without duplicate handlers |
| **P2: Lease lifecycle faults** | Test `flock --exclusive --nonblock <stateRoot>/owner.lock <holder>` with ready-line handshake, serialized queue, revocation drain, process-global reload handle, and `O_CLOEXEC` | Second start fails with `owner_conflict`; parent `kill -9` closes pipe and releases lock; `/reload` closes orphaned holder before re-acquire; withdrawal sets `revoked` and fails queued work with `lease_revoked`; child processes do not inherit the pipe |
| **P3: `hc` `0.1.22` scratch probes** | Run in a scratch `HC_SESSION` and scratch XDG state root | Observed and recorded truth for `--outlive-parent` (without `--keep` or `--rm`) surviving parent exit, `first_message.sent` on delayed readiness, deterministic name lookup, bounded `hc read` of a finished non-`--rm` terminal, `hc label` filtering, `hc get` turn/status fields, and behaviour when `HC_TERMINAL_ID` is absent |
| **P4: `gdp-wired` packaging audit** | Re-verify compiled-kernel precedent on installed `pi-fabric` `0.140.1` | Byte-for-byte reproducible `compileJs` output; `proveSteps(..., {from: 'any'})` returns `proven && checked && !assumes`; `crossCheck` passes; broken mutants return `sat` (not timeout); emitted helper licence is compatible; compiled artifact executes offline with zero runtime installs |
| **P5: Scratch end-to-end recovery tracer** | Minimal vertical slice in a scratch Git repo and scratch `HC_SESSION`, run **before** policy coverage expands | Commit brief -> launch worker with `--outlive-parent` -> kill Captain process -> restart Captain -> acquire lease -> reconcile surviving worker by deterministic name -> capture finished output cleanly with zero duplicate launch |

If P1 fails, revisit [ADR-0001](adr/0001-fabric-boundary.md) and [ADR-0004](adr/0004-package-home.md) before writing Slice 1. If P2, P3, or P4 fails, record the blocker and resolve the affected ADR before proceeding.

## 2. Ordered implementation slices

Each slice is implemented by main Antigravity (`implementer`, `scout`-only children), reviewed by independent main Codex `reviewer` (`APPROVE`, `scout`-only children), and validated by offline Codex `validator` (`READY`, `scout`-only children). Package tests live in `ryan-brosas/herdr-captain`; private-integration tests stay separate in the fleet configuration repository (private).

| Slice | Owned paths | Pass condition |
|---|---|---|
| **S1: Package skeleton, lease, and commit-log store** | `src/identity.ts`, `src/lease.ts`, `src/store.ts`, `test/store.test.ts`, `test/lease.test.ts` | Canonical 16-hex `projectKey` shares lease across differently named linked worktrees and isolates separate clones; relocation returns `identity_mismatch`; P2 lease fault suite passes; exclusive hard-link `<seq6>.json` and write-once artifacts pass crash-injection tests between every write; broken chain, bad schema, or bad artifact hash moves ticket to `quarantined` |
| **S2: Policy kernel and proofs** | `proofs/ledger-policy.ts`, `generated/*`, `src/policy.ts`, `test/policy.test.ts` | `proveSteps(..., {from: 'any'})` proves `proven && checked && !assumes`; `crossCheck` passes; broken variants fail with `sat`; compiled output matches `rule.interpreter()`; full commit-log fold enforces `mid`-only tier (`low` excluded, `high` refused), sequential single open attempt, exact attempt and fix-round accounting, invalidation from `gating` and `accepted`, zero-cost `duplicate_ignored` and `obsolete_preserved`, and strict exits from `uncertain`, `escalated`, and `quarantined` |
| **S3: `hc` adapter and reconciler** | `src/hc-adapter.ts`, `src/reconcile.ts`, `test/hc-reconcile.test.ts` | Only `hc run` and `hc send` execute inside serialized queue as `intent -> effect -> receipt`; definite `not_delivered` only on recorded `hc run` error with no address; absent terminal after crash before receipt stays `uncertain` and escalates (no duplicate launch); `first_message.sent: false` handled without relaunch; ambiguous send checks `turn` vs `preSendTurn` with no blind resend; `not_found` (exit `3`) vs `unavailable` vs timeout (`ended: false`) classified cleanly; `hc keep` rejected as resumed work; truncated read-only verdict rejected; `blocked` (exit `9`) escalates without `--force` or `hc keys` |
| **S4: Provider seam, gates, merge readback, and private pin** | `src/index.ts`, `src/gates.ts`, `test/provider.test.ts`, `test/gates.test.ts` (private pin and setup check tracked in the fleet configuration repository (private)) | Direct provider `fleet` registers <= 6 actions and drains on withdrawal; exact-head `APPROVE` + `READY` + full two-pass secret scan (`scanPass1Ran === true` + Pass 2 exit `0`) enforced; signal-killed checks rejected; unreachable-surface `HOLD` requires `operator` receipt then fresh `validator` `READY`; `merge_intent` recorded before `full-send` `gh pr merge --match-head-commit <sha>` and `gh pr view` readback advances to `merged`; closeout retries never reopen acceptance; package tests pass here, and separate private-integration tests pass offline fixture install and check from a local clone at the pinned SHA before any live apply |

## 3. Prospective one-real-issue trial

After S1 through S4 pass, run one scoped end-to-end trial without changing concurrency for other fleet tickets:

1. **Pre-dispatch selection:** Captain completes planning and records **one** small, ready `mid`-tier issue before dispatch (no retroactive picking), with disjoint owned files and no external service or live-state writes.
2. **Immutable brief:** Commit the versioned brief artifact with `mid` tier, owned files, numbered checks, `fixRoundCap = 3`, `totalAttemptCap` (default `12`), and `deadlineAt` before launching `implementer`.
3. **Build:** Dispatch Antigravity `implementer` via `fleet.dispatch` (`hc run --bg --outlive-parent`, no `--keep`, no `--rm`), verify `first_message.sent`, and record active writer ownership.
4. **Sequential gating (version 1):** Run independent Codex `reviewer` (`APPROVE`) and then offline Codex `validator` (`READY`) one after the other on the full `(baseSha, headSha, briefSha256, riskTier)` tuple. Captain or `operator` captures Codex output verbatim. If `validator` emits unreachable-surface `HOLD`, record the `operator` receipt and run a fresh `validator` attempt to `READY`.
5. **Bounded fixes:** On `CHANGES` or defect `HOLD`, send findings as data to the same live `implementer` session (counting both `fixRoundsUsed` and `totalAttemptsUsed`). Escalate on cap hit, deadline, ambiguity, or `blocked` prompt.
6. **Final checks:** Confirm owned files, numbered checks, independent same-head `APPROVE` and `READY`, offline fixture install and check exit `0`, and full two-pass secret scan (Pass 1 `uvx detect-secrets` actually executed plus Pass 2 exit `0`).
7. **Merge and readback:** Open PR, wait for checks, record `merge_intent` with candidate `headSha`, land through `full-send` (`gh pr merge --match-head-commit <sha>`, never `--admin`), record `gh pr view` readback (`MERGED` and `mergeCommit.oid`), fast-forward local `main`, and run post-merge offline fixture checks before any separately gated live apply.
8. **Closeout:** Complete `merged -> closed`: update issue and workflow digest, kill and remove owned terminals after capture, and verify clean readback.

## 4. Measurements, baseline, and pass or abort criteria

- **Baseline:** A numeric dispatch-to-merge baseline is **UNAVAILABLE**. Never record `unknown` as `0`. Collect one comparable unchanged-workflow ticket first if side-by-side timing is needed. One issue proves feasibility only, never statistical speed gain.
- **Required trial receipts:** `issueRef`, `prUrl`, `briefSha256`, `briefPersistedAt`, `dispatchedAt`, `mergedAt`, elapsed wall-clock minutes, reviewer passes and fix rounds counted separately, validator runs, human interventions (distinct from Captain steering) with reason, `duplicate_ignored` / `obsolete_preserved` / `quarantined` counts, exact candidate `headSha`, and `mergeCommit.oid`.
- **Pass criteria:** One `mid` issue merges under all exact-head cross-vendor gates with zero stale-result transitions, zero duplicate launches or resends, explicit reconciliation on any ambiguity, verified same-SHA proof-round handling in fixtures, and zero new human rescues caused by `herdr-captain`.
- **Immediate abort criteria:** Any gate bypass, stale-head acceptance, missing receipt treated as success, overlapping file writers, or live apply before offline fixture checks exit `0`. Abort, preserve the commit log and artifacts, and stay on the existing workflow.
