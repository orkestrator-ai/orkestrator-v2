# Native Chrome branch suggestion fails in the agent launch dialog spec

`e2e/AgentLaunchDialog.spec.ts:18`, `selects a native branch suggestion with
the keyboard and confirms`, fails on `main` at desktop and mobile widths, alone
too: the branch input keeps `rel` instead of `release/2.0`. Found by the
2026-10-25 triage in [0030](0030-test-suite-and-ci-health.md) (task 4).

## Task analysis

Analysed 2026-10-31 against `main` at `931e55417`.

### Tasks

1. **Make the native datalist selection pass or prove the spec wrong**. Status: open.

### 1. Native datalist selection

**Problem.** `mise run test:browser` cannot go green: this owner fails
deterministically, so every component-browser record lists it.

**Context.** The spec drives Chrome's native `<datalist>` popup through the
Chrome channel with `headless: false` (bundled Chromium does not expose it on
macOS). Recorded only inside
[0493](../../tests/flaky-tests/aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md):
the complete one-worker owner reproduced it ("two passed, two failed, input
`rel` instead of `release/2.0`"); [0035](0035-mobile-layout-gaps.md) saw the
same two failures.

**Investigation.** Not rerun this round. The keyboard steps type `rel`, then
expect the popup's arrow-and-Enter to fill the option; the value stays as
typed, so the popup selection never applies.

**Decisions.**

- **How to fix?**
  - **Find whether current Chrome still opens the popup for a focused input
    under automation (one probe), then either drive it the way Chrome now
    accepts or assert the suggestion list instead (recommended).**
    - Pros: evidence first; keeps a real keyboard path if one exists.
    - Cons: native popups differ per Chrome version and platform.
  - **Skip the case.**
    - Pros: green suite.
    - Cons: hides whether keyboard selection works for users.

## Current state

Fails on `main` in the complete owner. Not in CI (`test:browser` is not a CI
job).

## Outstanding work

### Code

1. The probe and fix above.

### Qualification

- `mise run test:browser` with the owner green at both widths.

## Constraints and rationale

- No skip without the probe; the case exists because bundled Chromium cannot
  see the popup.

## Assumptions and decisions

- 2026-10-31: its own file in cross-cutting, beside the other component-suite
  health work, as 0030 recommended.

## Open questions

- Does the product's keyboard selection work for a user in current Chrome?

## Needs verification

- Whether it still fails on current `main` and Chrome.

## Related

- [0030](0030-test-suite-and-ci-health.md), [0035](0035-mobile-layout-gaps.md), [0202](0202-webkit-title-tooltip-outside-tap.md).

## Replaces

- The "not flakes" note in 0030 item 7 for this spec.
