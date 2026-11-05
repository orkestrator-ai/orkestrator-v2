# Local windows: make the filtered gateway transport the default

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3e`.

### Tasks

1. **Qualify a packaged window**: run the new transport on a packaged `file://` renderer. Status: open.
2. **Flip the default**: after one release behind the setting. Status: open (depends on 1 and on [5760](5760-local-transport-main-cpu.md) task 2).
3. **Retire the relay for local windows**: remove the second path once the default has held. Status: open (depends on 2).

### 1. Qualify a packaged window

**Problem.** The transport has only run on the dev renderer, over `http://`.

**Context.** [1202](1202-efficiency-review-follow-ups.md) task 12 shipped it behind `global.localWindowGatewayTransport`, off by default. `local-gateway-transport-electron.spec.ts` drives a real window, but through Vite.

**Investigation.** A `<meta>` Content Security Policy only reaches a production build (`renderer-security.md`). From code: `connect-src` allows `http:`, and main rewrites `Origin` on the two routes, so a `file://` page should behave the same. Neither has been seen working.

**Decisions.**

- **How to qualify?**
  - **Extend `packaged-security-electron.spec.ts` to turn the setting on, run a command and receive an event (recommended).**
    - Pros: it already asserts the policy on the packaged renderer.
    - Cons: needs a shipping build.
  - **By hand on a packaged build.**
    - Pros: no harness change.
    - Cons: not repeatable.

### 2. Flip the default

**Problem.** Local windows still pay the relay's cost unless a user opts in.

**Context.** Decided 2026-11-01: the default moves after one release behind the setting. Moving the terminal to the WebSocket is a separate decision.

**Investigation.** Not started; this waits for the release and task 1. The setting is a boolean read as `=== true`, so a flip must not turn a user's explicit `false` into on. Measured 2026-11-05, the direct transport does not lower Electron main's CPU and raises it with two windows; [5760](5760-local-transport-main-cpu.md) holds the figures and decides whether the flip waits for an explanation.

**Decisions.**

- **How is the default stored?**
  - **Keep the boolean and treat a missing value as on, so an explicit `false` stays off (recommended).**
    - Pros: no migration; a user who turned it off stays off.
    - Cons: the setting's meaning depends on the release that wrote it.
  - **Migrate stored configs.**
    - Pros: the file states the value.
    - Cons: a migration for one boolean.

### 3. Retire the relay for local windows

**Problem.** Two transports have to keep working while the switch exists.

**Context.** The rollback exists so that a user with a broken window can fall back without a new build. Remote windows still use main's relay and are not part of this.

**Investigation.** Not started. Removal would touch `relayBackendEvent`, `setTerminalOutputRelay` and the host split in the preload. Main's own event consumers (`hostUpdates`, `liveLogPolicy`) still need its stream.

**Decisions.**

- **When?**
  - **At least one release after the flip, with no open report against the new transport (recommended).**
    - Pros: keeps the fallback while the new default is new.
    - Cons: two paths for longer.
  - **In the same release as the flip.**
    - Pros: less to maintain sooner.
    - Cons: no way back without a build.

## Related

- [1202 efficiency follow-ups](1202-efficiency-review-follow-ups.md), task 12.
- [5760 local transport main CPU](5760-local-transport-main-cpu.md).
- [Closing check of E26](../../reports/efficiency-logging-database/0000-index.md#closing-check-of-e26-local-desktop-transport), the outcome of efficiency report parts `0400` and `0860`.
- [Remote gateway](../../architecture/remote-gateway.md).
