# A tmux interactive terminal no client detached keeps capturing

## Task analysis

Analysed 2026-11-11 against main at 498b68766, on beelink2 (Linux), while
deciding [0048](0048-recurring-work-qualification.md) task 12's B19
candidate (demand gating for interactive tmux capture).

### Tasks

1. **Stop the capture loop of an interactive terminal no client is attached to**: a page reload, a closed window or a lost connection never sends `claude_tmux_detach_interactive_terminal`, so the backend keeps capturing that pane until the environment's tmux cleanup or a backend restart. Status: open.
2. **Observe the orphan live before and after the fix**: show the extra capture loop after a reload, and its absence after the fix, on a `dev:test` profile with a fake model. Status: open (depends on 1).

### 1. Stop the capture loop of an interactive terminal no client is attached to

**Problem.** An attached claude-tmux interactive terminal is captured every
250 ms, backing off to 1 s while the pane is unchanged (B19,
`InteractiveTmuxTerminalManager` in `apps/backend/src/core/tmux-interactive.ts`).
The loop stops only on `detach`, `detachEnvironment` (the environment's tmux
cleanup, `cleanupEnvironmentTmux` in `tmux-commands.ts`) or `detachAll`
(backend shutdown). The client detaches in the effect cleanup of
`ClaudeTmuxInteractiveTerminal.tsx`, which React runs on unmount but not on a
page reload, a closed window, a renderer crash or a lost connection. Each such
exit leaves a loop running for nobody, and a reload creates a new terminal id
(`create` mints a UUID), so repeated reloads add loops.

**Context.** Measured on 2026-11-11 (0048,
[Client-only and validation candidates](0048-recurring-work-qualification.md#client-only-and-validation-candidates-2026-11-11-linux)):
a local `tmux capture-pane -p -e` costs about 2 ms wall and 1.6 to 1.8 ms CPU,
but a container capture is one `docker exec` (`containerExecArgs`), about 50 ms
wall and 60 to 70 ms CPU across the CLI, the daemon, containerd and runc on a
rootless daemon. One orphaned container loop at the 1 s idle cadence therefore
costs about 6 to 7 % of one core for as long as the environment runs, and
about four times that while the pane changes. The gateway's event fan-out
(`backend-emit.ts`) broadcasts `terminalOutputEvents.at(id)` to every client,
so the backend has no subscriber count to gate on, and `CommandContext` names
no client or connection.

**Investigation.** Found by reading the code paths above; the orphan was not
observed live (task 2). Not started beyond that.

**Decisions.**

- **What tells the backend a client still wants the pane?**
  - **A client lease: the attached terminal renews it on a timer (for example every 15 s), and the backend detaches a terminal whose lease has lapsed for 45 s (recommended).**
    - Pros: covers every way a client can vanish, including a crash and a cut link; the same shape as the frontend activity lease (B12); a hidden document can let the lease lapse on purpose, which gates on visibility too.
    - Cons: a new command (contract manifest and version compatibility), and an older client that never renews must keep today's behaviour, so the backend can only enforce the lease on terminals created by a client that announced it.
  - **Tie the terminal to the gateway connection that created it and detach it when that connection closes, after a short reconnect grace.**
    - Pros: no renewal traffic.
    - Cons: commands carry no connection identity today, Electron IPC and the browser gateway would each need it, and a reconnecting client would have to re-claim its terminal.
  - **Detach on `pagehide` in the client.**
    - Pros: a small client-only change.
    - Cons: best-effort; a crash, a cut link or a request that does not finish before unload still leaves the loop.

### 2. Observe the orphan live before and after the fix

**Problem.** Task 1's cost is inferred from the code and from the measured
price of one capture; the orphan itself has not been seen running.

**Context.** A claude-tmux tab needs the Claude CLI in tmux; the loopback
Anthropic model of `e2e/agent-testing/fake-anthropic-model.ts` avoids a billed
turn. Recurring diagnostics have no kind for B19's loop (see
[7567](7567-tmux-tab-loop-recurring-kind.md) for the tab loop's missing kind),
so the count would come from Docker's own exec count or a process sampler.

**Investigation.** Not started.

**Decisions.**

- **How to count the loop?**
  - **Count `docker exec … tmux capture-pane` calls a minute for a container tab before and after a reload, the way 7567 counted the tab loop (recommended).**
    - Pros: measures what the host pays, independent of the backend's own counters.
    - Cons: needs a container environment, which beelink's Docker address pools have limited before (7100 task 2).
  - **Add a recurring kind for B19 and read it from diagnostics.**
    - Pros: a lasting gauge.
    - Cons: a code change before the measurement; belongs with 7567's decision on kinds.

## Related

- [0048-recurring-work-qualification.md](0048-recurring-work-qualification.md) task 12 (decision C5) and [recurring-work.md](../../architecture/recurring-work.md) row B19.
- [7567-tmux-tab-loop-recurring-kind.md](7567-tmux-tab-loop-recurring-kind.md): the claude-tmux tab loop's container cost.
