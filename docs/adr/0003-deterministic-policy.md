# ADR-0003: Compiled `gdp-wired` transition policy and advisory-only future Jev

**Status:** PROPOSED (separates accepted user direction from proposed dev-time compilation; design draft, not implementation approval).
**Date:** 2026-11-27.

## Context

In prior shell loops, scattered phase booleans and stdout string checks allowed duplicate completion lines to burn fix rounds (F1), deadlocked an authorized same-SHA proof round (F2), and accepted a merge before validation finished (F3). At the same time, `gdp-wired` is a development-time prover rather than a runtime dependency, and Codex `validator` runs in an offline sandbox where runtime package downloads fail.

## Decision

### Accepted user direction

1. Express deterministic execution transitions in `gdp-wired` and run the **same proved rule** at runtime. Never maintain a separate hand-written evaluator while claiming formal proof.
2. Prove transition laws with `{from: 'any'}` requiring `proven && checked && !assumes` so any reloaded log state satisfies the invariants.
3. Keep any future Jev use strictly optional and advisory. Jev never overrides evidence, ownership, or approval gates, and no new judge model is added.
4. Audit `gdp-wired` packaging, helper licence, and offline compatibility before implementing Slice 1; install nothing during design. P4 completed this audit on `gdp-wired` `0.62.0` ([P4, verdict](../probes/p4.md#verdict-on-adr-0003); [check summary](../probes/p4.md#check-summary)).

### Proposed technical mechanism

1. **Dev-time self-contained compiled artifact:** Follow the compiled-kernel pattern from `pi-fabric` `0.139.0` (commit `0aaad42685a4dbe49194ee14a9a2f82caf6ef3b0`, MIT, `Copyright (c) 2026 monotykamary`; `scripts/verified-kernel-worker.ts:18,27,37-55` and `scripts/verified-kernels.ts:1-132`). Prove the flat two-level execution kernel in `proofs/` at dev/CI time and emit a self-contained JS module, `.d.ts`, and manifest under `generated/`. In installed `pi-fabric` `0.140.1`, P4 observed `scripts/verified-kernels.ts`, `proofs/kernel.ts`, and `THIRD_PARTY_NOTICES.md`. `scripts/verified-kernel-worker.ts` is absent from that package ([P4, precedent observation](../probes/p4.md#precedent-observation-pi-fabric-01401-installed-package)).
   - **Emitter:** Slice S2 keeps `compileJs` (`gdp-wired` `0.62.0`). It emits plain ES with no build or type-stripping step. In `0.62.0`, `gdp-wired/emit` (`emitRule`, `dist/core/emit.js:1232`) emits zero-dependency TypeScript (`.ts`) with named types and proof comments. That output needs a build or type-stripping step. For P4's rule, `emitRule` also omitted `$x` safe-integer overflow wrappers on additions in `step` ([P4, requested updates](../probes/p4.md#requested-updates-to-adr-0003-before-slice-2)).
   - **Packaging:** Slice S2 ships raw `compileJs` output as emitted, with no pruning pass. A custom pass sits outside the kernel proof. Only equivalence sampling and file inspection cover it ([P4, trust boundary](../probes/p4.md#trust-boundary); [packaging choice](../probes/p4.md#optional-packaging-choice-left-to-adr-0003)).
   - **Notice:** Ship the `gdp-wired` MIT copyright and permission notice (`THIRD_PARTY_NOTICES.md`) beside `generated/`. This is required. `compileJs` embeds MIT-licensed helpers: `$n`, `$x`, other guard helpers as needed, and unpruned `$wordDivisionValue` (`Copyright (c) 2026 Tom X Nguyen`, `LICENSE:1-21`). MIT lines `12-13` require keeping that notice ([P4, requested updates](../probes/p4.md#requested-updates-to-adr-0003-before-slice-2)).
2. **Proof and reload contract:**
   - Run full proof in dev/CI on every kernel change; never treat manifest hash matching alone as a proof rerun.
   - Require `proveSteps(..., {from: 'any'})` asserting `proven && checked && !assumes`, `crossCheck`, and broken-variant mutants rejected with `sat` counterexamples (not timeouts). P4 passed all three on `gdp-wired` `0.62.0` with `13900` `crossCheck` cases. Its `<=` mutant failed with `stuck: "sat"` and a concrete counterexample ([P4, verdict](../probes/p4.md#verdict-on-adr-0003); [check summary](../probes/p4.md#check-summary), Checks 2 and 3).
   - Check byte-identical double compilation and manifest SHA-256 hashes. On `gdp-wired` `0.62.0`, two `compileJs` compiles gave identical bytes. Manifest checks failed with exit `1` on a 1-byte tamper ([P4, verdict](../probes/p4.md#verdict-on-adr-0003); [check summary](../probes/p4.md#check-summary), Check 1).
   - Sample runtime equivalence between the shipped raw module and `rule.interpreter()` ([P4, trust boundary](../probes/p4.md#trust-boundary)).
   - Validate schema, hash chain, natural bounds, and every state law when folding the execution ledger on load. Quarantine any violation to `quarantined`. `{from: 'any'}` proves transitions only from states obeying those laws and natural-number bounds. P4 confirmed `compileJs` checks `params` and `input` via `$n(...)` and outputs via `$x(...)`. It does not re-validate `state.scalars` on entry ([P4, precedent observation](../probes/p4.md#precedent-observation-pi-fabric-01401-installed-package)).
3. **Zero Jev integration in version 1:** Omit `jev-fabric` entirely from version 1 code and schemas (`jev-fabric` `0.8.0` is observed and unused). Any future advisory use remains gated on explicit design review and falls back deterministically on low confidence or error.

## Alternatives considered

- **Hand-written TypeScript transition evaluator with unit tests:** Rejected. Breaks user direction and invites drift between modeled invariants and runtime code.
- **CI-only law comments without shipping the compiled rule:** Rejected. Does not execute the compiled rule at runtime.
- **Adding `gdp-wired` as a runtime dependency:** Deferred. Forces runtime `node_modules` installation and complicates offline scratch fixture validation.
- **Using Jev or a chat model as an acceptance judge:** Rejected. Probabilistic scores are neither truth nor authorization (`pi-fabric` `0.140.1`, `docs/jev.md`, advisory boundary section).

## Consequences

- **Benefits:** Keeps runtime zero-install for offline `validator` fixtures. Runs the compiled rule on every commit-log fold instead of a hand-written copy. P4 ran its compiled artifact in `unshare -rn` with no `package.json`, `node_modules`, or network access. Raw `compileJs` output also keeps the trust boundary smaller ([P4, check summary](../probes/p4.md#check-summary), Check 5; [packaging choice](../probes/p4.md#optional-packaging-choice-left-to-adr-0003)).
- **Costs and limits:** `gdp-wired` proves modeled transitions only; it cannot verify `hc` receipt authenticity, git commits, or report truthfulness. Adds a pinned dev-time proof pipeline and `THIRD_PARTY_NOTICES.md` beside `generated/`. Raw output leaves one unreferenced MIT-licensed helper (`$wordDivisionValue`) in the file. P4 sampled equivalence (Check 4, `2403` steps) on the pruned artifact. Raw output had only a scratch ESM check. Slice S2 must run its equivalence check on the raw artifact ([P4, requested updates](../probes/p4.md#requested-updates-to-adr-0003-before-slice-2); [packaging choice](../probes/p4.md#optional-packaging-choice-left-to-adr-0003); [trust boundary](../probes/p4.md#trust-boundary)).
- **Trust boundary:** The kernel proof (`proveSteps(..., {from: 'any'})`, `proven: true`, `checked: true`) certifies the rule's abstract machine. That proof covers state and step laws from any valid state. It does not certify `compileJs`, any packaging pass, or the shipped JavaScript bytes. Double compiles and manifest hashes bind inputs and the pinned toolchain to output bytes. They also catch post-emit tampering. Equivalence with `rule.interpreter()` is sampled ([P4, trust boundary](../probes/p4.md#trust-boundary)).

## Revisit conditions

Captain and user should revisit `gdp-wired/emit` (`emitRule`) only when two conditions both hold. First, `emitRule` must add `$x` safe-integer overflow wrappers on additions in `step`. Second, either `emitRule` must emit plain ES or this package must add a TypeScript build ([P4, requested updates](../probes/p4.md#requested-updates-to-adr-0003-before-slice-2)). Revisit this ADR if a `gdp-wired` upgrade changes the helper licence, or if two compiles stop giving identical bytes ([P4, check summary](../probes/p4.md#check-summary), Checks 1 and 6). Also revisit it if kernel state outgrows flat natural and map encodings, or if the user asks for advisory-only Jev hints later.
