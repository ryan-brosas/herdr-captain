# ADR-0002: Worker survival, holder-process lease, commit log, and readback recovery

**Status:** PROPOSED (separates accepted user direction from proposed fencing, storage, and recovery mechanisms; design draft, not implementation approval).
**Date:** 2026-11-27.

## Context

`hc` `0.1.22` child terminals end with their parent unless launched with `--outlive-parent`, `hc run` can fail after launch during registry save, `hc send` can report ambiguity, and `hc keep` replaces a dead program with a bare shell (`hc` `0.1.22` `--skill`). Meanwhile, `/reload` creates a new extension instance (`pi-fabric` `0.140.1`, `docs/providers.md`, host policy section) and whether the old instance's handles are released is `TO BE PROBED` in P2, concurrent Captains can open linked worktrees of the same clone, and multi-file rename sequences (`state.json` plus separate event files) lack a crash-atomic transaction boundary.

## Decision

### Accepted user direction

1. Enforce one Captain execution owner per project, including across linked worktrees of the same clone.
2. When the Captain is absent, already-running workers may finish their authorized assignment, while new dispatches, follow-up turns, replacement launches, and merges stop until the Captain returns. No replacement Captain or daemon runs.
3. On return, reconcile automatically from observed state and evidence, then resume at the last verified step. Preserve branches and work. Never blindly replay uncertain external actions; escalate unresolvable ambiguity.
4. Keep `--outlive-parent` semantics explicit, and never treat an OS crash or an `hc keep` restored shell as resumed work.

### Proposed technical mechanism

1. **Canonical project key:** Set `projectKey` to the first 16 hex characters of `sha256(realpath(git rev-parse --git-common-dir))` and use `<projectKey>` alone as the state directory name. Store readable slug, full canonical path, and origin URL in `project.json`. Refuse to bind on canonical-path mismatch, and refuse to start a fresh ledger for a clone that appears to have moved (same root commits and origin, recorded path gone) until a recorded user decision rebinds it.
2. **One lease mechanism (holder process):** Start `flock --exclusive --nonblock <stateRoot>/owner.lock <holder>` on Linux local filesystems (`util-linux` `flock` `2.42.4` observed). The holder prints one ready line and blocks reading stdin; the extension keeps the pipe write end open so that parent death closes the pipe and releases the lock (`PROPOSED`, proved in P2). Fail closed with `owner_conflict` if held; bump `owner.json` epoch only after the ready line. Gate the `PROPOSED` in-process serialized queue, revocation drain (`lease_revoked`), process-global reload handle cleanup, and `O_CLOEXEC` non-inheritance rules on probe P2.
3. **One append-only commit log per ticket:** Replace mutable snapshots and separate event logs with `tickets/<issue>/log/<seq6>.json` created exclusively (`temp -> fsync -> hard-link -> unlink -> dir fsync`), with content-addressed write-once artifacts written first. Fold the log through the policy kernel on every load; quarantine any hash-chain, schema, artifact-hash, or law violation to `quarantined`.
4. **Effect ordering and strict non-delivery proof:** Run `hc run` and `hc send` inside the serialized queue as `intent -> effect -> receipt`. Definite `not_delivered` exists **only** when `hc run` returns an error with no terminal address and that receipt is recorded. After a crash before receipt or a registry save failure, look up the terminal by deterministic name (`<projectKey>-<issue>-<role>-<attemptId>`): bind if found and inspect `first_message.sent`; if not found, keep the attempt `uncertain` and escalate without launching a replacement. Never blind-resend ambiguous sends.
5. **Separate worker write ownership and post-merge closeout:** Derive active writer ownership from the commit log's open `implementer` attempt so Captain absence never clears it. Keep `merged` distinct from `closed` so closeout retries never reopen merge gates.

## Alternatives considered

- **Folder basename plus hash in the directory key:** Rejected. Linked worktrees with different folder names would acquire separate locks for one repository.
- **Read-epoch plus atomic rename, or TTL lease takeover:** Rejected. Atomic rename is not mutual exclusion, and TTL takeover risks split-brain when a slow Captain still holds in-flight calls.
- **`state.json` checkpoint plus separate `events/` and `attempt.json` files:** Rejected. Multiple renames are not crash-atomic and can double-consume evidence or lose advancement on replay.
- **Treating an absent terminal on readback as `not_delivered`:** Rejected. After a registry save failure, absence from the registry does not prove the process never started and can spawn a duplicate writer.
- **Enabling `hc keep` on worker launches:** Rejected. Replaces a dead process with a bare shell rather than resuming the task.

## Consequences

- **Benefits:** One crash-atomic commit boundary per transition, shared locking across linked worktrees, explicit fencing across `/reload` and withdrawal, and zero duplicate launches from registry absence.
- **Costs and unproved items:** Restricted to Linux local filesystems in version 1. Lease reload/revocation behaviour (P2) and `hc` `--outlive-parent` / readback behaviour (P3) remain `TO BE PROBED`. No exactly-once external effect guarantee is claimed.

## Revisit conditions

Captain and user should revisit this ADR if Captain runs on macOS, Windows, or network filesystems, if `hc` adds native idempotency tokens or leases, or if probes P2 or P3 expose host or `hc` limits.
