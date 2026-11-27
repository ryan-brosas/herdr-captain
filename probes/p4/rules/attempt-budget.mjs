import { nat, oneOf, rule, when } from 'gdp-wired';

export const EVENT_NAMES = Object.freeze(['open_build', 'open_fix', 'settle']);

function buildAttemptBudgetRule(name, { allowAtCap = false } = {}) {
  return rule(name)
    .params({
      initialTotalAttemptCap: nat,
      initialFixRoundCap: nat,
    })
    .inputs({
      event: oneOf(...EVENT_NAMES),
    })
    .state({
      totalAttemptsUsed: 0,
      totalAttemptCap: ({ initialTotalAttemptCap }) => initialTotalAttemptCap,
      fixRoundsUsed: 0,
      fixRoundCap: ({ initialFixRoundCap }) => initialFixRoundCap,
      openAttempts: 0,
    })
    .flags(({ event, openAttempts, totalAttemptsUsed, totalAttemptCap, fixRoundsUsed, fixRoundCap }) => {
      const underTotalCap = allowAtCap
        ? totalAttemptsUsed.atMost(totalAttemptCap)
        : totalAttemptsUsed.lt(totalAttemptCap);
      const underFixCap = fixRoundsUsed.lt(fixRoundCap);
      const noOpenAttempt = openAttempts.eq(0);
      return {
        openBuildAccepted: event.is('open_build').and(noOpenAttempt).and(underTotalCap),
        openFixAccepted: event.is('open_fix').and(noOpenAttempt).and(underTotalCap).and(underFixCap),
        settleAccepted: event.is('settle').and(openAttempts.eq(1)),
      };
    })
    .step(({
      openBuildAccepted,
      openFixAccepted,
      settleAccepted,
      totalAttemptsUsed,
      totalAttemptCap,
      fixRoundsUsed,
      fixRoundCap,
      openAttempts,
    }) => {
      const opening = openBuildAccepted.or(openFixAccepted);
      return {
        totalAttemptsUsed: when(opening, totalAttemptsUsed.plus(1), totalAttemptsUsed),
        totalAttemptCap,
        fixRoundsUsed: when(openFixAccepted, fixRoundsUsed.plus(1), fixRoundsUsed),
        fixRoundCap,
        openAttempts: when(
          opening,
          openAttempts.plus(1),
          when(settleAccepted, openAttempts.minus(1), openAttempts),
        ),
      };
    });
}

export const attemptBudgetRule = buildAttemptBudgetRule('attempt_budget');

// Deliberately broken variant: uses <= (atMost) where < (lt) is required on totalAttemptCap.
export const attemptBudgetBrokenLeqRule = buildAttemptBudgetRule('attempt_budget_broken_leq', {
  allowAtCap: true,
});

export function makeAttemptBudgetLaws(r) {
  const laws = [
    r.law(
      'totalAttemptsUsed never exceeds totalAttemptCap',
      ({ totalAttemptsUsed, totalAttemptCap }) => totalAttemptsUsed.atMost(totalAttemptCap),
    ),
    r.law(
      'fixRoundsUsed never exceeds fixRoundCap',
      ({ fixRoundsUsed, fixRoundCap }) => fixRoundsUsed.atMost(fixRoundCap),
    ),
    r.law(
      'at most one attempt is open',
      ({ openAttempts }) => openAttempts.atMost(1),
    ),
  ];

  const stepLaws = [
    r.stepLaw(
      'an accepted fix attempt charges both totalAttemptsUsed and fixRoundsUsed',
      (before, after) =>
        after.totalAttemptsUsed.eq(before.totalAttemptsUsed.plus(1))
          .and(after.fixRoundsUsed.eq(before.fixRoundsUsed.plus(1)))
          .and(after.openAttempts.eq(1)),
      (before) =>
        before.event.is('open_fix')
          .and(before.openAttempts.eq(0))
          .and(before.totalAttemptsUsed.lt(before.totalAttemptCap))
          .and(before.fixRoundsUsed.lt(before.fixRoundCap)),
    ),
    r.stepLaw(
      'any fixRoundsUsed increase also charges totalAttemptsUsed and opens one attempt',
      (before, after) =>
        after.fixRoundsUsed.gt(before.fixRoundsUsed).implies(
          after.fixRoundsUsed.eq(before.fixRoundsUsed.plus(1))
            .and(after.totalAttemptsUsed.eq(before.totalAttemptsUsed.plus(1)))
            .and(before.openAttempts.eq(0))
            .and(after.openAttempts.eq(1)),
        ),
    ),
    r.stepLaw(
      'an accepted build attempt charges totalAttemptsUsed without charging fixRoundsUsed',
      (before, after) =>
        after.totalAttemptsUsed.eq(before.totalAttemptsUsed.plus(1))
          .and(after.fixRoundsUsed.eq(before.fixRoundsUsed))
          .and(after.openAttempts.eq(1)),
      (before) =>
        before.event.is('open_build')
          .and(before.openAttempts.eq(0))
          .and(before.totalAttemptsUsed.lt(before.totalAttemptCap)),
    ),
    r.stepLaw(
      'opening an attempt is refused while another attempt is open',
      (before, after) =>
        after.totalAttemptsUsed.eq(before.totalAttemptsUsed)
          .and(after.fixRoundsUsed.eq(before.fixRoundsUsed))
          .and(after.openAttempts.eq(1)),
      (before) =>
        before.openAttempts.eq(1)
          .and(before.event.is('open_build').or(before.event.is('open_fix'))),
    ),
    r.stepLaw(
      'settling an open attempt closes it without changing counters',
      (before, after) =>
        after.openAttempts.eq(0)
          .and(after.totalAttemptsUsed.eq(before.totalAttemptsUsed))
          .and(after.fixRoundsUsed.eq(before.fixRoundsUsed)),
      (before) => before.event.is('settle').and(before.openAttempts.eq(1)),
    ),
    r.stepLaw(
      'counters never decrease and caps remain unchanged',
      (before, after) =>
        after.totalAttemptsUsed.atLeast(before.totalAttemptsUsed)
          .and(after.fixRoundsUsed.atLeast(before.fixRoundsUsed))
          .and(after.totalAttemptCap.eq(before.totalAttemptCap))
          .and(after.fixRoundCap.eq(before.fixRoundCap)),
    ),
  ];

  return { laws, stepLaws };
}
