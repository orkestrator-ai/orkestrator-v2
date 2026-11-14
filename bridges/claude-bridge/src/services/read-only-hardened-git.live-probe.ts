// Proves on the real pinned Claude CLI that a reviewer's hardened Git
// (`gitWithoutSandbox: "harden"` in `read-only-policy.ts`) runs the command
// the read-only hook rewrote, not the one the model wrote. The hook answers
// with `hookSpecificOutput.updatedInput` and no `permissionDecision`, so the
// boundary rests on the CLI applying a decision-less rewrite; nothing short
// of the CLI itself can show that. Run by `read-only-hardened-git.live.test.ts`
// in its own process.
//
// Each scenario is one turn of the SDK's `query()` with a read-only reviewer's
// options and no command sandbox (the configuration a container or a Linux
// host without bubblewrap gets). A scripted loopback model asks for one Bash
// call: a plain `git diff` in a repository whose own config sets
// `diff.external` and a textconv driver to a program that writes a sentinel.
// With the hook the sentinel must stay absent and the tool result must be
// Git's own diff; the control turn, without the read-only hook, must run the
// helper, so a fixture that stopped selecting it cannot pass.
//
// Credential-free: HOME and CLAUDE_CONFIG_DIR are a temporary directory the
// test creates and removes, the API key is a fixture string, and
// non-essential traffic is off. Nothing is billed.
import { query, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  bundledCli,
  reply,
  textOf,
  type MessagesBody,
} from "./claude-provider-sandbox.live-probe.js";
import {
  claudeDeniedTools,
  claudeReadOnlyAllowedTools,
  claudeReadOnlySandbox,
  coordinatorProcessPolicy,
  createCoordinatorReadOnlyHook,
} from "./read-only-policy.js";
import { withReadOnlyGitConfig } from "./runtime-env.js";

export const RESULT_SENTINEL = "__CLAUDE_HARDENED_GIT_RESULT__";

export interface HardenedGitObservation {
  name: string;
  /** The command the model asked for. */
  command: string;
  /** What the read-only hook answered, if it ran. */
  hookCommand: string | null;
  /** The tool result the CLI returned to the model. */
  toolResult: { isError: boolean; excerpt: string } | null;
  /** Whether the checkout's configured helper ran. */
  helperRan: boolean;
}

export interface HardenedGitReport {
  cliVersion: string;
  observations: HardenedGitObservation[];
}

interface Scenario {
  name: string;
  command: string;
  /** Install the read-only hook (the control turn does not). */
  hook: boolean;
}

const SCENARIOS: Scenario[] = [
  { name: "hardened-diff", command: "git diff HEAD~1..HEAD", hook: true },
  { name: "hardened-log-pipe", command: "git log -p -1 | head -40", hook: true },
  { name: "unhooked-control", command: "git diff HEAD~1..HEAD", hook: false },
];

const TURN_TIMEOUT_MS = 120_000;
const EXCERPT_CHARS = 600;
const MARKER = /\[hardened-git:([a-z0-9-]+)\]/;

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
}

/** A two-commit repository whose own config runs `helper` for every diff. */
function hostileRepository(workspace: string, helper: string): void {
  git(workspace, "init", "-q", "-b", "main");
  writeFileSync(join(workspace, ".gitattributes"), "*.txt diff=probe\n");
  writeFileSync(join(workspace, "a.txt"), "one\n");
  git(workspace, "add", ".");
  git(workspace, "commit", "-qm", "one");
  writeFileSync(join(workspace, "a.txt"), "two\n");
  git(workspace, "commit", "-qam", "two");
  git(workspace, "config", "diff.external", helper);
  git(workspace, "config", "diff.probe.textconv", helper);
  git(workspace, "config", "diff.probe.command", helper);
}

async function runTurn(
  scenario: Scenario,
  workspace: string,
  hookCommands: Map<string, string>,
): Promise<void> {
  const policy = coordinatorProcessPolicy({});
  const readOnlyHook = createCoordinatorReadOnlyHook(policy, [], {
    commandSandbox: "unavailable",
    role: "read-only",
    gitWithoutSandbox: "harden",
    readBoundary: null,
  });
  const recording: HookCallback = async (input, toolUseId, options) => {
    const output = await readOnlyHook(input, toolUseId, options);
    const specific = (
      output as {
        hookSpecificOutput?: { permissionDecision?: string; updatedInput?: { command?: string } };
      }
    ).hookSpecificOutput;
    hookCommands.set(
      scenario.name,
      specific?.permissionDecision ?? specific?.updatedInput?.command ?? "pass",
    );
    return output;
  };
  const control = query({
    prompt: `Run the probe. [hardened-git:${scenario.name}]`,
    options: {
      cwd: workspace,
      pathToClaudeCodeExecutable: bundledCli(),
      model: "claude-sonnet-4-6",
      maxTurns: 4,
      persistSession: false,
      settingSources: [],
      permissionMode: "default",
      allowedTools: claudeReadOnlyAllowedTools({ policy }),
      disallowedTools: claudeDeniedTools(policy),
      // What a reviewer turn gets where the launcher found no sandbox.
      sandbox: claudeReadOnlySandbox(policy, {
        workspaces: [workspace],
        commandSandbox: "unavailable",
      }),
      hooks: scenario.hook ? { PreToolUse: [{ hooks: [recording] }] } : {},
      canUseTool: async (toolName) => ({
        behavior: "deny",
        message: `${toolName} is not allowed: this session's policy denies approvals.`,
      }),
      env: withReadOnlyGitConfig(policy, {
        ...process.env,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      }),
    },
  });
  const deadline = setTimeout(() => control.close(), TURN_TIMEOUT_MS);
  try {
    for await (const message of control as AsyncIterable<SDKMessage>) {
      if (message.type === "result") break;
    }
  } finally {
    clearTimeout(deadline);
    control.close();
  }
}

async function main(): Promise<void> {
  const root = process.env.CWD;
  if (!root || !process.env.CLAUDE_CONFIG_DIR) {
    throw new Error("The probe needs CWD and CLAUDE_CONFIG_DIR");
  }
  const cli = bundledCli();
  if (!existsSync(cli)) throw new Error("The pinned Claude CLI is not installed");
  const cliVersion = Bun.spawnSync([cli, "--version"], { env: process.env, stderr: "ignore" })
    .stdout.toString()
    .trim()
    .split(/\s/)[0]!;

  const workspace = join(root, "checkout");
  const sentinel = join(root, "helper-ran");
  const helper = join(root, "helper.sh");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(helper, `#!/bin/sh\necho ran >> ${sentinel}\n[ -f "$1" ] && cat "$1"\nexit 0\n`);
  chmodSync(helper, 0o755);
  hostileRepository(workspace, helper);

  const byName = new Map(SCENARIOS.map((scenario) => [scenario.name, scenario]));
  const results = new Map<string, { isError: boolean; excerpt: string }>();
  let sequence = 0;
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      sequence += 1;
      if (request.method !== "POST") return Response.json({ data: [] });
      const body = (await request.json().catch(() => ({}))) as MessagesBody;
      if (!new URL(request.url).pathname.endsWith("/messages")) {
        return Response.json({ input_tokens: 1 });
      }
      const users = (body.messages ?? []).filter((message) => message.role === "user");
      const name = users.map((message) => MARKER.exec(textOf(message.content))?.[1]).find(Boolean);
      const scenario = name ? byName.get(name) : undefined;
      const bash = (body.tools ?? []).some((tool) => tool.name === "Bash");
      if (!scenario || !bash) {
        return reply([{ type: "text", text: "Probe." }], body.stream === true, sequence);
      }
      const toolId = `toolu_probe_${scenario.name.replaceAll("-", "_")}`;
      const result = users
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .find((block) => block.type === "tool_result" && block.tool_use_id === toolId);
      if (result) {
        results.set(scenario.name, {
          isError: result.is_error === true,
          excerpt: textOf(result.content).slice(0, EXCERPT_CHARS),
        });
        return reply([{ type: "text", text: "Done." }], body.stream === true, sequence);
      }
      return reply(
        [
          {
            type: "tool_use",
            id: toolId,
            name: "Bash",
            input: { command: scenario.command, description: "Read the reviewed diff" },
          },
        ],
        body.stream === true,
        sequence,
      );
    },
  });
  process.env.ANTHROPIC_BASE_URL = model.url.origin;

  const hookCommands = new Map<string, string>();
  const observations: HardenedGitObservation[] = [];
  try {
    for (const scenario of SCENARIOS) {
      rmSync(sentinel, { force: true });
      await runTurn(scenario, workspace, hookCommands);
      observations.push({
        name: scenario.name,
        command: scenario.command,
        hookCommand: hookCommands.get(scenario.name) ?? null,
        toolResult: results.get(scenario.name) ?? null,
        helperRan: existsSync(sentinel),
      });
    }
  } finally {
    model.stop(true);
  }
  const report: HardenedGitReport = { cliVersion, observations };
  process.stdout.write(`${RESULT_SENTINEL}${JSON.stringify(report)}\n`);
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    },
  );
}
