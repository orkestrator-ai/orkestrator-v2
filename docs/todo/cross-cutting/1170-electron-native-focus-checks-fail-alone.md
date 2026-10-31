# Electron native-focus checks that fail alone: realm Agent information and annotation Notes

Two full-app Electron specs check that keyboard focus lands in a native panel,
and both fail even when their owning file runs alone, so they are not flakes.
Found by the 2026-10-25 flake triage in
[0030](0030-test-suite-and-ci-health.md) (task 4).

## Task analysis

Analysed 2026-10-31 against `main` at `931e55417`.

### Tasks

1. **Workspace realm Agent information focus**: the panel opens but `focused` stays false. Status: open.
2. **Annotation Notes focus**: `pressControl`'s five-second focus check fails in the annotation owner. Status: open.

### 1. Workspace realm Agent information focus

**Problem.** `mise run test:agent:electron` cannot go green while
`e2e/agent-testing/workspace-realm-electron.spec.ts` fails its Agent
information focus poll.

**Context.** The poll is now at `workspace-realm-electron.spec.ts:694`
(`expect.poll(panelState).toMatchObject({ label: panelLabel, focused: true })`);
records cite it as line 409. Recorded in
[0790](../../tests/flaky-tests/aggregate-validation-runs/0790-environment-list-main-merge-validation.md)
(merge run: 30 passed, one failed, the panel present with `focused` false) and
[0740](../../tests/flaky-tests/aggregate-validation-runs/0740-agent-accounts-sign-in-0003-validation.md)
(fails in the complete owner rerun, 34.7 s).

**Investigation.** Not rerun this round. On this Linux host on 2026-10-31,
the full-app `electron-main.spec.ts` stopped earlier, behind two startup
dialogs (the host-firewall dialog 0830 recorded), so a realm run here would not
reach the poll either.

**Decisions.**

- **Product or test?**
  - **First decide whether the panel should take focus when opened from the
    realm, from the panel's code, then fix whichever side is wrong (recommended).**
    - Pros: a focus assertion that fails alone is either a real accessibility
      regression or a stale expectation; both are cheap once known.
    - Cons: needs a host where the spec reaches the poll.
  - **Drop the focus half of the poll.**
    - Pros: green spec.
    - Cons: weakens an assertion without knowing why it fails.

### 2. Annotation Notes focus

**Problem.** The annotation owner (`e2e/agent-testing/web-annotations-electron.spec.ts`)
fails at `pressControl`'s focus check (`:1451`), alone too.

**Context.** Recorded in 0740, 0772, 0789 and 0790. Todo
[0044](../previews-and-annotations/0044-web-annotation-qualification.md) task 4
covers OS-level native focus, which a shared desktop cannot prove; this is the
in-document focus `pressControl` checks before it sends a key.

**Investigation.** Not rerun this round.

**Decisions.** As task 1: find whether the control should hold focus at that
point (recommended) before changing the check.

## Current state

Both checks fail in their owning files on hosts where the specs reach them.
They are not in CI (`test:agent:electron` is not a CI job).

## Outstanding work

### Code

1. Diagnose and fix task 1.
2. Diagnose and fix task 2.

### Qualification

- A green `mise run test:agent:electron` run of both owners on a host without
  the startup dialogs.

## Constraints and rationale

- No skips or weakened focus assertions without a diagnosis
  ([0030](0030-test-suite-and-ci-health.md) constraints).

## Assumptions and decisions

- 2026-10-31: one file for both, as 0030 recommended: both are native focus
  checks in full-app Electron specs and are likely to share a cause or a host
  requirement.

## Open questions

- Do both fail because the window is not frontmost on a shared desktop (the
  0044 limitation), or because focus really goes elsewhere?

## Needs verification

- Whether either still fails on current `main`.

## Related

- [0030](0030-test-suite-and-ci-health.md), [0044](../previews-and-annotations/0044-web-annotation-qualification.md),
  [0325](0325-keyboard-shortcuts-desktop-gaps.md).

## Replaces

- The "not flakes" note in 0030 item 7 for these two checks.
