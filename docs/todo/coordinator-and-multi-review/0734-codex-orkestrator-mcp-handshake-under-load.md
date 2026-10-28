# Codex workflow turns refused when the Orkestrator MCP handshake is slow

Checked against `main` at `a6a3105f9` (2026-10-28).

On arktech-mini on 2026-10-28, from about 09:13Z, most Multi Reviews failed
on Codex preparation and consolidation turns with
`codex rejected the prompt (HTTP 424): Codex could not offer submit_validation_plan|submit_consolidated_review to this session: the orkestrator MCP server could not list its tools`.
About ten reviews were running at once and the host load average was 100 to
140. One review (env `59847e5f`) got through, so the failure was
intermittent.

## Task analysis

Analysed 2026-10-28 against `main` at `a6a3105f9`.

### Tasks

1. **Give the handshake a budget that survives host load**: raise the Codex `startup_timeout_sec` for the Orkestrator servers and make the bridge's tool check wait past it. Status: done (2026-10-28).
2. **Qualify under load**: rerun about ten concurrent Multi Reviews with Codex preparation and consolidation on a loaded host. Status: open.
3. **Find what makes the backend's `/mcp` handshake slow**: the same backend also timed out agent `send_message` and `check_inbox` calls overnight, and `launch_multi_review` control calls. Status: open.

### 1. Give the handshake a budget that survives host load

**Problem.** Every thread-scoped Orkestrator MCP server had `startup_timeout_sec: 3` (`bridges/codex-bridge/src/engine/app-server-engine.ts`, the `mcp_servers.orkestrator`, `orkestrator-design` and `orkestrator-artifacts` entries). The process-level default had the same value (`bridges/codex-bridge/src/codex-config.ts`). If Codex cannot finish `initialize` and `tools/list` in that time, it marks the server failed for the life of the thread and reports `toolsError`. `classifyMcpToolAvailability` (`bridges/codex-bridge/src/engine/mcp-tool-availability.ts`) treats `toolsError` as a definite "missing". `app-server-runtime-prompt.ts` then answers 424 before the turn starts, and nothing retries.

**Context.** The availability check exists so that a workflow turn without its submit tool fails at once instead of running to the end and making the backend wait minutes (`mcp-tool-availability.ts` header). It polls `mcpServerStatus/list` for up to 5 s and treats `starting` as undecided, so with a 3 s budget a slow handshake always settled as failed inside that 5 s window.

**Investigation.** Evidence from the logs on arktech-mini, read-only:
- The backend (pid 59035) ran from 02:10:48Z and never restarted. It is the process listening on the agent MCP port `127.0.0.1:49248`, so the MCP server did not crash and its port did not change.
- In `~/.codex/logs_2.sqlite`, from 09:50Z on, the orkestrator server repeatedly fails with `MCP server startup failed server_name="orkestrator" error=timed out handshaking with MCP server after 3s`. Next to that are `streamable HTTP post_message failed … endpoint_path="/mcp" mcp_method="initialize"` and `"notifications/initialized"`, then `rmcp::transport::worker … worker quit with fatal: Transport channel closed`. Codex's own retry (`attempt=1 max_attempts=3 delay_ms=250`) ran inside the same 3 s budget.
- The Orkestrator log has no `rmcp::transport::worker` errors on 2026-10-26, three each in the 2026-10-27T02, 2026-10-28T00 and 2026-10-28T02 hours, then 28 in the 09 hour (the first at 09:13:32Z) and 14 in the 10 hour. That growth matches the burst of concurrent reviews. The bridge suppresses the text of those stderr lines (`process-supervisor.ts`, `describeChildStderrLine`). The Codex log database holds no matching rows before 09:50Z, so the 09:13Z to 09:50Z failures are shown only by these counts.
- None of the logs records an auth or token failure.

**Decisions.**

- **How large a budget?**
  - **15 s for every Orkestrator server, thread-scoped and process-level, with the bridge's check waiting 20 s (chosen).**
    - Pros: an idle backend still answers in milliseconds, so a turn waits only while the backend is slow. A slow handshake now ends `connected` instead of failing the thread.
    - Cons: on an overloaded host the first turn of a thread can wait up to 15 s for MCP startup, and a backend that never answers still fails, now after 15 s.
  - **Reload the thread and retry when startup failed.**
    - Pros: recovers even after a failure longer than any fixed budget.
    - Cons: a fresh preparation or consolidation thread has no rollout, so it cannot be resumed and would need a new thread. That is more state handling for the same load symptom.

### 2. Qualify under load

**Controlled live qualification (2026-10-28).** Added
`bridges/codex-bridge/src/app-server/mcp-startup.live.test.ts`, which runs the
pinned Codex 0.164.0 through the real engine against a loopback streamable HTTP
MCP fixture. Ten simultaneous `initialize` requests delay their responses by
4, 10, 14 or 17 seconds. No model turn or real credential is used. The fixture
records monotonic time from receiving `initialize` to receiving `tools/list`;
the engine uses the default 20-second availability wait.

The first passing run measured:

| Delayed initialize | Threads | Measured handshake | Result |
| --- | --- | --- | --- |
| 4 s | 3 | 4.006 s | available |
| 10 s | 3 | 10.003–10.004 s | available |
| 14 s | 2 | 14.003 s | available |
| 17 s | 2 | no tools/list | missing, `could not list its tools` after 14.819 s from receiving initialize |

Codex starts its timeout before the fixture receives `initialize`, explaining
why the failed connection settles slightly under 15 seconds on this clock.
The host had 18 logical CPUs; load averages before the run were
52.52 / 50.68 / 53.95 and after it 61.09 / 52.65 / 54.59.
The helper tests additionally pin 15 and 20 seconds exactly, exercise both
`connected` and `failed` at the startup deadline, and exhaust the full default
window while still starting. The HTTP route tests pass through the real
runtime, engine and helper: no turn or journal record while starting, 424 for
a definite failure, and 202 on connection or expiration with an unverified
listing.

Reproduce and retain content-free measurements:

```sh
RUN_LIVE_CODEX_APP_SERVER=1 \
CODEX_MCP_STARTUP_EVIDENCE_PATH=/tmp/codex-mcp-startup-evidence.json \
mise run test:logged -- --name mcp-startup-live -- \
  bun test ./bridges/codex-bridge/src/app-server/mcp-startup.live.test.ts \
  --preload ./tests/setup-node.ts --parallel=1
```

**Remaining production qualification.** This establishes real Codex timeout
behavior with concurrent delayed HTTP responses on a busy host. It does not
reproduce ten complete Multi Reviews, the production backend's event-loop
saturation, or the original load average of 100–140. That wider operational
qualification remains open; the original handshake duration cannot be inferred
from the old timeout logs.

### 3. Find what makes the backend's `/mcp` handshake slow

**Problem.** An MCP handshake on localhost taking more than 3 s means the backend's event loop, or the host, was saturated. The longer budget hides that but does not remove it. The overnight agent mail timeouts and the `launch_multi_review` timeouts point the same way.

**Context.** The agent MCP server shares the single backend process (`bun`) with every other client, bridge stream and SSE connection.
