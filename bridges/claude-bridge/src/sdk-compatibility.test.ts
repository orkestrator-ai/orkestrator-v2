import { describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

  test("routes AskUserQuestion through canUseTool under bypassPermissions", async () => {
    const packageRoot = join(import.meta.dir, "..");
    const fixtureDir = await mkdtemp(join(tmpdir(), "claude-sdk-contract-"));
    const executable = join(fixtureDir, "fake-claude");
    const responseFile = join(fixtureDir, "response.json");
    await copyFile(
      join(import.meta.dir, "testing", "fake-ask-user-question-cli.ts"),
      executable,
    );
    await chmod(executable, 0o755);

    try {
      const probe = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
            import { query } from "@anthropic-ai/claude-agent-sdk";
            let callbackCount = 0;
            const request = query({
              prompt: "Run the deterministic question contract",
              options: {
                pathToClaudeCodeExecutable: process.env.CLAUDE_SDK_CONTRACT_EXECUTABLE,
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
                maxTurns: 1,
                canUseTool: async (toolName, input) => {
                  callbackCount += 1;
                  await new Promise((resolve) => setTimeout(resolve, 25));
                  return {
                    behavior: "allow",
                    updatedInput: {
                      ...input,
                      answers: { "Choose a deterministic answer": "Continue" },
                    },
                  };
                },
              },
            });
            let resultSeen = false;
            for await (const message of request) {
              if (message.type === "result") resultSeen = true;
            }
            console.log(JSON.stringify({ callbackCount, resultSeen }));
          `,
        ],
        {
          cwd: packageRoot,
          env: {
            ...process.env,
            CLAUDE_SDK_CONTRACT_EXECUTABLE: executable,
            CLAUDE_SDK_CONTRACT_RESPONSE_FILE: responseFile,
          },
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
      expect(JSON.parse(stdout)).toEqual({ callbackCount: 1, resultSeen: true });

      const captured = JSON.parse(await readFile(responseFile, "utf8")) as {
        argv: string[];
        response: {
          subtype: string;
          response: { behavior: string; updatedInput: { answers: Record<string, string> } };
        };
      };
      expect(captured.argv).toContain("bypassPermissions");
      expect(captured.response).toMatchObject({
        subtype: "success",
        response: {
          behavior: "allow",
          updatedInput: {
            answers: { "Choose a deterministic answer": "Continue" },
          },
        },
      });
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }, 15_000);

  test("contract fixture records one response and refuses to run unconfigured", async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "claude-sdk-fixture-"));
    const fixture = join(import.meta.dir, "testing", "fake-ask-user-question-cli.ts");
    const responseFile = join(fixtureDir, "response.json");

    try {
      // Without a destination it must exit rather than silently discard the
      // capture the assertions depend on.
      const unconfigured = Bun.spawn([process.execPath, fixture], {
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => key !== "CLAUDE_SDK_CONTRACT_RESPONSE_FILE",
          ),
        ) as Record<string, string>,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await unconfigured.exited).toBe(2);

      // Two identical control responses must leave one parseable document, not
      // two concatenated ones that fail with an opaque syntax error.
      const duplicate = {
        type: "control_response",
        response: {
          request_id: "contract-question-request",
          subtype: "success",
          response: { behavior: "allow" },
        },
      };
      const recorder = Bun.spawn([process.execPath, fixture], {
        env: { ...process.env, CLAUDE_SDK_CONTRACT_RESPONSE_FILE: responseFile },
        stdin: new TextEncoder().encode(
          `${JSON.stringify(duplicate)}\n${JSON.stringify(duplicate)}\n`,
        ),
        stdout: "ignore",
        stderr: "pipe",
      });
      const stderr = await new Response(recorder.stderr).text();
      expect(await recorder.exited, stderr).toBe(0);
      const captured = JSON.parse(await readFile(responseFile, "utf8")) as {
        response: { request_id: string };
      };
      expect(captured.response.request_id).toBe("contract-question-request");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }, 15_000);
});
