# Live MCP panel keeps a failed row after a probe reconnect brings it up

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab7`. Found while running
`e2e/agent-testing/mcp-ui-matrix.spec.ts` for
[0039](0039-mcp-management.md) task 14.

### Tasks

1. **Find why the panel keeps the old row and fix it**: after a probe reconnect brings a failed Claude server up, the backend projection reads `connected` but the rendered panel still shows it failed ("1 down") for over 30 seconds. Status: open.

### 1. Find why the panel keeps the old row and fix it

**Problem.** The spec's test "live panel: reconnect a failing server beside a
healthy one, then reload" (task 8 of 0039) fails at the step "reconnect from
the panel brings the failing server up". The click sends the reconnect, and
`get_native_agent_projection` read by the test reports `mcpui-late`
`connected` within 60 seconds. The panel still reads "Tools 26 · 4 servers ·
1 down" with `mcpui-late` "failed" and "Connection closed" 30 seconds later.
A user who reconnects a fixed server is told it is still down.

**Context.** The test passed on 2026-10-31 (task 8). Since then the probe
reconnect path changed: 1163 (2026-11-01) kept the session's own list and
took only the acted-on row from the probe, and 1240 serves rows a session
last saw as `connecting` as `unknown` while no CLI runs
(`inventoryWithoutCli` in
`bridges/claude-bridge/src/services/session-manager-catalog.ts`). The
backend's `performProjectionMcpAction`
(`apps/backend/src/core/native-agent-session-operations.ts`) calls
`invalidateProjection` after the action. The panel is `McpServersPanel`,
fed by the tab's projection (`AgentInfoButton.tsx`).

**Investigation.** Runs on 2026-11-06, profile `mcp0039-t14`
(`dev:test --fixture --no-agent-credentials --agent-platforms claude
--headless`), host load 10 to 13:

- With this branch's spec: failed twice (once at an earlier step because of
  [7220](../cross-cutting/7220-agent-tools-port-shadowed-by-loopback-listener.md),
  once here after a reset).
- With the spec at `HEAD` (`git show HEAD:e2e/agent-testing/mcp-ui-matrix.spec.ts`),
  `-g "healthy one"`, on its own: failed here the same way. So it is not
  caused by the task 14 changes, and it fails alone, so it is not a flake.
- The new task 14 test in the same file, whose probe reconnect turns an
  `unknown` row `connected`, saw the panel update in all 4 of its runs that
  day.

Not yet known: whether the renderer refetches the projection after the
action, whether its read is answered from a sync revision that the
invalidation does not move, and whether a reload shows `connected` (the test
stops before its reload step). A first guess, not checked, is that the
`failed` row reaches the renderer through a projection revision that the
probe's answer does not advance.

**Decisions.**

- **How to find the cause?**
  - **Run the test with Playwright's trace and compare the projection
    responses the renderer receives after the action with the test's own
    read; then fix whichever side keeps the old row (recommended).**
    - Pros: tells a renderer cache from a backend revision fault from one run;
      needs no credentials.
    - Cons: the trace is over the 64 MiB sanitizer limit for this test, so
      capture it with a narrower trace or read the responses with a request
      listener instead.
  - **Relax the assertion to accept the panel after a reload.**
    - Pros: green test.
    - Cons: hides a real user-visible fault.

## Related

- [0039-mcp-management.md](0039-mcp-management.md) tasks 8, 13 and 14.
