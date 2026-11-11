# The client-outage spec's four backend-restart cases fail on beelink2

## Task analysis

Analysed 2026-11-11 against `main` at `14df96544`, from the live run of
`client-outage.spec.ts` for to-do 7340 (retired 2026-11-11).

### Tasks

1. **Find why no client reconnects after the spec restarts the backend**: the four restart cases failed 4 of 4 in two runs; the seven other cases passed. Status: open.

### 1. Find why no client reconnects after the spec restarts the backend

**Problem.** `e2e/agent-testing/client-outage.spec.ts` stops the profile's
backend and starts a replacement on the same data, port and token
(`stopBackend` and `startBackend`). On beelink2 on 2026-11-11 nothing it
measures came back after that replacement started:

- `backend restart, direct clients on http-sse` and `… on websocket` (line
  1056): the terminal stream never answered a request after the restart
  (`terminalBackAt` stayed `null` for 40 s, line 1132).
- `quick backend restarts: first reconnect against the banner's delay` (line
  1237): the main event stream never answered after the first restart
  (`firstAnswered(link, "main-stream", …)` stayed `null` for 40 s, line 1267).
- `backend restart, real UI` (line 1289): the tab never reached the gateway's
  login form (`expected 1, received 0` after 20 s, line 1330).

**Context.** The run was on a disposable `dev:test --profile t7340-ui --fixture
--no-agent-credentials --agent-platforms codex --headless` profile with
`ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, started with `DOCKER_HOST` pointing
at a disposable rootless daemon (`mise run docker:disposable`) so the app did
not open its Docker permission dialog. Host load average was 40 to 60 from
other worktrees' suites throughout. Commands:

```bash
ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=1800000 \
ORKESTRATOR_AGENT_TEST_PROFILE=t7340-ui ORKESTRATOR_AGENT_TEST_LIVE_OUTAGE=1 \
  mise run test:logged -- --name t7340-client-outage -- bunx playwright test \
  --config e2e/agent-testing/playwright.browser.config.ts client-outage.spec.ts --workers=1
# then the restart cases alone, same profile:
  … client-outage.spec.ts --grep restart --workers=1
```

Results: first run 7 passed, 4 failed (12.3 min); the rerun of the four
restart cases failed all four again (5.5 min), with the same assertions. The
seven passing cases cover dropped and silent links and terminal backpressure on
both transports. The 2026-10-31 run recorded in
[agent-testing.md](../../development/agent-testing.md#live-client-outage)
passed the restart cases, so this is either a regression since then or
something in this host or profile.

**Investigation.** Not started beyond the two runs. The profile's own logs
under its `data/logs` show nothing from the replacement backend: the spec
starts it in-process through `BackendProcess` with `onEvent: () => undefined`,
so its output is not kept. The visible-text helper that 7340 qualified is used
only by the backpressure case (line 816), which passed on both transports, so
it is not involved.

**Decisions.**

- **Where to start?**
  - **Keep the replacement backend's output (an `onEvent` that writes to the run's artifacts), then rerun the restart cases on a fresh profile with no `DOCKER_HOST` override (recommended).**
    - Pros: shows directly whether the replacement started, bound the port and served requests; the fresh profile removes the disposable daemon from the picture.
    - Cons: a test change, small, to keep diagnostics.
  - **Bisect `main` from the 2026-10-31 pass.**
    - Pros: finds the change if it is a regression.
    - Cons: each step is a 5 min live run on a profile; slow if it is environmental.

## Related

- [agent-testing.md, Live client outage](../../development/agent-testing.md#live-client-outage): the spec's guide and the 2026-10-31 run.
- To-do 7340 (retired 2026-11-11, `git show 14df96544:docs/todo/cross-cutting/7340-shared-terminal-visible-text-helper.md`), whose live run found this.
