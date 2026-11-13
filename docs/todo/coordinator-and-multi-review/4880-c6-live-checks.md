# Live checks for a coordinator conversation that failed to start

## Task analysis

Analysed 2026-11-05 against main at 0194a0675, with coordinator batch C6 (Errors and dead ends) applied. Task 3 done 2026-11-13 against main at 17d28238c.

### Tasks

3. **A real older renderer against this backend**: needs an older build running. Status: done (2026-11-13: v2.36.1's renderer against this backend, with a conversation whose bridge failed to start; see Recorded run).

### 3. A real older renderer against this backend

**Problem.** The mixed-version path is tested by the shape an older client reads, not with an older client.

**Context.** From coordinator report C6, part `0020`, task 1. `docs/architecture/version-compatibility.md` holds the rows and the removal condition.

**Investigation.** `coordinator-service.test.ts` covers the workspace field an older renderer reads and the `ensure` it sends. `coordinator-runtime.test.ts` covers the refusal it shows. No older build was run, because the batch could not contact other real nodes or install a release.

**Decisions.**

- **How to check it?**
  - **Open a browser tab from a release before C6, upgrade the backend under it, and fail a conversation (recommended).**
    - Pros: the real pairing the window promises.
    - Cons: needs a release build and an upgrade on a throwaway profile.
  - **Leave it to the usage counter `coordinator-ensure.conversation-errors-cleared`.**
    - Pros: no work.
    - Cons: it shows that the path ran, not that it read well.

## Recorded run (2026-11-13, Linux)

Host: Linux (Arch), Bun 1.4.4, headless Chromium 1400×900, this branch at
`608842687`. Started with the committed launcher:

```bash
bun scripts/older-release-stack.ts renderer --tag v2.36.1 \
  --toolchain-bin-dir output/older-release/v2.36.1/check/failing-toolchain
```

That is this checkout's backend (2.38.1-beta) serving v2.36.1's renderer,
built from its tag, on a throwaway root under `output/older-release/`:
`agent-test` flavour, loopback, Docker unreachable, no credentials, no
provider turn. v2.36.1 is the last Stable release before C6: it has neither
`retry_coordinator_conversation` nor per-conversation `startupError`. A local
Git project was added and its main coordinator conversation assigned `claude`
through the gateway API; the v2.36.1 tab opened the project's Coordinator
panel.

The failure was real, through `startLocalServerUnlocked`: the toolchain
directory held a `bun` that exits 1 and a placeholder `claude`, so the
coordinator's Claude bridge exited before it became healthy. A first attempt
without a `claude` there was refused before any bridge ran ("Claude Code is
not installed in this agent-test profile's toolchain"), which records no
`startupError` and so does not exercise C6.

| Step | What the v2.36.1 tab showed | Backend (read with `keepConversationErrors`) |
| --- | --- | --- |
| Panel opened, pane connects | The pane: "Connection Failed. This coordinator conversation is not ready because it could not start: claude server exited before becoming healthy (code 1, signal null)", with Retry. The rest of the panel (tabs, Work list, Pause) as normal; no workspace banner | `lifecycleState: "ready"`; the main conversation's `startupError` set to the same text |
| The pane's Retry | The same refusal; no bridge was started | Error kept; counter unchanged |
| Reload, then open the project again | Opening the panel ran `ensure_project_coordinator` without `keepConversationErrors`: the error was cleared, the pane connected, the start failed again and the pane showed the same text | `coordinator-ensure.conversation-errors-cleared` 1 → 2 (one per panel open that found an error) |

No page errors. The version reminder read "Orkestrator has been updated. This
page is Orkestrator 2.36.1, but the server now runs 2.38.1-beta", the right
direction for this pairing. The register row "Renderers before per-conversation
startup errors" ([version-compatibility.md](../../architecture/version-compatibility.md#register))
holds as written: an older tab reads the failure as its connection failure,
names the error, and recovers only by opening the panel.

## Assumptions and decisions

### Task 3: v2.36.1 as the older renderer

Chose v2.36.1, the newest Stable release without C6 (C6 first shipped in
v2.36.4-beta), over v2.21.0: v2.21.0 is older but its coordinator panel
predates more of today's coordinator, so a failure there would test more than
C6's skew. Built from its tag rather than npm, which carries no web renderer.

### Task 3: a stub `bun` as the failure

Chose a toolchain directory whose `bun` exits at once, because it fails the
bridge start inside the code path that records `startupError`, deterministically
and with no provider. Removing a built bridge from the checkout would have
worked too, but changes files other work in the worktree uses.

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (tasks 1 and 2, the signed-in provider runs) moved there on 2026-11-10.
