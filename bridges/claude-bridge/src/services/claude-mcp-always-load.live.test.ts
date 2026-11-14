import { expect, test } from "bun:test";
import { join } from "node:path";
import { ALWAYS_LOAD_RESULT_SENTINEL } from "./claude-mcp-always-load.live-probe.js";

// Runs the pinned Claude CLI for real (no credentials, a loopback model) and
// proves what the backend's workflow-result tools rely on
// (`WORKFLOW_RESULT_TOOL_META` in `@orkestrator/protocol/workflow-results`):
// a tool listing `_meta["anthropic/alwaysLoad"]` is never deferred behind
// ToolSearch. Runs in the slow tier (`mise run test:slow`) and CI. Recheck on
// every Claude CLI bump.
test("an MCP tool listing anthropic/alwaysLoad is offered without ToolSearch", async () => {
  const packageRoot = join(import.meta.dir, "..", "..");
  const probePath = join(import.meta.dir, "claude-mcp-always-load.live-probe.ts");
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
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith(ALWAYS_LOAD_RESULT_SENTINEL));
  if (!line) throw new Error(`Probe stdout had no ${ALWAYS_LOAD_RESULT_SENTINEL} line:\n${stdout}`);
  const result = JSON.parse(line.slice(ALWAYS_LOAD_RESULT_SENTINEL.length)) as {
    status: string;
    offered: Array<{ name: string; deferred: boolean }>;
  };

  expect(result.status).toBe("connected");
  // Tool search is on, so the ordinary tool is only reachable through it...
  expect(result.offered).toContainEqual({ name: "ToolSearch", deferred: false });
  expect(result.offered.map((tool) => tool.name)).not.toContain("mcp__fixture__other_tool");
  // ...while the tool that lists alwaysLoad is in the first request in full.
  expect(result.offered).toContainEqual({ name: "mcp__fixture__submit_result", deferred: false });
}, 120_000);
