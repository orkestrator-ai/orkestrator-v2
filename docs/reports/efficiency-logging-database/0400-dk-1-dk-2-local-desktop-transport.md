# Local desktop windows relay every event and invoke through Electron main

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

The report's fix for DK-2 is DK-1's transport change, so both findings share this file.

### Tasks

1. **Capture the baseline**: measure main-process CPU and IPC volume with terminal output running before changing the transport. Status: open.
2. **Filtered event stream for local windows**: move local windows onto the direct gateway transport with filtered SSE, behind a per-window rollback switch. Status: open (depends on 1).
3. **Local `invoke` off the main-process hop**: send a local window's commands over the same direct transport. Status: open (depends on 2).

### 1. Capture the baseline

**Problem.** Without a before figure, the transport change cannot be shown to have helped.

**Context.** Decided 2026-11-01 in [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 1: small fixes ship without waiting, but this task is a structural one and needs a baseline first.

**Investigation.** The report measured nothing here. The gateway metrics exist, but nothing I read counts bytes sent over `orkestrator:event`.

**Decisions.**

- **What to measure?**
  - **Electron main CPU and event bytes with one busy terminal and two windows, in an isolated `dev:test` profile (recommended).**
    - Pros: it covers the case the finding describes; it can be repeated after task 2.
    - Cons: needs a temporary counter in main.
  - **Launch-to-idle timing only.**
    - Pros: no new counter.
    - Cons: does not exercise terminal output, which is the main cost.

### 2. Filtered event stream for local windows

**Problem.** Every PTY and tmux byte of every environment is JSON-encoded, parsed on the Electron main thread and structured-cloned to each window of that connection, then dropped in the preload if nothing listens.

**Context.** Decided 2026-11-01 in 1202 task 12: local windows use the direct gateway transport, with a per-window rollback switch, starting with filtered SSE and not tied to the terminal WebSocket. That decision stands; only the switch's scope below is open.

**Investigation.** `apps/desktop/electron/backend-process.ts:662-663` opens `/__orkestrator/events` with only a cursor. Events reach each window through `apps/desktop/electron/desktop-window-contexts.ts:58` and `:124`. The filter happens after the clone, in `apps/desktop/electron/preload-api.ts:343-347`. The browser path already asks for `excludeEvents` with the `terminal-output-` prefix (`apps/web/src/lib/native/web-gateway.ts:48`, `:500`). Remote windows already use `installRemoteGatewayRequestAuth` (`apps/desktop/electron/main.ts:919`), which is the mechanism a local window would reuse.

**Decisions.**

- **Rollback switch scope?** (1202 recommends the first; not yet decided.)
  - **A per-window setting read at window creation, defaulting to the new transport after one release behind it (recommended).**
    - Pros: a user with a broken window can fall back without a new build.
    - Cons: two transports to keep working for a release.
  - **A build-time flag.**
    - Pros: one transport at runtime.
    - Cons: no way back without a release.

### 3. Local `invoke` off the main-process hop

**Problem.** A local `invoke` is cloned from the renderer, stringified and fetched in main, parsed with `response.json()` in main and cloned back, so large terminal snapshots, transcripts and base64 reads are parsed on the main thread.

**Context.** This is DK-2. The report says the DK-1 transport change removes the hop, and at minimum the raw body could pass through without being parsed in main.

**Investigation.** The path is `apps/desktop/electron/preload-api.ts:355`, `apps/desktop/electron/ipc.ts:297-305` and `apps/desktop/electron/backend-process.ts:490-506`. `invoke` first offers each command to `terminalInput.invoke` (`backend-process.ts:491`), the sequencer that orders terminal input, so that ordering has to survive any move.

**Decisions.**

- **Move commands, or only stop parsing in main?**
  - **Move a local window's commands onto the direct transport with the events (recommended).**
    - Pros: removes all four serialisations; one transport per window.
    - Cons: terminal input sequencing has to move or be preserved.
  - **Pass the raw response body through main without parsing it.**
    - Pros: small; no transport change.
    - Cons: still crosses IPC twice; it cannot help until the renderer accepts raw bodies.

## Current state

No part of this is built. `backend-process.ts` still opens the unfiltered stream, and local windows still invoke through IPC.

## Constraints and rationale

The report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) on missed-event detection and on metrics staying content-free apply. Terminal output is outside authoritative replay, so a reconnect must still trigger exact snapshot recovery (`backend-process.ts:678-680`).

## Needs verification

- Real main-process cost; the report's impact is reasoned, not measured.
- 1202 infers from code that local desktop traffic never compresses because `backend-process.ts` calls control-only routes. A move to the direct transport may change that, so check it.

## Related

- [Efficiency report, G](../2026-10-27-efficiency.md#g-desktop-toolchain-docker-image-protocol-and-cli)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), tasks 1 and 12
