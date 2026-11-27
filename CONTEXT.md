# Context and glossary

Fleet role names are defined by the fleet configuration repository (private).

Add a term here only where two words for the same concept caused a wrong move.

**Execution ledger**:
The per-ticket append-only commit log (`tickets/<issue>/log/<seq6>.json`) and content-addressed artifacts stored outside every Git repository; current state is folded through the policy kernel on every load, with no mutable snapshot file. Distinct from a human run card or a workflow digest, neither of which carries gate authority.
_Avoid_: job file, tracker, database, state file

**Commit record**:
One exclusively created, hash-chained JSON file (`<seq6>.json`, under 8 KB) recording one transition, its fencing epoch, event, attempt ID, intent or receipt, artifact references, counters after, and phase after. Current ticket state is derived solely by folding these records.
_Avoid_: event log entry, checkpoint, snapshot

**Attempt**:
One pre-reserved, uniquely identified dispatch or follow-up turn (`attemptId`) binding an immutable brief hash, role, vendor, terminal, and base and candidate head SHAs. Distinct from a commit SHA: an authorized proof round may reuse the same SHA, and repeating a settled attempt spends no budget.
_Avoid_: round, commit, run

**Effect intent**:
A commit record written before an external side effect (`hc run`, `hc send`, or a workflow-run merge) holding its correlation ID and exact authorized payload, so crashes resolve by readback instead of blind replay.
_Avoid_: pending job, lock, receipt

**Candidate head**:
The full 40-character commit SHA of the PR branch that independent `APPROVE`, `READY`, offline fixture checks, and full two-pass secret scan bind to. Distinct from the merge commit that GitHub squash or merge strategies create after landing.
_Avoid_: head, PR commit, merged SHA

**Owner lease**:
The per-project single-Captain mutual exclusion held by a `flock` holder child process designed to live exactly as long as the extension keeps its stdin pipe open (proposed; proved in probe P2), paired with a monotonic fencing epoch in `owner.json`. Separate from worker write ownership, which persists in the commit log across Captain absence until the surviving implementer stops.
_Avoid_: lockfile (alone), session lock, writer claim

**Uncertain effect**:
An attempt state where an effect intent was committed without a confirming receipt and readback has not yet proven delivery or authoritative non-delivery. It counts toward attempt caps and leaves only through readback reconciliation or escalation, never by defaulting to not sent or succeeded.
_Avoid_: failed, dropped, timeout
