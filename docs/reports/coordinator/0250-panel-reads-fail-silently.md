# Failed background reads leave the panel silently stale

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Show when the panel is out of date**: a stale indicator when a background coordinator or Git read fails. Status: open.

### 1. Show when the panel is out of date

**Problem.** After a background read fails, the panel keeps showing the old state with no sign. A worker can look running after it stopped.

**Context.** The rest of the report's section 5.4 is spread over [0020](0020-startup-failure-takes-down-whole-coordinator.md), [0180](0180-coordinator-errors-need-an-alert.md) and [0210](0210-state-cards-end-in-dead-ends.md). This is the part they do not cover. The app already has freshness wording in `apps/web/src/lib/view-freshness.ts`, described in `docs/architecture/event-snapshot-recovery.md` ("Freshness in the UI").

**Investigation.** Both `useCoordinatedRead` callbacks ignore everything but `current`: `useCoordinatorPanelData.ts:224-225` for the view and `:254-255` for Git. `CoordinatorPanel.tsx` does not import `view-freshness`. The loading error reaches the user only before a snapshot exists (`:679-697`).

**Decisions.**

- **How much to show?**
  - **Use `view-freshness` wording in a small line in the toolbar, only while stale (recommended).**
    - Pros: same words as other views; nothing appears in normal use.
    - Cons: transient failures can flicker, so it needs the existing retry settled first.
  - **Turn each background failure into an error banner.**
    - Pros: cannot be missed.
    - Cons: too loud for a read that usually recovers on its own.

## Related

- [Coordinator report, 5.4](../2026-10-27-coordinator.md#54-errors-that-name-what-failed-and-offer-the-next-step)
- [0051-client-reconnect-and-freshness.md](../../todo/transcripts-and-observation/0051-client-reconnect-and-freshness.md): the freshness work this should follow
