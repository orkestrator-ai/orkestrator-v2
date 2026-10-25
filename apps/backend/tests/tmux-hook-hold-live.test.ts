/** Offline real-CLI qualification; opt in because the real 600-second boundary must pass. */
import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { PINNED_TOOLCHAIN_VERSIONS } from "../../../packages/toolchain/src/manifest.js";
import { TmuxBackend } from "../src/core/tmux-backend.js";
import {
  hookScript,
  hooksBlock,
  requestHookHold,
  replyToHook,
  workspaceHookPaths,
  sessionHookPaths,
} from "../src/core/tmux-hooks.js";
import {
  scriptedAnthropicEndpoint,
  scriptedClaudeEnv,
} from "../../../tests/conformance/execution-policy/scripted-anthropic.js";
import {
  withPolicyCliFixture,
  policyQualificationCli,
  policyCliOutput,
} from "../../../tests/conformance/execution-policy/vendor-cli.js";

function killFixtureGroup(pid: number) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function fixtureEntries(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function stopFixtureHooks(sessionsDir: string, script: string) {
  // Claude gives each command hook its own process group. A failed test must
  // also stop those groups, including their deadline sleepers. The generated
  // filename records the PID of this fixture's own live hook shell.
  for (const session of await fixtureEntries(sessionsDir)) {
    for (const name of await fixtureEntries(join(sessionsDir, session, "pending"))) {
      const match = /^PermissionRequest-\d+-(\d+)-\d+-\d+\.json$/.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      const probe = spawnSync("ps", ["-p", String(pid), "-o", "pgid=", "-o", "command="], {
        encoding: "utf8",
        timeout: 1_000,
        maxBuffer: 16 * 1024,
      });
      if (probe.error) throw probe.error;
      const hookProcess = /^(\d+)\s+(.+)$/.exec(probe.stdout.trim());
      // A stale filename must never authorize killing a reused process ID.
      if (hookProcess && Number(hookProcess[1]) === pid && hookProcess[2]!.includes(script))
        killFixtureGroup(pid);
    }
  }
}

const enabled = process.env.RUN_LIVE_TMUX_HOOK_HOLD === "1";
(enabled ? test : test.skip)(
  "pinned Claude CLI accepts the hook timeout and a held PermissionRequest survives 600 seconds",
  async () => {
    await withPolicyCliFixture(async (fixture) => {
      const workspace = workspaceHookPaths(join(fixture.root, "hooks"), fixture.cwd);
      await mkdir(workspace.root);
      await writeFile(workspace.script, hookScript(workspace));
      const marker = join(fixture.cwd, "marker");
      const endpoint = scriptedAnthropicEndpoint(() => [
        [
          {
            type: "tool_use",
            id: "hold_probe",
            name: "Bash",
            input: { command: `touch '${marker}'`, description: "Held permission fixture" },
          },
        ],
        [{ type: "text", text: "Fixture completed." }],
      ]);
      const env = scriptedClaudeEnv(fixture, endpoint, join(fixture.root, "claude"));
      const cli = policyQualificationCli("claude");
      if (!cli) throw new Error("Install the pinned Claude CLI to qualify held hooks");
      expect(await policyCliOutput(cli, ["--version"], fixture)).toContain(
        PINNED_TOOLCHAIN_VERSIONS.claude,
      );
      const child = spawn(
        cli,
        [
          "--print",
          "--output-format",
          "json",
          "--model",
          "claude-sonnet-4-6",
          "--permission-mode",
          "default",
          "--settings",
          JSON.stringify({
            hooks: {
              PermissionRequest: (hooksBlock(workspace.script) as Record<string, unknown>)
                .PermissionRequest,
            },
          }),
          "Run the fixture command once.",
        ],
        {
          cwd: fixture.cwd,
          detached: true,
          env: Object.fromEntries(
            Object.entries(env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      let errors = "";
      let exited = false;
      const exit = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          exited = true;
          resolve(code);
        });
      });
      // Fixture data only, bounded, never included in successful test output.
      child.stdout.on("data", (bytes) => {
        output = (output + bytes.toString()).slice(-64 * 1024);
      });
      child.stderr.on("data", (bytes) => {
        errors = (errors + bytes.toString()).slice(-16 * 1024);
      });
      const until = async (predicate: () => Promise<boolean>, timeout = 30_000) => {
        const end = Date.now() + timeout;
        while (!(await predicate())) {
          if (exited || Date.now() >= end)
            throw new Error(
              `CLI did not reach the expected hook state (exited=${exited}, stderrBytes=${errors.length})`,
            );
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      };
      try {
        let sessionId = "";
        let filename = "";
        await until(async () => {
          for (const id of await readdir(workspace.sessionsDir).catch(() => [])) {
            const names = await readdir(sessionHookPaths(workspace, id).pendingDir).catch(() => []);
            const name = names.find((name) => name.startsWith("PermissionRequest-"));
            if (name) {
              sessionId = id;
              filename = name;
              return true;
            }
          }
          return false;
        });
        const paths = sessionHookPaths(workspace, sessionId);
        const backend = TmuxBackend.local(fixture.cwd);
        const id = filename.slice("PermissionRequest-".length, -5);
        expect((await requestHookHold(backend, paths, "PermissionRequest", id, true)).result).toBe(
          "applied",
        );
        const start = Date.now();
        // Real elapsed time: shortening the script or faking timers cannot
        // qualify the CLI's own hook timeout. Emit bounded progress for watchdogs.
        while (Date.now() - start <= 605_000) {
          await new Promise((resolve) => setTimeout(resolve, 15_000));
          expect(exited).toBe(false);
          expect(endpoint.modelCalls()).toBe(1);
          expect(
            await stat(marker).then(
              () => true,
              () => false,
            ),
          ).toBe(false);
          expect(
            JSON.parse(await readFile(join(paths.timingDir, filename), "utf8")).heldAt,
          ).toBeNumber();
          console.log("[tmux-hold-live] held PermissionRequest remains pending");
        }
        await replyToHook(backend, paths, "PermissionRequest", id, {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "allow" },
          },
        });
        await until(async () => exited);
        expect(await exit).toBe(0);
        expect(endpoint.modelCalls()).toBe(2);
        expect(
          await stat(marker).then(
            () => true,
            () => false,
          ),
        ).toBe(true);
        expect(output).toContain("Fixture completed.");
      } finally {
        try {
          await stopFixtureHooks(workspace.sessionsDir, workspace.script);
        } finally {
          if (!exited && child.pid) killFixtureGroup(child.pid);
          try {
            await exit;
          } finally {
            endpoint.stop();
          }
        }
      }
    });
  },
  720_000,
);
