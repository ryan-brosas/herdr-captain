# ADR-0001: Direct Fabric provider boundary and single execution owner

**Status:** PROPOSED (separates accepted user direction from proposed technical mechanism; design draft, not implementation approval).
**Date:** 2026-11-27.

## Context

Prior ad-hoc shell execution loops produced six recurring failures (F1 to F6 in [adoption.md](../adoption.md)): duplicate completion reports burned fix rounds, same-SHA proof rounds deadlocked, changes merged before validation finished, ambiguous sends started late, missing terminals read as live, and a single state file of about 54 KB hit a 50 KB read limit. Splitting observation and execution across multiple state writers also risks conflicting transitions.

## Decision

### Accepted user direction

1. Existing workflow documents, GitHub issues, glossaries, ADRs, and skills remain the sole owner of planning, research, grilling, readiness, and issue dependencies. Never build a second planning engine in the extension.
2. Integrate through `pi-fabric`'s public interfaces (`0.140.1` observed at design time). Do not fork `pi-fabric`, build a second process manager, or start Pi children through `hc`.
3. Keep one user-started Pi Captain, Antigravity as sole `implementer`, Codex as independent `reviewer` and `validator`, `hc` as terminal owner, and existing approved Fabric routes unchanged.
4. Upstream changes to `pi-fabric` or `hc` happen only for a demonstrated reusable gap, and nothing is upstreamed or published without the user's ask.
5. Fleet-side integration (terminal watching, ticket pipeline, resume after stop, launch readback) stays owned by the fleet configuration repository (private)'s existing open issues, named by role only.

### Proposed technical mechanism

1. **One standalone package:** Package the extension in `ryan-brosas/herdr-captain` ([ADR-0004](0004-package-home.md)) as one thin execution owner rather than splitting observation and transition ownership.
2. **One registration route:** Register one direct Fabric provider named `fleet` with at most six closed-schema actions (`pi-fabric` `0.140.1`, `docs/providers.md`, direct provider registration and withdrawal sections). Omit any `pi.registerTool()` fallback from version 1. Keep `pi-fabric:provider:register:v1`, `pi-fabric:provider:discover:v1`, and `pi-fabric:provider:withdraw:v1` as literals in `src/index.ts` with no runtime import of `pi-fabric`, because Pi gives installed packages separate module roots. A test compares those literals with the installed `pi-fabric` `./protocol` export (checked on `pi-fabric` `0.140.1` in [docs/probes/p1.md](../probes/p1.md#adr-0001-direct-fabric-provider-boundary), finding 2). Emit `pi-fabric:provider:register:v1` with `overwrite: true` in both the extension factory and `session_start`. On `pi-fabric` `0.140.1`, with registration in the factory only, a package loaded before `pi-fabric` registers through discovery alone and later withdrawals return `false` ([docs/probes/p1.md](../probes/p1.md#adr-0001-direct-fabric-provider-boundary), finding 3).
3. **External ledger and non-authoritative Fabric surfaces:** Persist ticket state outside Git repositories under `${XDG_STATE_HOME:-$HOME/.local/state}/herdr-captain/<projectKey>/`. Render no digest inside the extension. Treat Fabric durable shell tasks as process output only, never ticket authority (`pi-fabric` `0.140.1`, `docs/background-tasks.md`, detach and reattach section); other Fabric programs, Jev runs, `state.*` mesh logs, and event streams are session-owned.

## Alternatives considered

- **Forking `pi-fabric` or running a standalone daemon:** Rejected. Adds an unowned background runtime, breaks the single-Captain boundary, and duplicates `hc`.
- **Using `agents.transport: "herdr-core"`:** Rejected. `pi-fabric` `0.140.1` (`docs/agents.md`, herdr-core transport section) documents that its launches disable typed parent notifications, waiting, keep and recovery, and outliving the parent, and Fabric children are never fleet workers here.
- **Two separate extensions for observation and transitions:** Rejected. Splits authority across two state writers against the one-owner-per-state rule from `pstack`.
- **Storing ticket history in Fabric `state.*` mesh logs:** Rejected. `state.*` holds a single head whose non-current transitions and certificates can age out (`pi-fabric` `0.140.1`, `docs/state-layer.md`, history retention section).
- **Shipping both direct provider and `pi.registerTool()` routes in version 1:** Rejected. Doubles the registration surface. Probe P1 confirmed on `pi-fabric` `0.140.1` that direct `fleet` registration, closed-schema checks, withdrawal, and reload hold without a fallback ([docs/probes/p1.md](../probes/p1.md#adr-0001-direct-fabric-provider-boundary), finding 1).

## Consequences

- **Benefits:** One state owner per project, zero new process managers, bounded external commit logs, and clean separation from workflow planning.
- **Costs and limits:** Provider-level controls cannot block raw shell commands from calling `hc` or `gh` directly (`pi-fabric` `0.140.1`, `docs/providers.md`, scope section; see the enforcement matrix in [architecture.md](../architecture.md)). On `pi-fabric` `0.140.1`, docs and source show provider registration works in any Fabric kernel, but Python guest programs are not type-checked. Enforcement rests on schema validation at dispatch and on the provider's own `invoke()` checks ([docs/probes/p1.md](../probes/p1.md#adr-0001-direct-fabric-provider-boundary), finding 5). On `pi-fabric` `0.140.1`, host-invoked inline programs (`pi-fabric:program:run:v1`) fail outside the `typescript` kernel, reproduced live with `PI_FABRIC_KERNEL=python`. Probe P1 did not run a live Python-kernel call of `fleet.status()` (finding 5). Terms follow [CONTEXT.md](../../CONTEXT.md).

## Revisit conditions

Probe P1 passed on `pi-fabric` `0.140.1`, so its direct-registration revisit rule did not trigger ([docs/probes/p1.md](../probes/p1.md#adr-0001-direct-fabric-provider-boundary), finding 1). Captain and user should revisit this ADR if a later `pi-fabric` release breaks direct provider registration (activating a `pi.registerTool()` evaluation), if `pi-fabric` adds a public cross-session owner-lease API, or if version 2 introduces parallel validation or multi-machine storage.
