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
4. Audit `gdp-wired` packaging, helper licence, and offline compatibility before implementing Slice 1; install nothing during design.

### Proposed technical mechanism

1. **Dev-time self-contained compiled artifact:** Follow the compiled-kernel pattern inspected in `pi-fabric` release `0.139.0` (commit `0aaad42685a4dbe49194ee14a9a2f82caf6ef3b0`, MIT, `Copyright (c) 2026 monotykamary`; `scripts/verified-kernel-worker.ts:18,27,37-55` and `scripts/verified-kernels.ts:1-132`, re-verified against installed `pi-fabric` `0.140.1` in probe P4). Prove the flat two-level execution kernel in `proofs/` at dev/CI time and emit a self-contained JS module, `.d.ts`, and manifest under `generated/`.
2. **Proof and reload contract:**
   - Run full proof in dev/CI on every kernel change; never treat manifest hash matching alone as a proof rerun.
   - Require `proveSteps(..., {from: 'any'})` asserting `proven && checked && !assumes`, `crossCheck`, and broken-variant mutants rejected with `sat` counterexamples (not timeouts).
   - Test runtime equivalence between the compiled module and `rule.interpreter()`.
   - Because `{from: 'any'}` proves transitions only over states obeying the rule's laws and natural-number bounds, validate schema, hash chain, natural bounds, and every state law when folding the commit log on load; quarantine violations to `quarantined`.
   - Verify licence compatibility and byte-for-byte reproducibility of any emitted `compileJs` helpers in probe P4 before committing `generated/`.
3. **Zero Jev integration in version 1:** Omit `jev-fabric` entirely from version 1 code and schemas (`jev-fabric` `0.8.0` is observed and unused). Any future advisory use remains gated on explicit design review and falls back deterministically on low confidence or error.

## Alternatives considered

- **Hand-written TypeScript transition evaluator with unit tests:** Rejected. Breaks user direction and invites drift between modeled invariants and runtime code.
- **CI-only law comments without shipping the compiled machine:** Rejected. Does not execute the proved machine directly at runtime.
- **Adding `gdp-wired` as a runtime dependency:** Deferred. Forces runtime `node_modules` installation and complicates offline scratch fixture validation.
- **Using Jev or a chat model as an acceptance judge:** Rejected. Probabilistic scores are neither truth nor authorization (`pi-fabric` `0.140.1`, `docs/jev.md`, advisory boundary section).

## Consequences

- **Benefits:** Keeps runtime zero-install for offline `validator` fixtures while running the exact proved machine on every commit-log fold.
- **Costs and limits:** Adds a pinned dev-time proof and generation pipeline plus probe P4's helper-licence audit. `gdp-wired` proves modeled transitions only; it cannot verify `hc` receipt authenticity, git commits, or report truthfulness.

## Revisit conditions

Captain and user should revisit this ADR if probe P4 finds incompatible helper licensing or non-deterministic `compileJs` output, if `gdp-wired` ships an official zero-dependency runtime bundle, if kernel state outgrows flat natural/map encodings, or if the user asks to add advisory-only Jev hints later.
