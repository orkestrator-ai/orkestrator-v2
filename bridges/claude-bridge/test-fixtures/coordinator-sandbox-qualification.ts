/** Shared pinned-CLI fixture for coordinator and paired AppArmor qualification. */
import { expect } from "bun:test";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  executableOnPath,
  probeClaudeLinuxSandbox,
} from "@orkestrator/protocol/node/claude-linux-sandbox";
import {
  scriptedAnthropicEndpoint,
  scriptedClaudeEnv,
} from "../../../tests/conformance/execution-policy/scripted-anthropic.js";
import { withPolicyCliFixture } from "../../../tests/conformance/execution-policy/vendor-cli.js";
import {
  claudeExecutionSandbox,
  claudeReadOnlyCommandSandbox,
} from "../src/services/claude-execution-sandbox.js";
import {
  claudePermissionMode,
  READ_ONLY_TURN_POLICY,
} from "../src/services/claude-query-config.js";
import {
  claudeReadOnlyAllowedTools,
  coordinatorProcessPolicy,
  createCoordinatorReadOnlyHook,
} from "../src/services/read-only-policy.js";

export const HOOK_ONLY_ADVERSARIAL_SCENARIOS = [
  "unavailable-hook-refuses-xxd-output",
  "unavailable-hook-refuses-xxd-truncate",
  "unavailable-hook-refuses-xxd-reverse-output",
  "unavailable-hook-refuses-xxd-reverse-truncate",
  "unavailable-hook-refuses-git-diff",
  "unavailable-hook-refuses-git-dir",
  "unavailable-hook-refuses-git-fsmonitor",
] as const;

export type Scenario =
  | (typeof HOOK_ONLY_ADVERSARIAL_SCENARIOS)[number]
  /** The ordinary provider sandbox: the checkout is writable. */
  | "default-sandbox-writes"
  /** A real required sandbox fails to read under stock Ubuntu AppArmor. */
  | "apparmor-sandbox-reads"
  /** The coordinator sandbox alone, no hook: the same write is refused. */
  | "coordinator-sandbox-refuses"
  /** The coordinator sandbox still lets a command read the checkout. */
  | "coordinator-sandbox-reads"
  /** The whole coordinator turn: the hook refuses the writing reader. */
  | "coordinator-hook-refuses"
  /**
   * Qualified without a working sandbox (on Linux, also a host whose
   * bubblewrap cannot nest the CLI's namespace): a reading command still runs.
   */
  | "unavailable-hook-reads"
  | "unavailable-hook-refuses-quoted"
  | "unavailable-hook-refuses-escaped"
  | "unavailable-hook-refuses-glob"
  | "unavailable-hook-refuses-abbreviation"
  /**
   * A `readOnly` review turn in an ordinary bridge (todo 0190), on a host
   * staged without bubblewrap and socat (`PATH` holds only the reading
   * programs): the bridge's own probe finds no sandbox, so the CLI is not
   * asked for one, and a reading command runs.
   */
  | "read-only-unavailable-reads"
  /** The same turn: the hook still refuses the writing reader. */
  | "read-only-unavailable-hook-refuses"
  /**
   * Linux only: the block such a turn had before todo 0190 (the sandbox
   * required) on the same staged host. The CLI refuses the whole turn.
   */
  | "read-only-required-refused";

/** Programs a staged host without bubblewrap keeps: the shell and the readers the scenarios run. */
const STAGED_PROGRAMS = ["sh", "bash", "zsh", "cat", "uniq", "xxd", "git", "env"] as const;

/** A `PATH` holding only {@link STAGED_PROGRAMS}, so `bwrap` and `socat` are absent. */
async function stagedPathWithoutSandbox(root: string): Promise<string> {
  const bin = join(root, "staged-bin");
  await mkdir(bin);
  for (const name of STAGED_PROGRAMS) {
    const target = Bun.which(name);
    if (target) await symlink(target, join(bin, name));
  }
  return bin;
}

const coordinatorPolicy = coordinatorProcessPolicy({});

export async function qualifyCoordinatorSandbox(scenario: Scenario, cliPath?: string) {
  return withPolicyCliFixture(async (fixture) => {
    // sandbox-exec matches canonical paths; macOS /var is a symlink.
    const cwd = await realpath(fixture.cwd);
    await writeFile(join(cwd, "in.txt"), "a\na\nb\n");
    const unavailable = scenario.startsWith("unavailable-");
    const readOnlyTurn = scenario.startsWith("read-only-");
    const stagedPath =
      readOnlyTurn && process.platform !== "win32"
        ? await stagedPathWithoutSandbox(fixture.root)
        : undefined;
    // What the bridge decides for this turn, from the real probe run against
    // the staged PATH, as an ordinary bridge in a container would see it.
    const readOnlySandbox = readOnlyTurn
      ? claudeReadOnlyCommandSandbox({
          commandSandbox: undefined,
          coordinatorProcess: false,
          platform: process.platform === "win32" ? "win32" : "linux",
          linuxSandbox: () =>
            probeClaudeLinuxSandbox({ onPath: (name) => executableOnPath(name, stagedPath) }),
        })
      : undefined;
    if (readOnlySandbox) {
      expect(readOnlySandbox.commandSandbox).toBe("unavailable");
      expect(readOnlySandbox.reason).toContain(
        process.platform === "win32" ? "needs macOS, or Linux" : "bubblewrap and socat",
      );
    }
    const adversarialCommands: Partial<Record<Scenario, string>> = {
      "unavailable-hook-refuses-xxd-output": "xxd in.txt -out.txt",
      "unavailable-hook-refuses-xxd-truncate": "xxd in.txt -out.txt",
      "unavailable-hook-refuses-xxd-reverse-output": "xxd -r dump.txt -out.bin",
      "unavailable-hook-refuses-xxd-reverse-truncate": "xxd -r dump.txt -out.bin",
      "unavailable-hook-refuses-git-diff": "git diff",
      "unavailable-hook-refuses-git-dir": "git --git-dir=.git diff",
      "unavailable-hook-refuses-git-fsmonitor": "git status",
    };
    await writeFile(join(cwd, "dump.txt"), "00000000: 61 62 63 0a  abc.\n");
    const dashOutput = join(cwd, scenario.includes("reverse") ? "-out.bin" : "-out.txt");
    if (scenario.endsWith("truncate")) await writeFile(dashOutput, "sentinel\n");
    const command =
      adversarialCommands[scenario] ??
      (scenario === "unavailable-hook-refuses-quoted"
        ? "sort '-oout.txt' in.txt"
        : scenario === "unavailable-hook-refuses-escaped"
          ? String.raw`sort --out\put=out.txt in.txt`
          : scenario === "unavailable-hook-refuses-glob"
            ? "uniq [io]*.txt"
            : scenario === "unavailable-hook-refuses-abbreviation"
              ? "sort --out=out.txt in.txt"
              : scenario === "coordinator-sandbox-reads" ||
                  scenario === "apparmor-sandbox-reads" ||
                  scenario === "unavailable-hook-reads" ||
                  scenario === "read-only-unavailable-reads" ||
                  scenario === "read-only-required-refused"
                ? "cat in.txt"
                : scenario === "coordinator-hook-refuses" ||
                    scenario === "read-only-unavailable-hook-refuses"
                  ? "uniq in.txt out.txt"
                  : "printf written > out.txt");
    if (scenario === "unavailable-hook-refuses-glob")
      await writeFile(join(cwd, "out.txt"), "sentinel\n");
    const endpoint = scriptedAnthropicEndpoint(() => [
      [
        {
          type: "tool_use",
          id: "coordinator_probe",
          name: "Bash",
          input: { command, description: "Coordinator sandbox fixture" },
        },
      ],
      [{ type: "text", text: "Done." }],
    ]);
    if (scenario.includes("-git-")) {
      // Real local Git configuration, including helper selection through an
      // explicit git-dir. Were the hook to admit it, the helper would write
      // and contact the fixture's unlisted endpoint.
      const helper = join(fixture.root, "git-helper.sh");
      await writeFile(
        helper,
        `#!/bin/sh\nprintf helper > '${join(cwd, "helper-sentinel")}'\ncurl --max-time 2 '${endpoint.url.origin}/unlisted'\n`,
        { mode: 0o755 },
      );
      const git = (args: string[]) => {
        const result = spawnSync("git", args, {
          cwd,
          env: { ...process.env, ...fixture.env },
          encoding: "utf8",
          timeout: 5_000,
        });
        expect(result.status).toBe(0);
      };
      git(["init", "--quiet"]);
      git(["add", "in.txt"]);
      await writeFile(join(cwd, "in.txt"), "changed\n");
      git(["config", "diff.external", helper]);
      git(["config", "core.fsmonitor", helper]);
      git(["config", "diff.fixture.textconv", helper]);
      await writeFile(join(cwd, ".gitattributes"), "in.txt diff=fixture\n");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const coordinatorTurn = scenario === "coordinator-hook-refuses" || unavailable;
    const turnPolicy = readOnlyTurn ? READ_ONLY_TURN_POLICY : coordinatorPolicy;
    const options: Options = {
      cwd,
      ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
      model: "claude-sonnet-4-6",
      maxTurns: 2,
      persistSession: false,
      settingSources: [],
      abortController: controller,
      ...(coordinatorTurn || readOnlyTurn
        ? {
            // The mode the bridge gives a coordinator turn; the hook decides first.
            permissionMode: claudePermissionMode(turnPolicy, undefined),
            allowedTools: claudeReadOnlyAllowedTools({ policy: turnPolicy }),
            hooks: {
              PreToolUse: [
                {
                  hooks: [
                    createCoordinatorReadOnlyHook(turnPolicy, [], {
                      commandSandbox: unavailable
                        ? "unavailable"
                        : (readOnlySandbox?.commandSandbox ?? "required"),
                    }),
                  ],
                },
              ],
            },
          }
        : {
            tools: ["Bash"],
            permissionMode: "bypassPermissions" as const,
            allowDangerouslySkipPermissions: true,
          }),
      sandbox:
        scenario === "default-sandbox-writes"
          ? claudeExecutionSandbox(
              {
                id: "interactive-host",
                sandbox: "provider",
                approvals: "auto-approve",
                projectResources: false,
                networkAccess: "restricted",
              },
              false,
            )
          : readOnlySandbox
            ? claudeExecutionSandbox(READ_ONLY_TURN_POLICY, false, {
                cwd,
                commandSandbox:
                  scenario === "read-only-required-refused"
                    ? "required"
                    : readOnlySandbox.commandSandbox,
              })
            : claudeExecutionSandbox(coordinatorPolicy, false, {
                cwd,
                commandSandbox: unavailable ? "unavailable" : "required",
              }),
      env: {
        ...scriptedClaudeEnv(fixture, endpoint, join(fixture.root, "claude")),
        // Keep the Windows shell discoverable without restoring user settings
        // or credentials cleared by scriptedClaudeEnv.
        ...(process.platform === "win32"
          ? {
              SystemRoot: process.env.SystemRoot,
              COMSPEC: process.env.COMSPEC,
              PATHEXT: process.env.PATHEXT,
              ProgramFiles: process.env.ProgramFiles,
              "ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
              USERPROFILE: fixture.env.HOME,
              TEMP: fixture.root,
              TMP: fixture.root,
            }
          : {}),
        // Hides bubblewrap, so the refusals below cannot lean on a sandbox.
        // The reading case keeps PATH: the bridge leaves the sandbox off there.
        ...(unavailable &&
        scenario !== "unavailable-hook-reads" &&
        !adversarialCommands[scenario] &&
        process.platform === "linux"
          ? { PATH: fixture.root }
          : {}),
        ...(stagedPath ? { PATH: stagedPath } : {}),
      },
      ...(unavailable && process.platform === "darwin"
        ? {
            spawnClaudeCodeProcess: (options) =>
              spawn(
                "/usr/bin/sandbox-exec",
                [
                  "-p",
                  '(version 1)(allow default)(deny process-exec (literal "/usr/bin/sandbox-exec"))',
                  options.command,
                  ...options.args,
                ],
                {
                  cwd: options.cwd,
                  env: options.env,
                  signal: options.signal,
                  stdio: ["pipe", "pipe", "pipe"],
                },
              ),
          }
        : {}),
      stderr: () => {},
    };
    const messages: SDKMessage[] = [];
    let failure: unknown;
    try {
      for await (const message of query({ prompt: "Run the fixture", options })) {
        messages.push(message);
        if (messages.length > 64) {
          controller.abort();
          throw new Error("CLI fixture message bound exceeded");
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timeout);
      endpoint.stop();
    }
    expect(controller.signal.aborted).toBe(false);
    if (scenario === "read-only-required-refused") {
      // The reported failure: refused before any model call, with the
      // CLI's own reason (pinned CLI 2.1.309 on Linux, 2026-10-26).
      expect(endpoint.modelCalls()).toBe(0);
      const refusal = JSON.stringify([
        failure instanceof Error ? failure.message : failure,
        ...messages.filter((message) => message.type === "result"),
      ]);
      expect(refusal).toContain("Sandbox required but unavailable");
      return { scenario, modelCalls: 0, toolError: false, written: false };
    }
    expect(failure).toBeUndefined();
    expect(endpoint.networkHits()).toBe(0);
    expect(existsSync(join(cwd, "helper-sentinel"))).toBe(false);
    if (scenario.includes("-xxd-")) {
      expect(existsSync(dashOutput)).toBe(scenario.endsWith("truncate"));
      if (scenario.endsWith("truncate"))
        expect(await Bun.file(dashOutput).text()).toBe("sentinel\n");
    }
    expect(endpoint.modelCalls()).toBe(2);
    const toolResults = messages.flatMap((message) =>
      message.type === "user" && Array.isArray(message.message.content)
        ? message.message.content.filter((block) => block.type === "tool_result")
        : [],
    );
    expect(toolResults).toHaveLength(1);
    const written = existsSync(join(cwd, "out.txt"));
    // A command that should succeed reports why it failed, not only that it did.
    const commandFailure = (block: (typeof toolResults)[number]) =>
      block.is_error === true ? JSON.stringify(block.content) : undefined;
    if (scenario === "default-sandbox-writes") {
      expect(commandFailure(toolResults[0]!)).toBeUndefined();
      expect(written).toBe(true);
    } else if (scenario === "apparmor-sandbox-reads") {
      expect(toolResults[0]!.is_error).toBe(true);
      const output = JSON.stringify(toolResults[0]!.content);
      expect(output).toContain("apply-seccomp");
      expect(output).toContain("setgroups");
      expect(output).toContain("Permission denied");
      expect(written).toBe(false);
    } else if (
      scenario === "coordinator-sandbox-reads" ||
      scenario === "unavailable-hook-reads" ||
      scenario === "read-only-unavailable-reads"
    ) {
      expect(commandFailure(toolResults[0]!)).toBeUndefined();
      expect(JSON.stringify(toolResults[0]!.content)).toContain("a\\na\\nb");
    } else {
      expect(toolResults[0]!.is_error).toBe(true);
      expect(written).toBe(scenario === "unavailable-hook-refuses-glob");
      if (scenario === "unavailable-hook-refuses-glob")
        expect(await Bun.file(join(cwd, "out.txt")).text()).toBe("sentinel\n");
      if (
        scenario === "coordinator-hook-refuses" ||
        scenario === "read-only-unavailable-hook-refuses" ||
        adversarialCommands[scenario]
      ) {
        expect(JSON.stringify(toolResults[0]!.content)).toContain(
          scenario.includes("-git-")
            ? "Git commands require the command sandbox"
            : "Coordinator is read-only",
        );
      }
    }
    return {
      scenario,
      modelCalls: endpoint.modelCalls(),
      toolError: toolResults[0]!.is_error === true,
      written,
    };
  });
}
