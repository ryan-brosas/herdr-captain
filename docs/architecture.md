# Architecture

**Status:** DRAFT design. Nothing is built and no test has run. Runtime claims are cited from observed documentation (`pi-fabric` `0.140.1`, `hc` `0.1.22`, `util-linux` `flock` `2.42.4`, `gh pr merge --help`) or marked `PROPOSED` or `TO BE PROBED`.

Terms used here follow [CONTEXT.md](../CONTEXT.md). Decisions live in [adr/](adr/).

## 1. Scope, governance, and non-goals

Existing workflow documents, GitHub issues, and skills own product exploration, grounding, grilling, glossary ownership, ADRs, issue readiness, dependency ordering, and multi-ticket pacing. `herdr-captain` adds deterministic ticket execution reliability on top of `pi-fabric` and `herdr-core` (`hc`). It consumes one workflow-authorized brief per tracked ticket and enforces proved state transitions, attempt correlation, readback reconciliation, and exact-head gates.

### Roles and harnesses

- **Pi Captain:** One user-started main session per project. Plans, writes briefs, decides, merges, and runs live apply alone. Never implements code and never starts another Pi session through `hc`, shell, template, or script.
- **Antigravity (`implementer`):** Sole code and config writer and implementation test runner. Native children are read-only `scout` sessions only.
- **Codex (`reviewer` and `validator`):** Independent non-writer `reviewer` (offline read-only sandbox) and scratch fixture `validator` (offline workspace-write scratch sandbox). Native children are read-only `scout` sessions only. Main Codex alone judges and prints verdicts.
- **Existing Fabric routes:** Approved Fabric routes (`operator` and read-only scouts) stay unchanged. Fleet-side integration (terminal watching, ticket pipeline, resume after stop, launch readback) stays owned by existing open issues in the private fleet configuration repository.

### Governance rules

1. Upstream changes to `pi-fabric` or `hc` happen only for a demonstrated reusable gap, and nothing is upstreamed or published without the user's ask.
2. The user owns product direction and new-project approval; the Captain decides engineering detail and records why.
3. Never switch accounts or models to get around a quota or a failure.
4. Issue dependencies block only the dependent work and never grant authorization.

### Non-goals

`herdr-captain` does not build a second planning engine, a background daemon, a replacement Captain, a process manager, a multi-ticket scheduler, a digest renderer, or an LLM acceptance judge.

## 2. Components and the Fabric provider seam

`herdr-captain` is a standalone Pi package in `ryan-brosas/herdr-captain` with future source paths under `src/`, `proofs/`, `generated/`, and `test/` ([ADR-0004](adr/0004-package-home.md)).

```text
+----------------------------------------------------------------------+
| Existing Workflow (Issues, skills, ADRs, private fleet config)       |
| Owns: planning, grilling, tier, readiness, dependencies, digest,     |
| PR creation, full-send merge, captures, closeout                     |
+----------------------------------+-----------------------------------+
                                   | authorized brief + evidence
                                   v
+----------------------------------------------------------------------+
| Pi Captain Session (one user-started main session per project)       |
|  +----------------------------------------------------------------+  |
|  | herdr-captain package (Fabric direct provider "fleet")         |  |
|  |  - src/index.ts      : provider registration (<= 6 actions)    |  |
|  |  - src/policy.ts     : wrapper over generated/ gdp-wired kernel|  |
|  |  - src/lease.ts      : flock holder process + serialized queue |  |
|  |  - src/store.ts      : project ID, commit log, artifacts       |  |
|  |  - src/hc-adapter.ts : hc run / hc send effects + readback     |  |
|  |  - src/reconcile.ts  : startup and uncertain-effect reconciler |  |
|  |  - src/gates.ts      : pure exact-head acceptance evaluator    |  |
|  +------+--------------------------+--------------------------+---+  |
|         | public Fabric events     | local FS + flock holder  | CLI  |
+---------|--------------------------|--------------------------|------+
          v                          v                          v
  pi-fabric 0.140.1         ${XDG_STATE_HOME:-$HOME/.local/     hc 0.1.22
  (direct provider events;   state}/herdr-captain/<projectKey>/ (terminals,
   no ticket authority)     (authoritative commit log)           waits)
```

### Fabric direct provider seam (`pi-fabric` `0.140.1`)

Version 1 uses **one** registration route: a direct Fabric provider named `fleet` registered through `FABRIC_PROVIDER_REGISTER_EVENT` and `FABRIC_PROVIDER_DISCOVER_EVENT`, and withdrawn through `FABRIC_PROVIDER_WITHDRAW_EVENT` (`pi-fabric` `0.140.1`, `docs/providers.md`, direct provider registration and withdrawal sections). There is no `pi.registerTool()` fallback branch in version 1; that fallback is a revisit condition only if probe P1 fails ([ADR-0001](adr/0001-fabric-boundary.md)). Provider register, withdraw, and reload drain behaviour is `TO BE PROBED` in P1.

The provider exposes six closed-schema actions (`PROPOSED`):

| Action | Role | External effect |
|---|---|---|
| `fleet.claim` | Acquire owner lease, verify `project.json`, run startup reconciliation | Starts `flock` holder |
| `fleet.brief_commit` | Persist immutable brief (or revision), validate `mid` tier and caps | Local store write only |
| `fleet.dispatch` | Run one managed `hc` effect as `intent -> effect -> receipt` | `hc run` or `hc send` |
| `fleet.record` | Persist artifact and commit evidence, `merge_intent`, `gh pr view` readback, closeout, invalidation, or user decision | Local store write only |
| `fleet.reconcile` | Read live `hc`, `git`, or `gh` state to resolve an uncertain effect without launching or resending | Read-only inspection |
| `fleet.status` | Fold the ticket commit log and return current phase, open attempt, gates, and counters | Read-only fold |

### External effects and Fabric runtime boundaries

- **Two extension-owned effects:** `herdr-captain` executes **only** `hc run` and `hc send`, both inside the per-project serialized queue as `intent -> effect -> receipt`.
- **Workflow-owned effects:** Merging stays in the existing `full-send` skill using `gh pr merge --match-head-commit <sha>`; the ledger commits `merge_intent` before the merge and the `gh pr view` readback after it. PR creation, terminal captures, and closeout steps stay in existing skills and enter the ledger as evidence. The extension renders no digest; the Captain's digest stays workflow-owned and is never gate input.
- **No Jev in version 1:** Version 1 includes zero Jev integration ([ADR-0003](adr/0003-deterministic-policy.md)).
- **Non-authoritative Fabric surfaces:** Durable shell tasks detach and reattach to the owning session (`pi-fabric` `0.140.1`, `docs/background-tasks.md`, detach and reattach section); they carry process output, never ticket authority. Other Fabric programs, Jev runs (`docs/jev.md`, durability section), `state.*` mesh logs (single head whose non-current transitions and certificates can age out, `docs/state-layer.md`, history retention section), and event streams are session-owned and not authoritative ticket storage.
- **Rejected transport:** Do not use `agents.transport: "herdr-core"`. `pi-fabric` `0.140.1` (`docs/agents.md`, herdr-core transport section) documents that its launches disable typed parent notifications, waiting, keep and recovery, and outliving the parent, and Fabric children are never fleet workers here.

## 3. Project identity and state root

Every project ledger lives outside all Git repositories at:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/herdr-captain/<projectKey>/
```

### Identity derivation

1. Resolve `canonicalCommonDir = realpath(git rev-parse --git-common-dir)`. Fail closed outside a Git repository.
2. Compute `projectKey = sha256(canonicalCommonDir).slice(0, 16)` (first 16 lowercase hex characters). The directory name is `<projectKey>` alone, with no folder-name prefix.
3. Persist `project.json` (`schemaVersion: 1`, under 2 KB) containing readable `slug`, full `canonicalCommonDir`, full `commonDirSha256`, and observed `originUrl`.
4. **Worktree sharing and clone isolation:** Linked worktrees of one clone resolve to the same `canonicalCommonDir` (git documents `--git-common-dir` as the directory shared by all linked worktrees), so they share one `projectKey`, one owner lease, and one execution ledger regardless of their folder names. Separate clones and distinct repositories with identical folder basenames hash to distinct keys and stay isolated. Symlinks resolve through `realpath`.
5. **Mismatch refusal:** On every open, compare stored `canonicalCommonDir` in `project.json` against live `canonicalCommonDir`. Any mismatch refuses to bind (`identity_mismatch`) and escalates; old records are never silently rebound. Origin URL drift logs a warning and blocks merge until the Captain confirms the target repository.
6. Every ticket and commit record carries both `projectKey` and `issueRef` (`<owner>/<repo>#<number>`).

## 4. The commit log

Each tracked ticket has **one** append-only commit log and a directory of write-once content-addressed artifacts (`PROPOSED`):

```text
<stateRoot>/
  project.json
  owner.lock
  owner.json
  tickets/<issue>/
    artifacts/<sha256>.md        # write-once briefs, reports, verdicts, receipts
    log/000001.json              # append-only commit records (< 8 KB each)
    log/000002.json
```

`<issue>` is the issue number from the ticket's `issueRef`; one `projectKey` maps to one repository, so the number is unique inside it. There is no `state.json`, no previous-state snapshot, no separate `events/` directory, no mutable `attempt.json`, and no rendered digest file.

### Commit record contract

Every record in `tickets/<issue>/log/<seq6>.json` stays under 8 KB and contains:

- `schemaVersion` (`1`)
- `seq` (strictly monotonic 1-based integer matching `<seq6>`)
- `prevRecordSha256` (genesis sentinel for `seq = 1`, else SHA-256 of `<seq-1>.json`)
- `time` (ISO-8601 UTC timestamp)
- `ownerEpoch` (fencing epoch copied from `owner.json`)
- `event` (transition event name and disposition when applicable)
- `attemptId` (unique per ticket, formed from the monotonic `attemptSeq` counter; present when the record concerns an attempt)
- `intent` or `receipt` (exact authorized payload or observed receipt summary)
- `evidenceRefs` (array of `{ kind, sha256, bytes, truncated }`)
- `countersAfter` (`attemptSeq`, `totalAttemptsUsed`, `fixRoundsUsed`)
- `phaseAfter` (ticket phase and open attempt state after the transition)

### Exclusive creation, effect ordering, and load fold

1. **Write-once artifacts first:** Write each brief, captured report, verdict, validation output, operator receipt, or scan receipt to `artifacts/<sha256>.md` (`temp -> fsync -> link -> unlink -> dir fsync`) **before** committing the record that references it. Orphan artifacts left by a crash before commit are harmless.
2. **Exclusive commit record (`PROPOSED`):** Write a temp file in `log/`, `fsync` the temp file, hard-link it to `<seq6>.json` (which fails with `EEXIST` if that sequence number already exists), `unlink` the temp file, and `fsync` the `log/` directory.
3. **Effect ordering:** Commit the intent record (`seq`), execute the external effect, then commit the receipt record (`seq + 1`). A log whose last record for an attempt is an intent without a matching receipt is an **uncertain effect**.
4. **Fold on every load:** Recompute current ticket phase, open attempt state, active writer, gates, and counters by folding `log/000001.json` through the last record through the compiled policy kernel on every load. Finite attempt and fix caps bound total record count, keeping every file well below the 50 KB read limit that caused failure F6 ([adoption.md](adoption.md)).
5. **Fail-closed quarantine:** A parse error, missing sequence gap, broken `prevRecordSha256` chain, unknown `schemaVersion`, natural-number bound error, bad artifact SHA-256, or violated policy-kernel state law transitions the ticket to `quarantined` without overwriting damaged files. Corrupt state never falls back to an empty state.

## 5. The owner lease

Atomic `temp + fsync + rename` prevents torn files on crash, not concurrent writers. Version 1 uses one OS-backed mutual exclusion mechanism: a holder child process started by the extension on Linux local filesystems ([ADR-0002](adr/0002-recovery.md)):

```text
flock --exclusive --nonblock <stateRoot>/owner.lock <holder>
```

The holder prints one ready line to stdout and then blocks reading stdin. The extension keeps the write end of that stdin pipe open. Intended lifetime (`PROPOSED`, proved in P2): the lease exists **exactly** while the holder lives. If the parent process dies, the pipe closes, the holder reads EOF and exits, and the kernel releases the lock when the holder's descriptor closes (documented `flock(2)` behaviour).

Lease rules:

- **(a) No stealing:** If `flock` fails to acquire, fail closed immediately with `owner_conflict`. Never steal an active lease and never take over by TTL.
- **(b) Fencing epoch:** Only after reading the holder's ready line, read `owner.json`, verify `projectKey`, increment `epoch = prev.epoch + 1`, and write `owner.json` (`schemaVersion`, `projectKey`, `epoch`, `pid`, `holderPid`, `acquiredAt`) via `temp -> fsync -> rename` plus directory `fsync`. Copy `epoch` into every commit record.
- **(c) Serialized queue (`PROPOSED`, gated on P2):** Maintain one in-process serialized queue per `projectKey`. Every store write and every external effect runs inside this queue and re-checks `revoked === false`, holder alive, and `owner.json.epoch === localEpoch` immediately before the write and immediately before the effect.
- **(d) Revocation drain (`PROPOSED`, gated on P2):** On provider withdrawal, session shutdown, holder exit, or `/reload`, set `revoked = true` first, let the serialized queue drain (pending items fail closed with `lease_revoked`), and then close the holder stdin pipe.
- **(e) Reload cleanup (`PROPOSED`, gated on P2):** Register the active holder handle on a process-global map keyed by `projectKey` so a reloaded extension instance closes any orphaned holder before acquiring a new lease.
- **(f) Non-inheritance (`PROPOSED`, gated on P2):** Workers are spawned by the `hc` server rather than by the extension process, and the extension opens the holder pipe close-on-exec (`O_CLOEXEC`).
- **(g) Platform scope:** Linux local filesystems only. `util-linux` `flock` (`2.42.4` observed) is a host prerequisite verified at startup, not a package dependency. NFS and remote filesystems are unsupported.

The holder lifetime and items (c) through (f) are `PROPOSED` and must pass the P2 lifecycle fault probes before any slice builds on them.

### Separate worker write ownership

Worker write ownership is derived from the open `implementer` attempt in the commit log (`attemptId`, `terminalId`, `worktreePath`, `ownedFiles`), not from `owner.json`. Captain exit or crash does not clear worker write ownership. Before allowing a brief revision or a replacement writer, reconciliation must verify through `hc` that the prior implementer terminal is finished or stopped/idle with no in-flight turn.

## 6. Two-level state model and transition table

One pure compiled `gdp-wired` policy kernel ([ADR-0003](adr/0003-deterministic-policy.md)) governs both ticket phases and attempt states.

### Model summary

- **Ticket phases (12):** `drafted`, `ready`, `building`, `gating`, `fix_needed`, `accepted`, `merging`, `merged`, `closed`, plus `escalated`, `quarantined`, `abandoned`.
- **Attempt states (6):** `reserved`, `intent`, `delivered`, `settled` (with outcome), `uncertain`, `superseded`.
- **Record dispositions (not phases):** `duplicate_ignored`, `obsolete_preserved`, `not_delivered`.
- **Settled outcomes:** a verdict (`APPROVE`, `CHANGES`, `READY`, `HOLD`), a build or fix result, `not_delivered`, or `unusable`.
- **Roles:** `implementer` (build or fix), `reviewer`, `validator`.
- **Concurrency:** Version 1 allows **one open attempt per ticket** at a time. `reviewer` and `validator` run sequentially; parallel validation is a named revisit condition.
- **Tier scope:** Version 1 accepts `mid` tickets only. `low` stays on the existing workflow without the ledger. `high` is refused at brief commit until the user has decided.
- **Budgets:** Every opened attempt (launch or send, any role) increments `totalAttemptsUsed` by 1. Fix sends (`implementer` attempts opened from `fix_needed`) also increment `fixRoundsUsed` by 1. `duplicate_ignored` and `obsolete_preserved` records cost 0. Defaults: `fixRoundCap = 3` (existing fleet rule); `totalAttemptCap` required in the brief (proposed default `12`); `deadlineAt` required in the brief.

### Table 1: Ticket-phase transitions

| From phase | Event | Guard | To phase | Counters and gate effect |
|---|---|---|---|---|
| `drafted` | `brief_committed` | Valid schema, brief artifact written, `riskTier === "mid"`, `ownedFiles`, checks, caps, `deadlineAt` present (`low` uses workflow without ledger; `high` refused) | `ready` | Sets active `briefVersion`, `briefSha256`, `ownedFilesHash`; clears gates |
| `ready` | `attempt_opened(implementer, build)` | Lease valid, no open attempt, `totalAttemptsUsed < totalAttemptCap`, before deadline | `building` | Opens build attempt (`reserved -> intent`); `totalAttemptsUsed += 1` |
| `building` | `attempt_not_delivered` | Open build attempt settles `not_delivered` on authoritative `hc run` error receipt | `ready` | Open attempt cleared; `totalAttemptsUsed` stays charged (escalates if cap hit) |
| `building` | `build_settled` | Open `implementer` attempt settles with valid candidate `headSha`, matching brief/tier, non-truncated report | `gating` | Clears all gates (`review`, `validation`, `scan`); records `headSha` |
| `building` | `build_unusable` | Open `implementer` attempt settles `unusable` (report truncated, missing, or not matching the brief) | `fix_needed` | No gate change; the next fix send asks for the report again and is charged as a fix round |
| `gating` | `attempt_opened(reviewer)` | Lease valid, no open attempt, `reviewGate !== approved`, `reviewerVendor` disjoint from `writerVendors`, under `totalAttemptCap` and deadline | `gating` | Opens `reviewer` attempt; `totalAttemptsUsed += 1` |
| `gating` | `review_settled(APPROVE)` | Matches open `reviewer` attempt and exact candidate tuple; verbatim, non-truncated | `gating` | Sets `reviewGate = approved` |
| `gating` | `review_settled(CHANGES)` | Matches open `reviewer` attempt and exact candidate tuple; verbatim, non-truncated | `fix_needed` | Clears gates; records findings artifact |
| `gating` | `attempt_opened(validator)` | Lease valid, no open attempt, `validationGate !== ready`, (if `hold_unreachable`, `operatorReceipt` recorded), under `totalAttemptCap` and deadline | `gating` | Opens `validator` attempt; `totalAttemptsUsed += 1` |
| `gating` | `validation_settled(READY)` | Matches open `validator` attempt and exact tuple; offline fixture checks exit `0`, non-killed, non-truncated | `gating` | Sets `validationGate = ready` |
| `gating` | `validation_settled(HOLD_defect)` | Matches open `validator` attempt and exact tuple; defect finding | `fix_needed` | Clears gates; records hold findings |
| `gating` | `validation_settled(HOLD_unreachable)` | Matches open `validator` attempt; unreachable-surface hold | `gating` | Sets `validationGate = hold_unreachable`; awaits `operator` receipt then fresh `validator` attempt |
| `gating` | `operator_receipt_recorded` | `validationGate === hold_unreachable`, no open attempt, real check exit and command identity | `gating` | Attaches operator receipt artifact; does not set `ready` (fresh `validator` `READY` still required) |
| `gating` | `scan_recorded` | Exact tuple match; `scanPass1Ran === true` (exit `0`) and Pass 2 exit `0`, non-killed | `gating` | Sets `scanGate = pass` (skipped Pass 1 leaves `scanGate` unmet) |
| `gating` | `attempt_not_delivered` | Open `reviewer` or `validator` attempt settles `not_delivered` on authoritative error receipt | `gating` | Open attempt cleared; `totalAttemptsUsed` stays charged (escalates if cap hit) |
| `gating` | `gate_evidence_unusable` | Open `reviewer` or `validator` attempt settles `unusable` (capture truncated, missing, or not matching the exact tuple) | `gating` | Gate stays unset; a fresh attempt of that role is required and charged |
| `gating` | `gates_satisfied` | No open attempt; `reviewGate === approved`, `validationGate === ready`, `scanGate === pass` on identical full tuple | `accepted` | Pure computed transition; never hand-set |
| `fix_needed` | `attempt_opened(implementer, fix)` | Lease valid, no open attempt, same implementer session live and `status !== "blocked"`, `fixRoundsUsed < fixRoundCap`, `totalAttemptsUsed < totalAttemptCap`, before deadline | `building` | Opens fix send attempt (`preSendTurn` recorded); `totalAttemptsUsed += 1`, `fixRoundsUsed += 1` |
| `gating` or `accepted` | `candidate_invalidated(head_or_base)` | `headSha` or `baseSha` changed (rebase or integration); no open writer | `gating` | Clears all gates (`review`, `validation`, `scan`); binds new `(baseSha, headSha)` |
| `building`, `gating`, `fix_needed`, or `accepted` | `brief_or_scope_revised` | `briefSha256` or `ownedFilesHash` changed (tier stays `mid`; upward change to `high` refused/escalated); any prior writer confirmed stopped and marked `superseded` | `ready` | Clears all gates; commits new brief version |
| `accepted` | `merge_intent_committed` | Lease valid, no open attempt, `gatesSatisfied === true`, `headSha` unchanged, target repo confirmed | `merging` | Records exact candidate `headSha` before `full-send` runs `gh pr merge --match-head-commit <sha>` |
| `merging` | `merge_confirmed` | `gh pr view` readback confirms `state === "MERGED"` and `mergeCommit.oid` | `merged` | Locks merge outcome; separates acceptance from closeout |
| `merged` | `closeout_done` | Local `main` fast-forwarded, post-merge fixture checks exit `0`, issue and workflow digest updated, terminals killed/removed and read back clean | `closed` | Terminal phase; closeout retries never reopen merge or acceptance |
| Any active phase | `escalation_triggered` | Cap exhausted, deadline passed, `hc` `blocked` (exit `9`), upward tier to `high`, or unresolvable `uncertain` attempt or merge intent | `escalated` | Records `priorPhase` and single actionable reason; preserves branches and terminals |
| `escalated` | `user_resume_recorded` | Recorded user decision specifying `priorPhase` (and optional explicit positive integer raise to one cap) | `priorPhase` | Applies recorded cap delta; resumes from last verified step |
| `escalated` | `user_abandon_recorded` | Recorded user decision to stop tracking this ticket | `abandoned` | Terminal phase; preserves repository history |
| Any phase | `corruption_detected` | Broken hash chain, sequence gap, parse error, unknown schema, bad artifact hash, or policy law violation | `quarantined` | Halts all mutations and effects; never overwrites damaged files |
| `quarantined` | `user_repair_recorded` | Recorded user repair restoring a log that passes full hash, schema, and law fold | The phase the repaired log folds to | Resumes only after full clean fold |
| `quarantined` | `user_abandon_recorded` | Recorded user decision to abandon the quarantined ticket | `abandoned` | Terminal phase |

### Table 2: Attempt-lifecycle transitions

| From attempt state | Event | Guard | To attempt state | Accounting and disposition |
|---|---|---|---|---|
| (none) | `attempt_reserved` | Ticket phase allows opening this role; guards pass | `reserved` | Allocates monotonic `attemptId`; this is the single charge listed in Table 1 for `attempt_opened`, not a second one |
| `reserved` | `intent_committed` | Lease valid inside serialized queue | `intent` | Intent record committed before `hc run` or `hc send` |
| `intent` | `effect_confirmed` | `hc run` returns `terminalId` with `first_message.sent === true`, OR `hc send` confirms turn advance | `delivered` | Receipt committed; binds active writer if role is `implementer` |
| `intent` | `launch_failed_authoritative` | `hc run` returns error with no terminal address and receipt is recorded | `settled` (`not_delivered`) | Record disposition `not_delivered`; cap stays charged |
| `intent` | `effect_ambiguous` | Crash before receipt, registry save failure, `first_message.sent === false`, or ambiguous send (`started: false`/`null`) | `uncertain` | Enters readback reconciliation; no blind relaunch or resend |
| `delivered` | `evidence_captured` | Matches active `attemptId`, exact brief/tier, turn advanced or exited, non-truncated | `settled` (with outcome) | Advances ticket phase per Table 1 |
| `delivered` | `evidence_unusable` | Capture truncated, missing, or not matching the attempt's brief and tuple | `settled` (`unusable`) | No gate effect; ticket moves per Table 1 (`build_unusable` or `gate_evidence_unusable`); a fresh attempt is charged |
| `delivered` | `terminal_missing` | `hc` returns exit `3` (`not_found`) before receipt capture | `uncertain` | Reconciles files/commits before escalating (prevents F5) |
| `delivered` | `attempt_superseded` | Brief/scope revision after prior writer confirmed stopped/idle | `superseded` | Clears active writer; prior outputs cannot satisfy new gates |
| `uncertain` | `reconcile_delivered` | Positive readback: deterministic-name lookup finds terminal with `first_message.sent === true`, or send `turn > preSendTurn` | `delivered` | Binds terminal and continues observation |
| `uncertain` | `reconcile_not_delivered` | Authoritative non-delivery evidence recorded (`hc run` error with no address) | `settled` (`not_delivered`) | Record disposition `not_delivered` |
| `uncertain` | `reconcile_unresolved` | Terminal absent after crash before receipt, blocked readiness, or send `turn === preSendTurn` with no confirmed delivery | `uncertain` (ticket -> `escalated`) | Never launches replacement on absence alone; never blind resends |
| `settled` | Repeat event for same `attemptId` | `attemptId` already settled | `settled` (unchanged) | Record disposition `duplicate_ignored`; 0 budget cost (prevents F1) |
| `superseded` | Late event for old `attemptId` / brief | `attemptId` superseded or brief obsolete | `superseded` (unchanged) | Record disposition `obsolete_preserved`; 0 budget cost; no gate effect |

## 7. Evidence binding and candidate head versus merge commit

Acceptance is a pure function over immutable commit records and content-addressed artifacts, never a hand-set flag or prose match.

### Bound tuple and required gates (`mid` tier)

Every gate binds to the exact tuple `(issueRef, briefVersion, briefSha256, riskTier, ownedFilesHash, baseSha, headSha, role, vendor, writerVendors)`:

1. **Independent review:** Codex `reviewer` `VERDICT: APPROVE` with `reviewerVendor` disjoint from every vendor in `writerVendors`, captured verbatim by Captain or `operator` (read-only Codex never writes report files).
2. **Independent offline validation:** Codex `validator` `VALIDATION: READY` on the identical tuple with offline fixture install and check exiting `0`. If `validator` emits an unreachable-surface `HOLD`, `operator` runs the named check and records an operator receipt; `validator` must then run as a fresh attempt, evaluate that receipt, and emit `READY`.
3. **Complete two-pass secret scan:** Pass 1 (`uvx detect-secrets` actually executed, `scanPass1Ran === true`, exit `0`) and Pass 2 (pattern pass, exit `0`). A zero exit with Pass 1 skipped is incomplete evidence and blocks merge.
4. **Real execution proof:** Every check records real command or suite identity, fixture identity, actual exit code, and non-killed/non-timed-out termination (preventing F3). Stdout phrases, idle panes, or exit `0` alone never satisfy a gate.

### Same-SHA proof rounds and invalidation

`attemptId` is distinct from `headSha`. Opening a fresh pre-reserved `attemptId` lets an authorized proof round proceed on an unchanged `headSha` (preventing F2), while repeating an already-settled `attemptId` records `duplicate_ignored` at zero cost (preventing F1).

Any change to `headSha`, `baseSha`, `briefSha256`, or `ownedFilesHash` clears all prior gates from both `gating` and `accepted`. An upward tier change to `high` escalates instead, because version 1 tracks `mid` tickets only. Late evidence from obsolete briefs stays in the log as `obsolete_preserved` and never satisfies the current candidate.

### Candidate head versus merge commit

GitHub documents that squash and merge-commit strategies create a new commit, so its SHA differs from the validated PR candidate `headSha`. This design never claims squash or merge preserves the same SHA and never transfers approvals by tree-hash equality.

Landing works in three recorded steps:

1. Commit `merge_intent` in the ledger with the exact candidate `headSha`.
2. Run the existing `full-send` skill using `gh pr merge --match-head-commit <sha>` (`--match-head-commit` observed in `gh pr merge --help`; live merge execution unrun in this draft).
3. Record the `gh pr view` readback confirming `state === "MERGED"` and `mergeCommit.oid`, moving the ticket to `merged`. Workflow then fast-forwards local `main`, runs post-merge offline fixture checks, and completes closeout (`merged -> closed`) before any separately gated live apply.

## 8. Crash windows and recovery

When the Captain exits or disconnects, workers launched with `hc run --bg --outlive-parent` (without `--keep` or `--rm`) may finish their already-authorized assignment. Captain absence forbids new dispatches, follow-up turns, replacement launches, or merges, and no daemon or replacement Captain runs.

`hc` `0.1.22` (`hc --skill` and receipt schema) documents that child terminals end with their parent unless launched with `--outlive-parent`, exit `3` is `not_found`, exit `9` is `blocked`, `hc send` refuses on `blocked` unless `--force`, `hc wait` timeout (`reason: timeout`, default 180 seconds) is a check-in with `ended: false`, `hc run` can suffer a registry save failure and advises checking `first_message.sent`, and `hc keep` replaces a lost program with a bare shell. The following behaviours are **TO BE PROBED** in P3 rather than assumed facts: `--outlive-parent` without `--keep` or `--rm` across parent exit, whether `$HC_TERMINAL_ID` disappears on exit and breaks `hc wait --children`, whether child replies to `$HC_TERMINAL_ID` are lost, `hc label` filtering, bounded `hc read` on finished non-`--rm` terminals, and `hc get` / send turn-field names.

Deterministic terminal names use `<projectKey>-<issue>-<role>-<attemptId>`. Labels are a convenience, never evidence.

| Crash window or failure | Authoritative readback | Safe disposition |
|---|---|---|
| `hc run` returns error with no terminal address | Recorded `hc run` error receipt | Settle attempt as `not_delivered` (the **only** path to definite non-delivery); cap stays charged |
| Crash after launch intent before receipt, or registry save failure | Lookup terminal by deterministic name; if found, read `first_message.sent` | Found + `sent: true` -> bind terminal, `delivered`. Found + `sent: false` -> read screen, resolve readiness or escalate; never duplicate launch. **Not found -> stay `uncertain` and escalate; never launch a replacement on absence alone** |
| Crash after send intent before receipt, or `started: false`/`null` (`TO BE PROBED`) | `hc get` (`turn` vs `preSendTurn`, `status`) + bounded `hc read` (screen text is untrusted data) | Never blind resend. If `turn > preSendTurn` -> `delivered`. Otherwise stay `uncertain` and escalate (prevents F4) |
| `hc wait` timeout, `not_found` (exit `3`), or RPC/`unavailable` error | Separate timeout (`ended: false`), exit `3` `not_found`, and `unavailable` | Timeout keeps `delivered`. `not_found` moves attempt to `uncertain` and reconciles files/commits before escalating (prevents F5). `unavailable` retries with bound, then escalates |
| Surviving worker finishes while Captain is absent | `hc get` + bounded `hc read` on finished non-`--rm` terminal (`TO BE PROBED`); check truncation | Persist artifact before commit record. Missing or truncated read-only verdict blocks gates and requires a fresh authorized review; never invent evidence. Kill/remove terminal only after verified capture |
| OS crash or `hc keep` replaces lost program with bare shell | Check `hc get` status/exit markers; refuse `--keep` on worker launches | Never treat a kept shell as resumed work. Reconcile partial files on disk and escalate or authorize a fresh attempt |
| Crash between artifact write, commit record, effect, and receipt | Fold `log/<seq6>.json` and check artifact hashes | Orphan artifact before commit is harmless. Log ending in intent without receipt is `uncertain`. Exclusive `<seq6>.json` prevents double consumption or dropped advancement |
| Crash after `merge_intent` before `gh pr view` readback | `gh pr view` for state, `mergeCommit`, and PR head SHA | `MERGED` -> commit `merge_confirmed`, enter `merged`. `OPEN` or ambiguous -> stay `uncertain` and escalate; never blind retry merge |
| Crash in `merged` before closeout finishes | Read `git status`, local `main` SHA, `hc ls --all`, issue state | Retry idempotent closeout steps only; never reopen acceptance or merge |
| Second Captain starts or stale owner fires | `flock` non-blocking lock + `owner.json.epoch` + `revoked` check inside serialized queue | Fails closed with `owner_conflict` or `lease_revoked`; stale owner never writes |
| Workflow digest disagrees with commit log | Fold ticket commit log | Digest carries zero gate authority; workflow regenerates it from the ledger |
| Worker enters `blocked` status (permission or trust prompt) | `hc get` (`blocked`) / exit `9` on `hc send` + `hc read` | Escalate to user. Never bypass with `hc send --force` or automated `hc keys` |

## 9. Enforcement boundary matrix

Provider-level controls reduce Captain errors; they are **not** a global OS security sandbox. No exactly-once external side-effect guarantee exists anywhere in this stack. Safety relies on intent-before-effect commits, monotonic attempt IDs, readback reconciliation, and fail-closed escalation.

| Boundary | Actual guard | Covered entry points | Known bypasses | Fail-closed behaviour |
|---|---|---|---|---|
| Single Captain and log writes | `flock` holder process + `owner.json.epoch` + serialized queue + exclusive hard-link `<seq6>.json` | All `fleet.*` actions | Direct shell edits to `<stateRoot>`, raw shell tools | Refuses writes (`owner_conflict` or `lease_revoked`); quarantines corruption |
| `hc` dispatch and sends | Pre-effect `revoked` and epoch recheck in serialized queue + deterministic names | `fleet.dispatch` | Raw shell invoking `hc` directly; Fabric `context.scope` is not enforced on adapters (`pi-fabric` `0.140.1`, `docs/providers.md`, scope section) | Refuses dispatch when lease invalid, cap hit, or open attempt exists |
| Worktree file writes | Open `implementer` attempt in commit log; Antigravity sole writer role | Managed `implementer` dispatches | Manual edits, uncoordinated shell commands | Blocks second writer or brief revision until prior writer confirms stopped |
| Read-only Codex isolation | Codex offline read-only OS sandbox + Captain/`operator` capture | Codex `reviewer` sessions | None inside Codex sandbox (writes and network blocked); `validator` writes scratch sandbox only | Missing or truncated capture blocks `APPROVE` and `READY` |
| Merge and branch gate | Pure `policy.ts` gate + `full-send` `gh pr merge --match-head-commit <sha>` + GitHub branch protection | `fleet.record(merge_intent)` + `full-send` | Raw `gh pr merge` from shell; `--admin` if user holds bypass rights | Refuses `merge_intent` on missing gate, SHA mismatch, or incomplete scan |
| Blocked permission prompts | `hc` refuses `send` on `blocked` unless `--force` (`hc` `0.1.22` `--skill`) | `fleet.dispatch` sends | Manual `hc send --force` or `hc keys` from raw shell | Escalates to user; never auto-forces |
| Deterministic transition laws | Compiled `gdp-wired` kernel + full log fold and law check on every load | All `fleet.*` transitions | Host code bypassing `policy.ts`; Fabric host policy resets on `/reload` (`pi-fabric` `0.140.1`, `docs/providers.md`, host policy section) | Quarantines invalid log (`quarantined`); proves modeled transitions only, never real delivery or report truth |

## 10. What version 1 leaves out

- **Parallel attempts per ticket:** Version 1 runs one open attempt at a time (sequential `reviewer` then `validator`); the fleet's current parallel validation is deferred.
- **`high`-tier ledger execution:** Refused at brief commit until the user decides its approval contract.
- **`low`-tier ledger enrollment:** `low` tickets stay on the existing workflow without the ledger.
- **Jev integration:** Deferred completely; any future use stays advisory only.
- **`pi.registerTool()` fallback:** Omitted from version 1; revisited only if probe P1 fails.
- **Digest rendering:** Stays workflow-owned outside this package.
- **Multi-ticket scheduling and daemonization:** Out of scope.
- **Non-Linux hosts and network filesystems:** `flock` holder lease targets Linux local filesystems only.
- **npm publication:** Deferred; requires explicit user authorization ([ADR-0004](adr/0004-package-home.md)).
