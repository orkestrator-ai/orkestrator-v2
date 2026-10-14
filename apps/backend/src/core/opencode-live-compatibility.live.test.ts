import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RESULT_SENTINEL } from "../../../../scripts/opencode-live-compatibility-probe.js";

const liveTest = process.env.RUN_LIVE_OPENCODE_COMPATIBILITY === "1" ? test : test.skip;

liveTest(
  "OpenCode CLI and the real v2 SDK complete a local server round trip",
  async () => {
    const backendManifest = JSON.parse(
      await readFile(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const expectedVersion = backendManifest.dependencies?.["@opencode-ai/sdk"];
    expect(expectedVersion).toMatch(/^\d+\.\d+\.\d+$/);
    if (!expectedVersion) {
      throw new Error("apps/backend must pin @opencode-ai/sdk");
    }

    // Run the probe exactly as its CLI entry point, in a clean Bun process: it
    // owns `opencode serve` and the SIGTERM teardown that a test timeout relies
    // on, and no test preload can reach its fetch or SDK client.
    const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
    const probePath = join(repoRoot, "scripts", "opencode-live-compatibility-probe.ts");
    // A renamed probe would otherwise surface as an opaque non-zero exit.
    expect(await Bun.file(probePath).exists(), `missing probe at ${probePath}`).toBe(true);

    const probe = Bun.spawn([process.execPath, probePath], {
      cwd: repoRoot,
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
      // `opencode serve` is the probe's child, so it is this test's grandchild
      // and out of reach of Bun's dangling-process reaper. On a timeout Bun kills
      // this process without unwinding here, so the probe also handles SIGTERM
      // itself; this covers the paths where the test body does unwind.
      if (probe.exitCode === null) probe.kill();
    }

    expect(exitCode, stderr).toBe(0);
    const resultLine = stdout.split("\n").find((line) => line.startsWith(RESULT_SENTINEL));
    if (!resultLine) {
      throw new Error(`Probe stdout had no ${RESULT_SENTINEL} line:\n${stdout}`);
    }
    const payload = resultLine.slice(RESULT_SENTINEL.length);
    let result: unknown;
    try {
      result = JSON.parse(payload);
    } catch (error) {
      throw new Error(`Could not parse the probe result: ${String(error)}\nstdout:\n${stdout}`);
    }

    expect(result).toEqual({
      cliVersion: expectedVersion,
      health: { healthy: true, version: expectedVersion },
      // The probe reports the *installed* SDK version, so this is a real
      // pin-vs-installed cross-check.
      sdkVersion: expectedVersion,
      sessionCount: 0,
    });
  },
  30_000,
);
