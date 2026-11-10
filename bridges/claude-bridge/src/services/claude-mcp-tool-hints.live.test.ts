import { expect, test } from "bun:test";
import { join } from "node:path";
import { HINTS_RESULT_SENTINEL } from "./claude-mcp-tool-hints.live-probe.js";

// Runs the pinned Claude CLI for real (no credentials, a loopback model) and
// proves what `claude-mcp-tool-hints.ts` relies on. Runs in the slow tier
// (`mise run test:slow`) and CI. Recheck on every Claude CLI bump.
test("a Claude MCP approval finds its tool's hints in the CLI's status", async () => {
  const packageRoot = join(import.meta.dir, "..", "..");
  const probePath = join(import.meta.dir, "claude-mcp-tool-hints.live-probe.ts");
  // The session-manager suites mock the SDK module-wide, so the probe runs
  // in a clean process. It handles SIGTERM itself so a timeout closes its CLI.
  const probe = Bun.spawn([process.execPath, probePath], {
    cwd: packageRoot,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => probe.kill(), 90_000);
  let stdout = "";
  let stderr = "";
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
      probe.exited,
    ]);
  } finally {
    clearTimeout(deadline);
    if (probe.exitCode === null) probe.kill();
  }
  expect(exitCode, stderr).toBe(0);
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(HINTS_RESULT_SENTINEL));
  if (!line) throw new Error(`Probe stdout had no ${HINTS_RESULT_SENTINEL} line:\n${stdout}`);
  const result = JSON.parse(line.slice(HINTS_RESULT_SENTINEL.length));

  // The status lists configured and bare names, and keeps only `true` hints
  // under the shared keys. If a `false` or `idempotent` starts arriving, the
  // card can use it as it is; update the header of `claude-mcp-tool-hints.ts`.
  expect(result.status).toEqual({
    name: "hint.srv x",
    status: "connected",
    tools: [
      { name: "wipe.disk tool", annotations: { destructive: true } },
      { name: "read_thing", annotations: { readOnly: true, openWorld: true } },
      { name: "plain", annotations: {} },
    ],
  });
  // The model is offered the rewritten call names.
  expect([...result.offered].sort()).toEqual([
    "mcp__hint_srv_x__plain",
    "mcp__hint_srv_x__read_thing",
    "mcp__hint_srv_x__wipe_disk_tool",
  ]);
  // `canUseTool` names the configured server, and the bridge's lookup, made
  // while the CLI waits on the answer, finds each tool's hints in time.
  expect(result.decisions).toEqual([
    {
      toolName: "mcp__hint_srv_x__wipe_disk_tool",
      serverName: "hint.srv x",
      hints: { destructive: true },
      readWithinTimeout: true,
    },
    {
      toolName: "mcp__hint_srv_x__read_thing",
      serverName: "hint.srv x",
      hints: { readOnly: true, openWorld: true },
      readWithinTimeout: true,
    },
  ]);
}, 120_000);
