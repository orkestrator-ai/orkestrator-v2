# Pi compaction Stop and Auto-compact toggle on a signed-in Pi

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`.

### Tasks

1. **Stop a real Pi compaction from the tab**: a signed-in Pi tab compacts, shows the compacting state with Stop, and Stop ends it with the conversation unchanged. Status: open (needs a Pi provider login and a billed summary request).
2. **Auto-compact toggle in a real Pi tab**: the composer shows "Auto-compact", turning it off survives a reload and a model switch, and Pi's own `settings.json` is unchanged. Status: open (needs a Pi provider login).

### 1. Stop a real Pi compaction from the tab

**Problem.** [0007](0007-provider-sdk-adoption-backlog.md) task 8 made a Pi compaction stoppable: the bridge reports `running` with `activity: "compacting"` while it compacts, and the cancel routes call Pi's `abortCompaction()`. It is proved on the real Pi SDK with pi-ai's faux model only. Nobody has watched the tab show the compacting state and Stop for a manual compaction, pressed Stop, and seen the composer's message ("Compaction was stopped before it finished; the conversation was not compacted.").

**Context.** The backend reads Pi's `activity` in its progressive state read (`apps/backend/src/core/http-bridge-progressive.ts`). The renderer's compacting label and Stop control are the ones Claude's compaction already uses. The composer's `/compact` path keeps the draft when the action is refused.

**Investigation.** Not run: the ticket that built it forbade real logins and billed turns. `bridges/pi-bridge/src/compaction-controls.test.ts` holds the summary request until the abort and passes; the backend's message mapping is covered by `apps/backend/src/core/http-bridge-compact.test.ts`.

**Decisions.**

- **How to run it?**
  - **A manual run in an isolated `dev:test` profile with a Pi provider credential, compacting a conversation long enough that the summary takes a few seconds, then pressing Stop (recommended).**
    - Pros: shows exactly what a user sees; one short billed request.
    - Cons: not repeatable; depends on the summary being slow enough to press Stop.
  - **A browser spec over the Pi fake engine server with a held summary request.**
    - Pros: repeatable, no billing.
    - Cons: needs a new hold hook in `bridges/pi-bridge/src/testing/fake-engine-server.ts` and a spec; proves the renderer path but still not a real provider's abort.

### 2. Auto-compact toggle in a real Pi tab

**Problem.** The toggle is the shared composer's toggle-parameter button, fed by the Pi bridge's `autoCompaction` model parameter. It has been shown only in a standalone mock; the projection path, the reload and the model-switch retention are proved by backend and bridge tests.

**Context.** The default is Pi's own `compaction.enabled`; the session's choice overrides the session's settings manager in memory and is kept in the bridge's `state.json`. Pi's `settings.json` must not change.

**Investigation.** Not run, for the same reason as task 1.

**Decisions.**

- **What to check?**
  - **Toggle off, reload, switch model, send a turn, and compare `~/.pi/agent/settings.json` before and after (recommended).**
    - Pros: covers every path the change touches with one short billed turn.
    - Cons: needs the profile's Pi directory, never the developer's own.
  - **Also drive a conversation past Pi's threshold with the toggle off.**
    - Pros: shows auto-compaction actually not running on a real model.
    - Cons: a long and costly conversation; the faux-model test already proves the threshold path.

## Related

- [0007-provider-sdk-adoption-backlog.md](0007-provider-sdk-adoption-backlog.md) task 8.
- [7040-container-cells-on-real-cursor-and-pi.md](7040-container-cells-on-real-cursor-and-pi.md) (the other Pi live check waiting on a provider login).
