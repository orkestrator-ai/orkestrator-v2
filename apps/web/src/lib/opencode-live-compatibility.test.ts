import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const liveTest =
  process.env.RUN_LIVE_OPENCODE_COMPATIBILITY === "1" ? test : test.skip;

liveTest(
  "OpenCode CLI and the real v2 SDK complete a local server round trip",
  async () => {
    const webManifest = JSON.parse(
      await readFile(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const expectedVersion = webManifest.dependencies?.["@opencode-ai/sdk"];
    expect(expectedVersion).toMatch(/^\d+\.\d+\.\d+$/);
    if (!expectedVersion) {
      throw new Error("apps/web must pin @opencode-ai/sdk");
    }

    // The web test preload installs Happy DOM, whose browser fetch correctly
    // rejects this cross-origin loopback request. Run the real CLI/SDK probe in
    // a clean Bun process so it uses Bun's native server-side fetch instead.
    const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
    const probe = Bun.spawn(
      [process.execPath, join(import.meta.dir, "opencode-live-compatibility-probe.ts")],
      {
        cwd: repoRoot,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
      probe.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(stdout.trim()) as {
      cliVersion: string;
      healthVersion: string;
      sdkVersion: string;
      sessionCount: number;
    };
    expect(result).toEqual({
      cliVersion: expectedVersion,
      healthVersion: expectedVersion,
      sdkVersion: expectedVersion,
      sessionCount: 0,
    });
  },
  30_000,
);
