# Architecture

**Status:** DRAFT design. Nothing is built and no test has run. Runtime claims are cited from observed documentation (`pi-fabric` `0.140.1`, `hc` `0.1.22`, `util-linux` `flock` `2.42.4`, `gh pr merge --help`) or marked `PROPOSED` or `TO BE PROBED`.

Terms used here follow [CONTEXT.md](../CONTEXT.md). Decisions live in [adr/](adr/).

## 1. Scope, governance, and non-goals

Existing workflow documents, GitHub issues, and skills own product exploration, grounding, grilling, glossary ownership, ADRs, issue readiness, dependency ordering, and multi-ticket pacing.

`herdr-captain` adds deterministic ticket execution reliability on top of `pi-fabric` and `herdr-core` (`hc`). It consumes one workflow-authorized brief per tracked ticket and enforces proved state transitions, attempt correlation, readback reconciliation, and exact-head gates.

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
| `fleet.claim` | Read repo, acquire owner lease, re-read repo, publish or verify `project.json`, re-check lease, run startup reconciliation | Starts `flock` holder |
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
3. **Record, lease-first claim order, and publication:** Persist `project.json` (`schemaVersion: 1`, under 2 KB) with readable `slug`, full `canonicalCommonDir`, full `commonDirSha256`, observed `originUrl`, and sorted `rootCommitShas` (the parentless commits of every ref). `project.json` is written once and never rewritten. `rootCommitShas` is never empty; a stored record with an empty `rootCommitShas` is refused with `identity_mismatch` and is not accepted as old data.

   Identity writes only after it has acquired the owner lease, and it checks the lease right before each write (section 5, rule (c)). The check and the write are two steps, so an owner whose lock holder dies between them can still complete one link. No other write follows, because every later check fails. A claim runs in this order:
   1. Read the repo's common directory, the root commits of every ref, and its origin. Make no write.
   2. If the repository has no commit on any ref, refuse with `identity_unborn` before any write, leaving the state root unchanged. An unborn `HEAD` beside a branch with commits is not refused here.
   3. Acquire the owner lease for `projectKey` (section 5). The lease creates the project directory and writes its own files (`owner.lock`, `owner.json`).
   4. Inside the lease queue, read the repository again. If the key is no longer the acquired key, refuse with `identity_mismatch`. If no root commit is found because commits vanished after step 1, refuse with `identity_unborn`; only the lease's files were written.
   5. If the directory holds no `project.json`, run the relocation scan (item 6) and publish `project.json` as below. Otherwise verify the existing record (item 5).
   6. Every refusal after step 3 releases the lease before returning the error, except `lease_revoked`, which has no lease left to release.
   7. As the last step of every claim, run one more lease check (section 5, rule (c)) after the publication or verification. If the lease is no longer valid, the claim fails with `lease_revoked`, whatever it published or verified. No claim returns an open project before this check.

   A directory holding only the lease's files is a first publication, at this claim or any later one. A second process claiming the same project gets `owner_conflict` and writes nothing. A second claim inside one process follows section 5 rule (e): it revokes and drains the first lease, acquires the second at the next epoch, and runs step 4.

   To publish `project.json`, create a temporary file exclusively under a name unique to this call. Write and sync it. Hard-link it to `project.json` so an existing `project.json` is never replaced. Sync the directory. Remove the temporary only if this call created it. If the link found a `project.json` already there, verify that record (item 5) and write nothing. Then step 7 decides. A stale link cannot replace an existing record, and its claim fails with `lease_revoked` (step 7). Any record that link published is still a true record of the same repository, which the next owner verifies like any other. Identity never removes a file it did not create. A temporary left by a crashed call stays and is ignored.
4. **Worktree sharing and clone isolation:** Linked worktrees of one clone resolve to the same `canonicalCommonDir` (git documents `--git-common-dir` as the directory shared by all linked worktrees), so they share one `projectKey`, one owner lease, and one execution ledger regardless of their folder names. Separate clones and distinct repositories with identical folder basenames hash to distinct keys and stay isolated. Symlinks resolve through `realpath`.
5. **Verification and origin on open:** On every open of an existing `project.json`, all three checks must hold; if one fails, refuse with `identity_mismatch`:
   1. Stored `canonicalCommonDir` equals the live one.
   2. Stored `commonDirSha256` matches the directory name.
   3. The live repository and stored `rootCommitShas` share at least one root commit.

   After a refusal, `project.json` and the execution ledger stay unchanged. The lease's `owner.json` has a new epoch; that is the only write. The third check accepts a history that gained a root, and one that lost roots while at least one stored root remains. It shows lineage, not which clone this is (see item 6, limit 3).

   `originUrl` is stored at first publication for the reader. A different live origin adds a warning to the claim result, and the claim goes on. Version 1 has no confirmation for an origin change and no merge gate on origin drift here. Before any merge effect, Slice S4 must compare the target repository with the ticket's `issueRef`.
6. **Relocation refusal and limits (`PROPOSED`):** One clone at one path is one project. Version 1 has no rebind, no decision files, and no ancestry list. Refusing a moved clone is a best effort, not a guarantee (see the limits below).

   At first publication, inside the owner lease, scan the other `project.json` files under the state root. A record matches when it shares a root commit with the live repository and its stored `canonicalCommonDir` no longer exists on disk. Origin is not compared. On a match, refuse with `identity_relocated` and name the state directory of every matching record. `project.json` is not written, and the lease is released. A fresh clone made after the old clone was deleted meets the same refusal; this is intended because the old ledger may hold open tickets. A second clone whose original path still exists is a separate project and opens normally.

   **Manual remedy:** Version 1 has no command for this. Follow these steps in order:
   1. Stop every Captain on the old and new clones, and wait until their leases are released.
   2. Finish or stop every worker still running for a ticket of the old ledger; a worker outlives its Captain.
   3. Move every directory the error named out of the state root.
   4. Claim again. The clone then gets a new, empty execution ledger. The old ledger is not continued.

   **Limits (what version 1 does not protect):**
   1. A process that writes into the state folder without this package can damage or lose records.
   2. A manual change to the state folder, or a move of the repository, while a Captain runs can leave two owners. Do both only with every Captain stopped.
   3. A different repository at the same path that shares a root commit with the old one (a fork) opens the old ledger with its open tickets.
   4. Some moves are not seen: the clone has lost every stored root; the move happens while another claim is at its first publication; or something else now exists at the old path. The moved clone then starts a new, empty ledger without a refusal, and the old ledger stays on disk.
7. Every ticket and commit record carries both `projectKey` and `issueRef` (`<owner>/<repo>#<number>`).

### What Slice S1b must prove

Item 6 stays `PROPOSED` until these twelve proofs pass:

1. Two processes claim a new project at once, both held at a barrier before publication: one publishes, and the other gets `owner_conflict`. One `project.json` exists, with the winner's bytes. A later claim by the loser reads that record.
2. One process claims twice: the lease is handed over, the record is verified, and nothing is published a second time.
3. A crash at each step (after the lease, after the temporary is written, after the link and before the temporary is removed): the next claim publishes or opens, and no file was deleted.
4. The lock holder dies while the owner is paused before the link, and a second owner publishes. When the first owner resumes, its link fails, its claim fails with `lease_revoked`, and the second owner's record is unchanged. In the other order, the first owner's link lands first: its claim still fails with `lease_revoked`, and the second owner finds that record, verifies it, and opens. In a third case, the lock holder dies while the owner verifies an existing record, and a second owner opens: the first claim fails with `lease_revoked`, and the record is unchanged.
5. A leftover temporary, a foreign file, and a temporary whose name collides survive every claim. A failed exclusive creation removes nothing.
6. Each claim refused after the lease is acquired (`identity_mismatch`, `identity_relocated`, and `identity_unborn` at step 4) releases the lease: another process acquires it at once.
7. A path mismatch, a directory name that does not match the stored hash, and no shared root each give `identity_mismatch` with the record's bytes unchanged. An added root opens, and a removed root opens while one stored root is left, both with the record's bytes unchanged. A stored record with empty roots is refused.
8. No commit on any ref gives `identity_unborn` with the state root unchanged. An unborn `HEAD` beside a committed branch opens.
9. A moved clone gives `identity_relocated` and names the old directory, also after a root was added and the origin changed. Two matching old records are both named. A fresh clone after a deleted clone is refused. A second clone whose first path still exists opens as its own project. A moved clone whose old path exists again opens with a new ledger (item 6, limit 4).
10. After the named directories are moved out of the state root, the claim publishes. The directory that the refused claim left, with only the lease's files, does not block it.
11. The origin is stored at publication. A different live origin gives a warning, and the claim opens.
12. Linked worktrees share one key, a symlinked path resolves to the same key, and two clones of one repository get different keys.

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
flock --exclusive --nonblocking --no-fork --conflict-exit-code 200 <stateRoot>/owner.lock <holder>
```

The holder prints one ready line to stdout and then blocks reading stdin. The extension keeps the write end of that stdin pipe open. The lease lasts only while the holder runs. When the parent dies, the pipe closes and the holder reads EOF and exits. The kernel then releases the lock when the holder's descriptor closes (`flock(2)`). Probe P2 checked this `SIGKILL` release on one `Linux x64` host under `bun 1.4.0`. The kernel lock freed in about 2 ms (`1.86ms` to `2.35ms`). An owner arriving during that teardown window fails closed with `owner_conflict` ([P2, check notes](probes/p2.md#check-by-check-notes)).

Lease rules:

- **(a) No stealing:** Pass `--nonblocking` and `--conflict-exit-code 200` to `flock`. Exit `200` fails closed with `owner_conflict`. Any other exit before the ready line is a startup error, not a conflict. Never steal an active lease, and never take over by TTL. Never unlink `owner.lock`, because unlinking splits the path onto a second inode ([P2, verdicts](probes/p2.md#verdicts-for-section-5-rules-a-to-f)).
- **(b) Fencing epoch:** Pass `--no-fork` (`-F`) to `flock` with a non-forking holder (`exec`, such as `sh -c 'printf "ready\n"; exec cat >/dev/null'`). One process then holds the lock, so `child.pid === holderPid`. Only after reading the holder's ready line, read `owner.json`, verify `projectKey`, and increment `epoch = prev.epoch + 1`. Write `owner.json` (`schemaVersion`, `projectKey`, `epoch`, `pid`, `holderPid`, `acquiredAt`) via `temp -> fsync -> rename` plus directory `fsync`. If `owner.json` read, validation, or write fails after the ready line, close stdin and await holder exit before throwing. Copy `epoch` into every commit record ([P2, verdicts](probes/p2.md#verdicts-for-section-5-rules-a-to-f)).
- **(c) Serialized queue:** Maintain one in-process serialized queue per `projectKey`. Every store write and every external effect runs in this queue. Right before the write and right before the effect, re-check `revoked === false`, holder alive, and `owner.json.epoch === localEpoch`. Define "holder alive" synchronously from `/proc/<holderPid>/stat`, paired with `--no-fork` from rule (b). Reject process states `Z`, `X`, and `x`, and confirm the recorded `starttime` matches. Do not rely on async exit callbacks, which can lag behind synchronous checks. Do not use `kill(pid, 0)`, which still succeeds on an unreaped zombie ([P2, verdicts](probes/p2.md#verdicts-for-section-5-rules-a-to-f)).
- **(d) Revocation drain:**
  - **Controlled revocation (provider withdrawal, session shutdown, or `/reload`):** Set `revoked = true` first. Drain the serialized queue so pending items fail closed with `lease_revoked` while `owner.lock` stays held. Then close the holder stdin pipe and await holder exit before revocation resolves. Add a bounded `SIGKILL` fallback if the holder does not exit in time. Because rule (b) uses `--no-fork`, that signal hits the lock holder itself ([P2, verdicts](probes/p2.md#verdicts-for-section-5-rules-a-to-f)).
  - **Unexpected holder exit:** The holder's lock descriptor is already closed, so `owner.lock` is already free. Two guards protect the queue: rule (c)'s synchronous liveness check, and the exit handler that sets `revoked = true`. Whichever runs first, the next queue check throws `lease_revoked` and the effect does not run. P2's Check 4 tested the liveness check when no exit callback had run. P2 did not test extra items queued behind a dead holder ([P2, check notes](probes/p2.md#check-by-check-notes); [rule rationale](probes/p2.md#detailed-rule-rationale)). The exit handler running first is read from probe code and was not tested. That handler also compare-and-deletes the reload-registry entry ([`probes/p2/lease.mjs`](../probes/p2/lease.mjs)).
- **(e) Reload cleanup:** Store a revocation handle (`revokeAndClose(): Promise<void>`) on a `Symbol.for(...)` map on `globalThis`, keyed by `projectKey`. Storing only a raw pipe or child handle is not enough. Before acquiring a new lease, a reloaded instance awaits the prior handle. That handle sets `revoked = true`, drains the old queue, closes stdin, and awaits holder exit. On exit or cleanup, compare-and-delete (`if (map.get(projectKey) === entry) map.delete(projectKey)`) so a late exit callback cannot erase a newer entry ([P2, verdicts](probes/p2.md#verdicts-for-section-5-rules-a-to-f)).
- **(f) Non-inheritance:** Workers are spawned by the `hc` server rather than by the extension process. Under `bun 1.4.0`, the tested `node:child_process.spawn` call opened holder stdio as `O_CLOEXEC` descriptors, and a detached child inherited none of them. Extension code must never forward numeric file descriptors or holder streams in any child's `stdio` array. Slice S1 must keep a `/proc` and surviving-child non-inheritance test. Test any launch API other than `node:child_process.spawn` (such as `Bun.spawn`) before adopting it ([P2, verdicts](probes/p2.md#verdicts-for-section-5-rules-a-to-f)).
- **(g) Platform scope:** Linux local filesystems only; NFS and remote filesystems are unsupported. These rules assume Linux `/proc` and a `util-linux` `flock` that supports `--no-fork` and `--conflict-exit-code`. `flock` is a host prerequisite checked at startup, not a package dependency. Probe P2 ran on one `Linux x64` host under `bun 1.4.0` with `flock from util-linux 2.42.4`, `git version 2.56.0`, and `@earendil-works/pi-coding-agent` `1.6.1` ([P2, runtime environment](probes/p2.md#runtime-and-host-environment)).

Probe P2 tested those six rules and the holder lifetime on one `Linux x64` host under `bun 1.4.0`. P2 did not test real Pi `/reload` wiring, `jiti` lifecycle, withdrawal handlers, or reload with queued work in flight. P2 also did not test `Bun.spawn` or explicit numeric-FD or holder-stream forwarding in child `stdio` ([P2, scope limits](probes/p2.md#scope-limits-and-unproven-items)).

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
| `building` | `attempt_not_delivered` | Open fix attempt (send or replacement launch) settles `not_delivered` | `fix_needed` | Open attempt cleared; `totalAttemptsUsed` and `fixRoundsUsed` stay charged (escalates if a cap is hit) |
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
| `gating` | `gates_satisfied` | No open attempt; `reviewGate === approved`, `validationGate === ready`, `scanGate === pass`, all on the identical candidate identity (section 7) | `accepted` | Pure computed transition; never hand-set |
| `fix_needed` | `attempt_opened(implementer, fix)` | Lease valid, no open attempt, same implementer session live and `status !== "blocked"`, `fixRoundsUsed < fixRoundCap`, `totalAttemptsUsed < totalAttemptCap`, before deadline | `building` | Opens fix send attempt (`preSendTurn` recorded); `totalAttemptsUsed += 1`, `fixRoundsUsed += 1` |
| `fix_needed` | `attempt_opened(implementer, fix, replacement)` | Lease valid, no open attempt, reconciliation confirms the previous implementer terminal is finished or gone with no in-flight turn (never while an earlier attempt is `uncertain`), the worktree is on the recorded `headSha`, `fixRoundsUsed < fixRoundCap`, `totalAttemptsUsed < totalAttemptCap`, before deadline | `building` | Launches a fresh `implementer` in the same worktree with the brief and the findings (`hc run`); `totalAttemptsUsed += 1`, `fixRoundsUsed += 1` |
| `gating` or `accepted` | `candidate_invalidated(head_or_base)` | `headSha` or `baseSha` changed (rebase or integration); no open writer | `gating` | Clears all gates (`review`, `validation`, `scan`); binds new `(baseSha, headSha)` |
| `ready`, `building`, `gating`, `fix_needed`, or `accepted` | `brief_or_scope_revised` | `briefSha256` or `ownedFilesHash` changed (tier stays `mid`; upward change to `high` refused/escalated); any prior writer confirmed stopped and marked `superseded` | `ready` | Clears all gates; commits new brief version |
| `accepted` | `merge_intent_committed` | Lease valid, no open attempt, `gatesSatisfied === true`, `headSha` unchanged, target repo confirmed | `merging` | Records exact candidate `headSha` before `full-send` runs `gh pr merge --match-head-commit <sha>` |
| `merging` | `merge_confirmed` | `gh pr view` readback confirms `state === "MERGED"` and `mergeCommit.oid` | `merged` | Locks merge outcome; separates acceptance from closeout |
| `merging` | `merge_refused_recorded` | Recorded `gh pr merge` refusal plus `gh pr view` readback showing `OPEN` with unchanged `headSha` | `accepted` | Closes the merge intent as not performed; a new merge intent is needed before another try. A changed head is handled by `candidate_invalidated` |
| `merged` | `closeout_done` | Local `main` fast-forwarded, post-merge fixture checks exit `0`, issue and workflow digest updated, terminals killed/removed and read back clean | `closed` | Terminal phase; closeout retries never reopen merge or acceptance |
| Any active phase | `escalation_triggered` | Cap exhausted, deadline passed, `hc` `blocked` (exit `9`), upward tier to `high`, or unresolvable `uncertain` attempt or merge intent | `escalated` | Records `priorPhase` and single actionable reason; preserves branches and terminals |
| `escalated` | `user_resume_recorded` | Recorded user decision specifying `priorPhase` (and optional explicit positive integer raise to one cap); if an attempt is `uncertain`, the decision must also resolve it (Table 2) | `priorPhase` | Applies recorded cap delta; resumes from last verified step |
| `escalated` | `user_abandon_recorded` | Recorded user decision to stop tracking this ticket | `abandoned` | Terminal phase; preserves repository history |
| Any phase | `corruption_detected` | Broken hash chain, sequence gap, parse error, unknown schema, bad artifact hash, or policy law violation | `quarantined` | Halts all mutations and effects; never overwrites damaged files |
| `quarantined` | `user_repair_recorded` | Recorded user repair restoring a log that passes full hash, schema, and law fold | The phase the repaired log folds to | Resumes only after full clean fold |
| `quarantined` | `user_abandon_recorded` | Recorded user decision to abandon the quarantined ticket | `abandoned` | Terminal phase |

### Table 2: Attempt-lifecycle transitions

| From attempt state | Event | Guard | To attempt state | Accounting and disposition |
|---|---|---|---|---|
| (none) | `attempt_reserved` | Ticket phase allows opening this role; guards pass | `reserved` | Allocates monotonic `attemptId`; this is the single charge listed in Table 1 for `attempt_opened`, not a second one |
| `reserved` | `intent_committed` | Lease valid inside serialized queue | `intent` | Intent record committed before `hc run` or `hc send` |
| `reserved` | `reservation_abandoned` | The fold finds a reserved attempt with no intent record (crash or lease revoked before the intent) | `settled` (`not_delivered`) | No effect was attempted; the charge stays |
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
| `uncertain` | `user_resolution_recorded` | Ticket is `escalated`; a recorded user decision names the terminal to bind or declares the effect not delivered | `delivered` or `settled` (`not_delivered`) | The only exit for an attempt that readback could not resolve |
| `settled` | Repeat event for same `attemptId` | `attemptId` already settled | `settled` (unchanged) | Record disposition `duplicate_ignored`; 0 budget cost (prevents F1) |
| `superseded` | Late event for old `attemptId` / brief | `attemptId` superseded or brief obsolete | `superseded` (unchanged) | Record disposition `obsolete_preserved`; 0 budget cost; no gate effect |

## 7. Evidence binding and candidate head versus merge commit

Acceptance is a pure function over immutable commit records and content-addressed artifacts, never a hand-set flag or prose match.

### Bound tuple and required gates (`mid` tier)

Every gate binds to one shared **candidate identity** `(issueRef, briefVersion, briefSha256, riskTier, ownedFilesHash, baseSha, headSha, writerVendors)`. Equality across gates is on that identity only. Each gate's evidence also records its own `role` and `vendor`. Those are checked per gate (a review verdict must come from a `reviewer` attempt whose vendor wrote none of the change, a validation verdict from a `validator` attempt) and are never compared across gates:

1. **Independent review:** Codex `reviewer` `VERDICT: APPROVE` with `reviewerVendor` disjoint from every vendor in `writerVendors`, captured verbatim by Captain or `operator` (read-only Codex never writes report files).
2. **Independent offline validation:** Codex `validator` `VALIDATION: READY` on the identical candidate identity with offline fixture install and check exiting `0`. If `validator` emits an unreachable-surface `HOLD`, `operator` runs the named check and records an operator receipt; `validator` must then run as a fresh attempt, evaluate that receipt, and emit `READY`.
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

`hc` `0.1.22` (`hc --skill` and `hc schema --json`) documents that child terminals end with their parent unless launched with `--outlive-parent`, exit `3` is `not_found`, exit `7` is `needs_target`, exit `9` is `blocked`, exit `11` is `finished`, `hc send` refuses on `blocked` unless `--force`, `hc wait` timeout (`reason: timeout`, default 180 seconds) is a check-in with `ended: false`, `hc run` can suffer a registry save failure and advises checking `first_message.sent`, and `hc keep` replaces a lost program with a bare shell. Probe P3 ([docs/probes/p3.md](probes/p3.md), observed in live use on `hc` `0.1.22` with six stand-in terminals, six saved agent `hc get` reads `e2-get-own-1` to `e2-get-own-6`, and Captain's notes `N1` to `N7`, no scratch core) established the following facts, design changes, and gaps:

- **`--outlive-parent` across parent exit:** In 1 of 1 stand-in parent-exit test (P3 `b1-run-parent` to `b6-get-plain-after`), a child launched with `--outlive-parent` and without `--keep` or `--rm` (`die_with_parent: false`, `keep: false`, `rm: false`) stayed `state: "live"` after its parent exited `0`, while a default sibling (`die_with_parent: true`) ended with `signal: 1`, `reason: "killed"`. Parent `SIGKILL` or OS crash is `NOT OBSERVED`.
- **`HC_TERMINAL_ID` absent and `hc wait --children`:** With `HC_TERMINAL_ID` unset, bare `hc get --json` exited `7` (`needs_target`) in 1 of 1 call (P3 `d2-get-self-no-id`), and `hc run --bg --json --no-notify` (no `--no-parent`) exited `0` with `parent: null`, `die_with_parent: false` in 1 of 1 launch (P3 `d3-run-no-id`, `d4-get-no-id-terminal`). Naming a finished non-`--rm` parent in `hc wait <parent> --children all|any --timeout 10 --json` tracked its surviving child in 1 of 1 `all` (P3 `b7-wait-children-all-parent-gone`) and 1 of 1 `any` (P3 `b8-wait-children-any-parent-gone`) call, exiting `0` on timeout with `ended: false`, `reason: "timeout"`. Bare `hc wait --children` with `HC_TERMINAL_ID` unset (P3 `d1`, `N4`), `hc wait <parent> --children` after `hc rm <parent>`, and whether child replies to `$HC_TERMINAL_ID` are lost after parent exit (`hc schema --json` `terminal.send` documents `finished` and `not_found` errors) are `NOT OBSERVED`. Query workers explicitly by stored address or name rather than relying on bare `hc wait --children` or child replies to an old Captain address.
- **`hc get` and `hc send` fields and turn timing:** `hc get --json` (`hc schema --json` `Terminal`, `Status`; P3 `a2-get-by-name`, `e2-get-own-1` to `e2-get-own-6`, note `N5`) returns `state` (`"live"` or `"finished"`), integer `turn`, `reported`, and `status` as `null` or an object (`{ state, app?, kind?, msg?, progress?, title? }`). `hc send --json` (`hc schema --json` `SendResult`; P3 `a5-send-plain`, notes `N1`, `N2`, `N5`, `N7`) returns `started` (`boolean | null`), string `status` (or `null`), and integer `turn`. `Terminal.turn` increments only when status leaves `working` (`hc schema --json` `Terminal.turn`): across the 5 `started: true` sends in note `N2` (no saved raw receipts), receipt `turn` matched `hc get` before the send in 2 of 2 pre-send checks and during `working` in 4 of 4 during-turn checks, and `hc get` showed `turn + 1` in 3 of 3 post-turn checks. Send-to-turn attribution (which input moved `turn`) is `NOT OBSERVED`.
- **`first_message.sent`, folder-trust dialogs, and `hc get` retention:** In 6 of 6 observed first launches of the `implementer` template in newly created worktrees (`git worktree add`, P3 `N1`, `N5`, `N7`: 2 terminals backed by saved `hc get` `e2-get-own-1`/`-2` exit `0`, 1 removed terminal in `N1` note-only, 1 launch in `N5` note with commands and exit `0`, and 2 launches in `N7` note with commands only and no recorded exit codes), a folder-trust dialog blocked the launch task (`first_message.sent: false`; `hc get` during dialog showed `status.state: "blocked"`, `kind: "permission"` in 3 of 3 checks in `N5`/`N7`, plus `msg: "Trust this folder?"` in `N5`). In 2 of 2 launches in `N7` (note alone), the core's blocked notice reached the parent after the dialog had already cleared and `hc get` showed `working`. `hc get --json` retains `first_message` only when a template first message was not sent (`hc schema --json` `Terminal.first_message`; `hc --skill` `Delegate a task`): `e2-get-own-1` and `e2-get-own-2` (2 of 2 live `implementer` terminals, exit `0`) still showed `first_message.sent: false` with a `first_message.reason` string hours later on later turns while `working`, while `e2-get-own-3` to `e2-get-own-6` (4 of 4 trusted Codex terminals, exit `0`) omitted `first_message` (described as `null` in `N1`). A launch receipt (`RunResult`) with `first_message.sent: true` (`N1`) and `first_message.sent` on a program that becomes ready late (`N4`) are `NOT OBSERVED`.
- **Bounded `hc read` on finished non-`--rm` terminals and full-screen scrolling:** In 1 of 1 finished non-`--rm` stand-in terminal printing 401 lines (P3 `c1-run-report` to `c7-read-0-text`; raw `c3-get-finished-by-address` recorded `rows: 120`, `cols: 200`, `screen: "exact"`; mid-run `c8-ls-all` listed 3 of 3 finished non-`--rm` stand-in terminals), `hc read --lines 1000 --json` returned all 401 lines (`c4-read-1000-json`, `complete: true`, `how: "history"`), while `--lines 50 --json` returned 170 lines (inferred as recorded `rows: 120` plus 50 history lines per `terminal.read`), omitted lines 1 to 231, and still returned `complete: true` (`c5-read-50-json`). `ReadResult.complete` (`hc schema --json`) means only that what was asked for was returned, not that the whole output fit. In 3 incidents in note `N3` (no saved raw receipts or exit codes), `hc read --lines N` (`N > 0`, `how: "stitched"` in `hc schema --json` `ReadResult`) on an idle full-screen agent terminal injected mouse escape sequences into its prompt (`--lines 0` was not followed by stray text in that run). `ReadResult.complete: false` and `hc read` on a finished full-screen agent terminal are `NOT OBSERVED`.
- **`hc label` filtering:** `NOT OBSERVED` in P3 (`hc schema --json` documents `terminal.label` and `terminal.list` `labels` filtering, and `labels` appears in `hc get --json`).

Deterministic terminal names must stay within 1 to 32 characters of `a-z 0-9 - _ .` and are unique among live terminals (`hc schema --json` `terminal.run` `name`; duplicate live name failed exit `1`, `kind: "name_taken"`, P3 `a4-run-duplicate-name`). Because `<projectKey>-<issue>-<role>-<attemptId>` uses 30 characters for a 16-hex `projectKey`, `implementer`, and three hyphens (exceeding 32 whenever `<issue>` and `<attemptId>` together exceed 2 characters), Slice 3 must use a shortened deterministic format within 32 characters (for example `<projectKey8>-<issue>-<roleCode>-<attemptId>`). Labels are a convenience, never evidence (`hc label` filtering is `NOT OBSERVED` in P3).

The design defines no way yet for a worker to see or return an `attemptId`. `hc` `0.1.22` has no field for it (`hc schema --json`). That decision is tracked in issue `#27`.

| Crash window or failure | Authoritative readback | Safe disposition |
|---|---|---|
| `hc run` returns error with no terminal address (e.g. `name_taken`, P3 `a4-run-duplicate-name`) | Recorded `hc run` error receipt (`hc --skill` error envelope) | Settle attempt as `not_delivered` (the **only** path to definite non-delivery); cap stays charged |
| Crash after launch intent before receipt, or registry save failure (`hc --skill` `Run programs`) | Lookup terminal by deterministic name (`hc get <name> --json`; 1 of 1 live in P3 `a2-get-by-name`, 2 of 2 finished in P3 `b4`, `c3`); inspect `first_message`, `state`, `status?.state`, `turn`, and screen (`hc read --lines 0`, P3 `N3`) | Found + `first_message.sent === false` (on an unrecovered launch; P3 `e2-get-own-1`/`-2`, notes `N1`, `N5`, `N7`, `hc --skill`): read screen (`--lines 0`), escalate, and never launch a duplicate. Found + `first_message` absent or `null` (`hc get` retains only unsent messages per `hc schema --json` `Terminal.first_message`; `RunResult` `sent: true` and late readiness are `NOT OBSERVED` in P3 `N1`, `N4`): bind the terminal. Never launch a duplicate. Read `hc get --json` and `hc read --lines 0` once for the record. Stay `uncertain` and escalate. **Not found: stay `uncertain` and escalate. Never launch a replacement on absence alone.** |
| Crash after send intent before receipt, or `started: false`/`null` (observed in P3 `a5-send-plain`, notes `N2`, `N3`; `hc schema --json` `SendResult`) | `hc get --json` (`turn`, `status?.state`; `Terminal` / `Status`) + screen-only `hc read --lines 0` (avoid `--lines N > 0` on live full-screen agents per note `N3`; screen text is untrusted data) | Never resend. `turn` movement never settles the attempt: an already-running turn or another sender can move `turn`, note `N2` shows counter timing only, and send-to-turn attribution is `NOT OBSERVED` in P3. Read `hc get --json` and `hc read --lines 0` once for the record. Stay `uncertain` and escalate (prevents F4). |
| `hc wait` timeout, `not_found` (exit `3`), or RPC/`unavailable` error (`hc --skill`, `hc schema --json` `WaitResult`, `terminal.wait`) | Parse JSON `ended` and `reason` (and `children[*]` for `--children`); never treat exit `0` alone as finished (P3 `b7`, `b8` exited `0` with `ended: false`, `reason: "timeout"`; `b3`, `c2` exited `0` with `ended: true`, `reason: "exit"`). Separate exit `3` `not_found` and `unavailable` (not triggered in P3) | Timeout (`ended: false`, `reason: "timeout"`) keeps `delivered`. `not_found` moves attempt to `uncertain` and reconciles files/commits before escalating (prevents F5). `unavailable` retries with bound, then escalates |
| Surviving worker finishes while Captain is absent (parent-exit survival observed in 1 of 1 stand-in test, P3 `b1` to `b6`; finished non-`--rm` read observed in 1 of 1 stand-in terminal, P3 `c1` to `c7`) | `hc get --json` (`state: "finished"`, `screen: "exact"`) + bounded `hc read --json` on finished non-`--rm` terminal (P3 `c4`, `c5`; finished full-screen agent read and `complete: false` are `NOT OBSERVED`); verify completeness independently because `ReadResult.complete: true` does not detect output cropped by `--lines` (P3 `c5`, `hc schema --json` `ReadResult.complete`) | Persist artifact before commit record. For a worker that writes a report file (when writable, `hc --skill`), accept its verdict only after the file is verified independently. Never accept a short line count as proof. For a worker whose verdict exists only on its screen (section 7), a verdict found there after Captain absence is not accepted, even with `complete === true` and `screen === "exact"`; nothing ties it to this attempt (issue `#27`), so it blocks the gates. The Captain then requests a fresh authorized review and captures that verdict while present, as section 7 describes. Never invent evidence. Kill or remove the terminal only after its output is captured, the capture is verified, and it is persisted. Keep the terminal when the capture is missing, truncated, or unverified. |
| OS crash or `hc keep` replaces lost program with bare shell (`hc --skill`, `hc schema --json` `Terminal.keep`, `Terminal.reason`; `NOT OBSERVED` in P3) | Check `hc get --json` `status`, `state`, and `reason` markers; refuse `--keep` on worker launches | Never treat a kept shell as resumed work. Reconcile partial files on disk and escalate or authorize a fresh attempt |
| Implementer session finished or gone when a fix is needed (`state: "finished"` observed in P3 `b4`, `b6`, `c3`; exit `3` `not_found` in `hc --skill`) | `hc get --json` after reconciliation shows `state: "finished"` or `not_found`, no attempt is `uncertain`, worktree is on the recorded `headSha` | Open a replacement fix attempt (`fix_needed` row in Table 1), charged as a fix round. Never replace a writer whose earlier attempt is still `uncertain` |
| Crash between artifact write, commit record, effect, and receipt | Fold `log/<seq6>.json` and check artifact hashes | Orphan artifact before commit is harmless. Log ending in intent without receipt is `uncertain`. Exclusive `<seq6>.json` prevents double consumption or dropped advancement |
| Crash after `merge_intent` before `gh pr view` readback | `gh pr view` for state, `mergeCommit`, and PR head SHA | `MERGED` -> commit `merge_confirmed`, enter `merged`. `OPEN` or ambiguous -> stay `uncertain` and escalate; never blind retry merge |
| Crash in `merged` before closeout finishes | Read `git status`, local `main` SHA, `hc ls --all` (`hc --skill`; P3 `c8-ls-all` listed 3 of 3 finished non-`--rm` stand-in terminals mid-run; post-run cleanup recorded as script count `0` and six `hc get` exit `3` notes in `N6` without saved outputs), issue state | Retry idempotent closeout steps only; never reopen acceptance or merge |
| Second Captain starts or stale owner fires | `flock` non-blocking lock + `owner.json.epoch` + `revoked` check inside serialized queue | Fails closed with `owner_conflict` or `lease_revoked`; stale owner never writes |
| Workflow digest disagrees with commit log | Fold ticket commit log | Digest carries zero gate authority; workflow regenerates it from the ledger |
| Worker enters `blocked` status (permission or trust prompt; 6 of 6 new-worktree `implementer` launches in P3 `N1`, `N5`, `N7`, 2 backed by `e2-get-own-1`/`-2` and 4 note-only; 2 of 2 late blocked notices in note `N7` alone) | Read `hc get --json` before acting on a blocked notice (notices arrived after recovery when `hc get` already showed `working` in 2 of 2 launches in note `N7`). Check launch receipt `first_message.sent === false` (`N1`, `N5`, `N7`), `hc get --json` `status?.state === "blocked"` (`kind`, `msg` observed in `N5`/`N7`; `hc schema --json` `Status`), or exit `9` on `hc send` (`hc --skill`, `terminal.send`; not triggered via `hc send` in P3) + `hc read --lines 0` | Escalate to user. Never bypass with `hc send --force` or automated `hc keys` (whether a launch-time folder-trust dialog for a Captain-created worktree should be cleared as launch readiness after screen verification is an open design question for the owner in [docs/probes/p3.md](probes/p3.md)) |

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
