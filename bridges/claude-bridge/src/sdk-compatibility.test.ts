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

  // -------------------------------------------------------------------------
  // Feature-detected entry points
  // -------------------------------------------------------------------------
  //
  // The bridge guards every one of these with `typeof x === "function"` and
  // degrades silently when it is missing: a vanished `listSessions` means no
  // session is ever adopted, a vanished `rewindFiles` means the rewind endpoint
  // throws "not supported", and a vanished `stopTask` means a background task
  // can never be stopped. All of those look like a working build. This probe is
  // what turns an SDK upgrade that drops one of them into a failing test rather
  // than a feature that quietly stops existing.

  test("exposes every module-level and iterator-level entry point the bridge feature-detects", async () => {
    const packageRoot = join(import.meta.dir, "..");

    const probe = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          import * as sdk from "@anthropic-ai/claude-agent-sdk";
          const request = sdk.query({
            prompt: "local compatibility probe",
            options: { maxTurns: 0 },
          });
          const result = {
            module: {
              listSessions: typeof sdk.listSessions,
              getSessionInfo: typeof sdk.getSessionInfo,
              getSessionMessages: typeof sdk.getSessionMessages,
              deleteSession: typeof sdk.deleteSession,
              renameSession: typeof sdk.renameSession,
              forkSession: typeof sdk.forkSession,
            },
            iterator: {
              supportedAgents: typeof request.supportedAgents,
              rewindFiles: typeof request.rewindFiles,
              stopTask: typeof request.stopTask,
              getContextUsage: typeof request.getContextUsage,
            },
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
      module: {
        listSessions: "function",
        getSessionInfo: "function",
        getSessionMessages: "function",
        deleteSession: "function",
        renameSession: "function",
        forkSession: "function",
      },
      iterator: {
        supportedAgents: "function",
        rewindFiles: "function",
        stopTask: "function",
        getContextUsage: "function",
      },
    });
  }, 15_000);

  test("still accepts the listSessions option that scopes a bridge to its own worktree", async () => {
    const packageRoot = join(import.meta.dir, "..");

    // Every Orkestrator environment is a worktree of the same repository and
    // this option defaults to `true`, so if it were ever dropped each bridge
    // would silently start adopting its siblings' sessions again.
    const probe = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          import { listSessions } from "@anthropic-ai/claude-agent-sdk";
          const sessions = await listSessions({
            dir: process.cwd(),
            includeProgrammatic: true,
            includeWorktrees: false,
          });
          console.log(JSON.stringify({ ok: Array.isArray(sessions) }));
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
    expect(JSON.parse(stdout)).toEqual({ ok: true });
  }, 15_000);
});
