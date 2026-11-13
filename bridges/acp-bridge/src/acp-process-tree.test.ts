import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { DEFAULT_TERM_GRACE_MS, termGraceMs } from "./acp-process-tree.js";

// Starts real processes: the probe, its agent and the agent's descendant. The
// probe's own 20 s timeout must fire before Bun's 5 s default would.
setDefaultTimeout(30_000);

type ProbeRun = { error?: Error; status: number | null; stdout: string };

// The probe's descendant ignores SIGTERM on purpose, so each run waits out the
// SIGTERM grace before the kill. A short grace keeps that wait small; the
// production default stays pinned by the test below.
function runProbe(crash: boolean): Promise<ProbeRun> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    const probe = spawn(
      process.execPath,
      [resolve(import.meta.dir, "testing/process-tree-probe.ts"), ...(crash ? ["--crash"] : [])],
      {
        // A probe that does not exit by itself (a live child or a pending
        // timer holding its loop) fails here rather than hanging the suite.
        timeout: 20_000,
        env: { ...process.env, NODE_ENV: "test", ACP_TERM_GRACE_MS: "200" },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    probe.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    let error: Error | undefined;
    probe.once("error", (cause) => (error = cause));
    probe.once("close", (status) => resolvePromise({ error, status, stdout }));
  });
}

describe("AcpProcess tree ownership", () => {
  test("the TERM grace defaults to 2 s and only a valid override shortens it", () => {
    expect(DEFAULT_TERM_GRACE_MS).toBe(2_000);
    expect(termGraceMs({})).toBe(2_000);
    expect(termGraceMs({ ACP_TERM_GRACE_MS: "200" })).toBe(200);
    expect(termGraceMs({ ACP_TERM_GRACE_MS: "0" })).toBe(2_000);
    expect(termGraceMs({ ACP_TERM_GRACE_MS: "soon" })).toBe(2_000);
  });

  test("the TERM grace override never lengthens the grace past the default", () => {
    expect(termGraceMs({ ACP_TERM_GRACE_MS: "2000" })).toBe(2_000);
    expect(termGraceMs({ ACP_TERM_GRACE_MS: "2001" })).toBe(2_000);
    expect(termGraceMs({ ACP_TERM_GRACE_MS: "60000" })).toBe(2_000);
    expect(termGraceMs({ ACP_TERM_GRACE_MS: String(Number.MAX_SAFE_INTEGER) })).toBe(2_000);
  });

  // Each probe owns its process group and descendants, so the two shutdown
  // paths run side by side and each test reads its own result.
  const runs = new Map<boolean, Promise<ProbeRun>>();
  beforeAll(() => {
    if (process.platform === "win32") return;
    for (const crash of [false, true]) runs.set(crash, runProbe(crash));
  });

  for (const crash of [false, true]) {
    test.skipIf(process.platform === "win32")(
      crash
        ? "backend reaps the agent and a TERM-resistant descendant after bridge SIGKILL"
        : "close reaps a TERM-resistant descendant after its leader exits",
      async () => {
        // Both shutdown paths must reach descendants after their parent exits.
        const probe = await runs.get(crash)!;
        expect(probe.error).toBeUndefined();
        expect(probe.status).toBe(0);
        const result = JSON.parse(probe.stdout.trim().split("\n").at(-1)!);
        expect(result).toEqual({ leaderExited: true, descendantExited: true });
      },
    );
  }
});
