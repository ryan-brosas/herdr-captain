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
4. Audit `gdp-wired` packaging, helper licence, and offline compatibility before implementing Slice 1; install nothing during design. Probe P4 completed this audit on `gdp-wired` `0.62.0` ([docs/probes/p4.md](../probes/p4.md#verdict-on-adr-0003), "Verdict on ADR-0003" and ["Check summary"](../probes/p4.md#check-summary)).

### Proposed technical mechanism

1. **Dev-time self-contained compiled artifact:** Follow the dev-time compiled-kernel pattern from `pi-fabric` `0.139.0` (commit `0aaad42685a4dbe49194ee14a9a2f82caf6ef3b0`, MIT, `Copyright (c) 2026 monotykamary`; `scripts/verified-kernel-worker.ts:18,27,37-55` and `scripts/verified-kernels.ts:1-132`). In installed `pi-fabric` `0.140.1`, probe P4 observed `scripts/verified-kernels.ts`, `proofs/kernel.ts`, and `THIRD_PARTY_NOTICES.md`, while `scripts/verified-kernel-worker.ts` is absent ([docs/probes/p4.md](../probes/p4.md#precedent-observation-pi-fabric-01401-installed-package), "Precedent observation (`pi-fabric` `0.140.1` installed package)"). Prove the flat two-level execution kernel in `proofs/` at dev/CI time and emit a self-contained JS module, `.d.ts`, and manifest under `generated/`.
   - **Emitter:** Slice S2 keeps `compileJs` (`gdp-wired` `0.62.0`) because it emits plain ES that needs no build or type-stripping step. In `0.62.0`, `gdp-wired/emit` (`emitRule`, `dist/core/emit.js:1232`) outputs zero-dependency TypeScript (`.ts`) with named types and proof comments. It needs a build or type-stripping step, and omitted `$x` safe-integer overflow wrappers on additions in `step` for P4's rule ([docs/probes/p4.md](../probes/p4.md#requested-updates-to-adr-0003-before-slice-2), "Requested updates to ADR-0003 before Slice 2").
   - **Packaging:** Slice S2 ships raw `compileJs` output as emitted, with no pruning pass. A custom pass sits outside the kernel proof, and only equivalence sampling and file inspection cover it ([docs/probes/p4.md](../probes/p4.md#trust-boundary), "Trust boundary" and ["Optional packaging choice (left to ADR-0003)"](../probes/p4.md#optional-packaging-choice-left-to-adr-0003)).
   - **Notice:** Shipping the `gdp-wired` MIT copyright and permission notice (`THIRD_PARTY_NOTICES.md`) beside `generated/` is required. Probe P4 found `compileJs` embeds MIT-licensed helpers (`$n`, `$x`, other guard helpers as needed, and unpruned `$wordDivisionValue`; `Copyright (c) 2026 Tom X Nguyen`, `LICENSE:1-21`), and MIT lines `12-13` require keeping that notice ([docs/probes/p4.md](../probes/p4.md#requested-updates-to-adr-0003-before-slice-2), "Requested updates to ADR-0003 before Slice 2").
2. **Proof and reload contract:**
   - Run full proof in dev/CI on every kernel change; never treat manifest hash matching alone as a proof rerun.
   - Require `proveSteps(..., {from: 'any'})` asserting `proven && checked && !assumes`, `crossCheck`, and broken-variant mutants rejected with `sat` counterexamples (not timeouts). Probe P4 passed all three on `gdp-wired` `0.62.0`: `13900` `crossCheck` cases passed, and a `<=` mutant failed with `stuck: "sat"` and a concrete counterexample ([docs/probes/p4.md](../probes/p4.md#verdict-on-adr-0003), "Verdict on ADR-0003" and ["Check summary"](../probes/p4.md#check-summary), Checks 2 and 3).
   - Check byte-identical double compilation and manifest SHA-256 hashes. Probe P4 confirmed two `compileJs` compiles on `gdp-wired` `0.62.0` give identical bytes, and manifest checks fail with exit `1` on a 1-byte tamper ([docs/probes/p4.md](../probes/p4.md#verdict-on-adr-0003), "Verdict on ADR-0003" and ["Check summary"](../probes/p4.md#check-summary), Check 1).
   - Sample runtime equivalence between the shipped raw module and `rule.interpreter()` ([docs/probes/p4.md](../probes/p4.md#trust-boundary), "Trust boundary").
   - Validate schema, hash chain, natural bounds, and every state law when folding the execution ledger on load, and quarantine violations to `quarantined`. `{from: 'any'}` proves transitions only from states obeying those laws and natural-number bounds, and probe P4 confirmed `compileJs` checks `params` and `input` via `$n(...)` and outputs via `$x(...)` without re-validating `state.scalars` on entry ([docs/probes/p4.md](../probes/p4.md#precedent-observation-pi-fabric-01401-installed-package), "Precedent observation (`pi-fabric` `0.140.1` installed package)").
3. **Zero Jev integration in version 1:** Omit `jev-fabric` entirely from version 1 code and schemas (`jev-fabric` `0.8.0` is observed and unused). Any future advisory use remains gated on explicit design review and falls back deterministically on low confidence or error.

## Alternatives considered

- **Hand-written TypeScript transition evaluator with unit tests:** Rejected. Breaks user direction and invites drift between modeled invariants and runtime code.
- **CI-only law comments without shipping the compiled rule:** Rejected. Does not execute the compiled rule at runtime.
- **Adding `gdp-wired` as a runtime dependency:** Deferred. Forces runtime `node_modules` installation and complicates offline scratch fixture validation.
- **Using Jev or a chat model as an acceptance judge:** Rejected. Probabilistic scores are neither truth nor authorization (`pi-fabric` `0.140.1`, `docs/jev.md`, advisory boundary section).

## Consequences

- **Benefits:** Keeps runtime zero-install for offline `validator` fixtures while running the compiled rule on every commit-log fold instead of a hand-written copy. Probe P4 ran its compiled artifact in `unshare -rn` with no `package.json`, `node_modules`, or network access ([docs/probes/p4.md](../probes/p4.md#check-summary), "Check summary", Check 5). Raw `compileJs` output also keeps the trust boundary smaller ([docs/probes/p4.md](../probes/p4.md#optional-packaging-choice-left-to-adr-0003), "Optional packaging choice (left to ADR-0003)").
- **Costs and limits:** Adds a pinned dev-time proof pipeline and `THIRD_PARTY_NOTICES.md` beside `generated/` ([docs/probes/p4.md](../probes/p4.md#requested-updates-to-adr-0003-before-slice-2), "Requested updates to ADR-0003 before Slice 2"). Raw output leaves one unreferenced MIT-licensed helper (`$wordDivisionValue`) in the file ([docs/probes/p4.md](../probes/p4.md#optional-packaging-choice-left-to-adr-0003), "Optional packaging choice (left to ADR-0003)"). P4 sampled equivalence (Check 4, `2403` steps) on the pruned artifact and ran only a scratch ESM check on raw output. Slice S2 must therefore run its equivalence check on the raw artifact ([docs/probes/p4.md](../probes/p4.md#trust-boundary), "Trust boundary" and ["Optional packaging choice (left to ADR-0003)"](../probes/p4.md#optional-packaging-choice-left-to-adr-0003)). `gdp-wired` proves modeled transitions only; it cannot verify `hc` receipt authenticity, git commits, or report truthfulness.
- **Trust boundary:** The kernel proof (`proveSteps(..., {from: 'any'})`, `proven: true`, `checked: true`) certifies the rule's abstract machine against its state and step laws from any valid state. It does not certify `compileJs`, any packaging pass, or the shipped JavaScript bytes. Double compiles and manifest hashes bind inputs and the pinned toolchain to output bytes and catch post-emit tampering; equivalence with `rule.interpreter()` is sampled ([docs/probes/p4.md](../probes/p4.md#trust-boundary), "Trust boundary").

## Revisit conditions

Captain and user should revisit `gdp-wired/emit` (`emitRule`) if it emits plain ES, or if this package adds a TypeScript build, and it adds `$x` safe-integer overflow wrappers on additions in `step` ([docs/probes/p4.md](../probes/p4.md#requested-updates-to-adr-0003-before-slice-2), "Requested updates to ADR-0003 before Slice 2"). Also revisit this ADR if kernel state outgrows flat natural and map encodings, or if the user asks for advisory-only Jev hints later.
