# Each render of the native agent tab does avoidable work

Found while measuring [5580](5580-agent-native-tab-environment-subscription.md). That work removed the renders caused by unrelated environment writes; these two costs remain on every render the tab still has, such as a streaming transcript.

## Task analysis

Analysed 2026-11-05 against `main` at `6e796ca32`, with 5580 applied.

### Tasks

1. **Stabilise `submit`**: stop the send callback changing on every render without losing the opening prompt's retry. Status: open.
2. **Find the nested update**: identify what commits a second time on each render of a tab with a platform. Status: open.

### 1. Stabilise `submit`

**Problem.** `submit` in `AgentNativeTab.controller.tsx:1928` gets a new identity on every render, so everything depending on it re-runs, including the opening-prompt effect at `:2899`.

**Context.** `useUserCommands` returns `refresh: () => refreshRef.current()`, a new function each call (`hooks/useUserCommands.ts:76`), and `refreshUserCommands` is in `submit`'s dependencies (`:2500`). A comment at `:1943` says a refused opening prompt is "retried by the caller once the turn ends and this callback changes", so the effect's retry leans on `submit` changing.

**Investigation.** Instrumenting `submit`'s dependencies on 2026-11-05 showed `refreshUserCommands` as the one that changed on every render. Not all of `submit`'s refusals are visible in its dependencies: three read refs (`queueEditPendingRef`, `submitInFlightRef`, `beforeSendPendingRef`), and `isSubmitting`, `preparingSend` and `queueEditPending` release them. Today any of those renders wakes the effect only because the callback is unstable. No misbehaviour has been seen from the churn.

**Decisions.**

- **How to stabilise it?**
  - **Memoise `refresh` and give the effect those three states as explicit dependencies, with a test for each refusal being retried (recommended).**
    - Pros: fixes the churn at its source and makes the retry's wake-ups visible rather than accidental.
    - Cons: touches the launch path, so each refusal needs its own test.
  - **Memoise `refresh` only.**
    - Pros: one line.
    - Cons: a prompt refused on a ref alone could then wait until the turn state next changes, or never be sent.
  - **Leave it.**
    - Pros: no risk to launches.
    - Cons: the retry keeps depending on an accident, and any later memoisation can break it unnoticed.

### 2. Find the nested update

**Problem.** Each render of a tab with a platform commits twice: the update, then a `nested-update`, which is a state write from a layout effect.

**Context.** The unassigned composer does not do this: it committed once per write in the 5580 measurement.

**Investigation.** Measured on 2026-11-05 in Chromium with development React and a 100-row fixture: the update took about 2.6 ms and the nested update about 0.9 ms with one tab, and about 4.7 ms and 1.2 ms for two tabs together. The source was not identified. `VirtualizedMessageList` has several layout effects and is the first place to look, then `AgentNativeTab.controller.tsx:2759`; `NativeChatShell`'s dock measurement only sets state when the height changes, so it should not be the cause.

**Decisions.**

- **What to do about it?**
  - **Find the source with a temporary `Profiler` and decide from what it is (recommended).**
    - Pros: cheap, and a state write that changes nothing may be a one-line fix.
    - Cons: may find a measurement that has to stay.
  - **Leave it.**
    - Pros: about 1 ms per render under development React is small.
    - Cons: it is paid on every streamed frame of every visible tab.

## Constraints and rationale

Startup and initial-prompt behaviour must not change; `AgentNativeTab.render-count.test.tsx` pins it. Anything measured needs a fixture transcript and no provider turn.

## Related

- [5580 native tab environment subscription](5580-agent-native-tab-environment-subscription.md)
