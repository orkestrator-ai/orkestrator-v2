import { expect, test } from "bun:test";
import { join } from "node:path";
import { RESULT_SENTINEL } from "./session-manager-prompt-mcp-sync.live-probe.js";

const liveTest = process.env.RUN_LIVE_CLAUDE_MCP === "1" ? test : test.skip;

// Runs the pinned Claude CLI for real (no credentials, no model call) and
// proves what `session-manager-prompt-mcp-sync.ts` relies on. Run it with
// `mise run verify:claude:mcp-live` on every Claude SDK or CLI bump.
liveTest(
  "a running Claude CLI unloads removed and renamed MCP servers",
  async () => {
    const packageRoot = join(import.meta.dir, "..", "..");
    const probePath = join(import.meta.dir, "session-manager-prompt-mcp-sync.live-probe.ts");
    // The session-manager suites mock the SDK module-wide, so the probe runs
    // in a clean process. It handles SIGTERM itself so a timeout closes its CLIs.
    const probe = Bun.spawn([process.execPath, probePath], {
      cwd: packageRoot,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
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
      if (probe.exitCode === null) probe.kill();
    }
    expect(exitCode, stderr).toBe(0);
    const line = stdout.split("\n").find((candidate) => candidate.startsWith(RESULT_SENTINEL));
    if (!line) throw new Error(`Probe stdout had no ${RESULT_SENTINEL} line:\n${stdout}`);
    const result = JSON.parse(line.slice(RESULT_SENTINEL.length));

    // Why the takeover exists. If this starts failing, the CLI now unloads
    // launch servers itself: the takeover is harmless, but say so in the
    // header of `session-manager-prompt-mcp-sync.ts`.
    expect(result.bare).toEqual({
      servers: ["alpha"],
      tools: ["mcp__alpha__probe_alpha"],
      stale: [],
      alive: ["alpha"],
    });
    // A removal and a rename leave nothing of the old server: no status row,
    // no tool offered to the model, no process.
    expect(result.remove).toEqual({
      servers: ["keep"],
      tools: ["mcp__keep__probe_keep"],
      stale: [],
      alive: ["keep"],
    });
    expect(result.rename).toEqual({
      servers: ["beta"],
      tools: ["mcp__beta__probe_beta"],
      stale: [],
      alive: ["beta"],
    });
    // A server only the CLI's own settings load knew about cannot be
    // unloaded in place, so the sync reports it for refusal instead.
    expect(result.fileOnly).toEqual({
      servers: ["keep", "remote"],
      tools: ["mcp__keep__probe_keep"],
      stale: ["remote"],
      alive: ["keep"],
    });
  },
  120_000,
);
