import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type PackageManifest = {
  dependencies?: Record<string, string>;
};

type InstalledSdkManifest = {
  version?: string;
  claudeCodeVersion?: string;
};

describe("Claude Agent SDK runtime compatibility", () => {
  test("loads the real pinned SDK and constructs the query interface used by the bridge", async () => {
    const packageRoot = join(import.meta.dir, "..");
    const bridgeManifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    ) as PackageManifest;
    const expectedSdkVersion =
      bridgeManifest.dependencies?.["@anthropic-ai/claude-agent-sdk"];
    expect(expectedSdkVersion).toMatch(/^\d+\.\d+\.\d+$/);

    const installedSdkRoot = join(
      packageRoot,
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk",
    );
    const installedManifest = JSON.parse(
      await readFile(join(installedSdkRoot, "package.json"), "utf8"),
    ) as InstalledSdkManifest;
    expect(installedManifest.version).toBe(expectedSdkVersion);
    expect(installedManifest.claudeCodeVersion).toMatch(/^\d+\.\d+\.\d+$/);

    // Run in a separate process because session-manager.test.ts intentionally
    // replaces this package with a module-level mock. The probe constructs and
    // closes a real Query without iterating it, so it exercises package/native
    // resolution without making an authenticated API request.
    const probe = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          import { query } from "@anthropic-ai/claude-agent-sdk";
          const request = query({
            prompt: "local compatibility probe",
            options: { maxTurns: 0 },
          });
          const result = {
            query: typeof query,
            iterator: typeof request[Symbol.asyncIterator],
            supportedModels: typeof request.supportedModels,
            close: typeof request.close,
          };
          await request.close();
          console.log(JSON.stringify(result));
        `,
      ],
      {
        cwd: packageRoot,
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
    expect(JSON.parse(stdout)).toEqual({
      query: "function",
      iterator: "function",
      supportedModels: "function",
      close: "function",
    });
  }, 15_000);
});
