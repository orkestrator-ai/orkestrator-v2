# Per-node relayed events: live evidence

## Task analysis

Analysed 2026-11-07 against unified-federation-b4c9ee65814d at `ae492c20c`. Tasks 1 and 2 are unchanged. Task 3 (a production profile of the frame costs) needs a real multi-client workload on the user's install and moved to 7568 on 2026-11-10. Task 4 still applies, but its realm part is obsolete: plan items 6002 and 6003 deleted workspace realms and their portal (`orkestrator:portal-event`), so main's relayed stream now serves windows only, and another node's workspace is a node scope in the window's own renderer.

Previously analysed 2026-11-05 against `main` at `1e6d56391`.

### Tasks

1. **Two-node browser check**: per-node relayed events between two real backends, in a real browser, with a busy leaf and an inactive tab. Status: open.
2. **Older peers on real releases**: an older renderer on an upgraded command node, and a current renderer on an older command node. Status: open.

### 1. Two-node browser check

**Problem.** Efficiency report 0280 (E18) part `0370` (GW-11) was built and tested against a real gateway, with the renderer's stream class over a real socket and the node relay against a test node network. It has not run between two real backends in a real browser, so `EventSource` on the same-origin path and the reconnect of a tab that was away are not proven end to end.

**Context.** Relayed events are named `relayed-node-event:<nodeId>` and kept in a second ring (`relayedEventReplay`, 512 frames, 512 KiB; `apps/backend/src/gateway-events.ts`). A renderer reads them on one filtered stream (`RelayedEventStream`, `packages/protocol/src/relayed-event-stream.ts`), opened from `subscribeNodeEvents` (`apps/web/src/lib/federation/node-events.ts`) once `watch_node_events` answers `perNodeEvents`. This adds a third long-lived connection to a browser tab that watches a node, beside the main stream and the terminal fallback, and `web-gateway.ts` notes that WKWebView has a small per-origin allowance for those.

**Investigation.** Not run here. The ticket forbade billed provider turns, and two attached `dev:test` profiles are a larger setup than the batch ran. The events involved (`change-projection-changed`, `resource-changed`) do not need a provider turn, so this check can avoid one. Already covered by automated tests: scoping, the cursor, replay across a filter change, a busy leaf expiring only relayed cursors, and the resync on a gap (`apps/backend/tests/gateway-relayed-events.test.ts`, `apps/web/src/lib/native/web-gateway-relayed-stream.test.ts`).

**Decisions.**

- **How to qualify?**
  - **Two `dev:test` profiles, one attached to the other, driven with Playwright (recommended).** Open the command node's window, watch the leaf's sidebar badges, and emit leaf events by changing a fixture environment. Check that the main stream carries no relayed frames, that the relayed stream's filter names the leaf, and that `replay.ring.latestRevision` stays still under a flood of leaf events while `replay.relayedRing` moves. Switch away, let the leaf change, return, then reload, and check that the badge is right each time.
    - Pros: exercises the real renderer, `EventSource` and the real relay; follows the inactive-environment rule in `AGENTS.md`.
    - Cons: needs two profiles and the attach flow.
  - **Rely on the automated tests.**
    - Pros: no setup.
    - Cons: a same-origin `EventSource` and a real tab reconnect stay unproven.

### 2. Older peers on real releases

**Problem.** Older peers are tested by the shape of what they send and read, not with a real older build.

**Context.** A stream with no `relayedEvents` parameter gets the old name and a `resync` per node on reconnect; an older command node answers with no `perNodeEvents`. Both are in the [register](../../architecture/version-compatibility.md#register). The first is counted as `relayed-node-event.legacy-stream`.

**Investigation.** Not run: it needs a real release of each side from before per-node names. The older renderer's request and listener were read from the code on `main` at `1e6d56391` (`web-gateway.ts` `eventStreamPath`, `node-events.ts`) and the tests send the same request.

**Decisions.**

- **How to qualify?**
  - **Run the last release before E18 against this build, once each way (recommended).** Check that the sidebar badge updates and recovers after a reconnect, and that the counter moves only for the older renderer.
    - Pros: proves the path the support window promises, on real code.
    - Cons: needs a built older release on an isolated profile.
  - **Watch the counter on real machines.**
    - Pros: no setup.
    - Cons: it shows that the path is used, not that it works.

## Related

- to-do 1202 task 11 (retired 2026-11-10)
- [Command nodes](../../architecture/command-nodes.md)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do moved there on 2026-11-10: task 3 (a production profile of the frame costs, taken only if gateway fan-out shows up in another investigation) and task 4 (the desktop's relay between two real machines).
