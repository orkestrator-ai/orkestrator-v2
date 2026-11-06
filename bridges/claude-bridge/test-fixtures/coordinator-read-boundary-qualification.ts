/**
 * The read boundary on the pinned CLI, against a fixture data directory and a
 * scripted model: real sandbox, real hook, no provider turn and no real file.
 */
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  scriptedAnthropicEndpoint,
  scriptedClaudeEnv,
  type ScriptedBlock,
} from "../../../tests/conformance/execution-policy/scripted-anthropic.js";
import { withPolicyCliFixture } from "../../../tests/conformance/execution-policy/vendor-cli.js";
import { claudeExecutionSandbox } from "../src/services/claude-execution-sandbox.js";
import { claudePermissionMode } from "../src/services/claude-query-config.js";
import { coordinatorReadBoundary } from "../src/services/read-only-path-boundary.js";
import {
  claudeReadOnlyAllowedTools,
  coordinatorProcessPolicy,
  createCoordinatorReadOnlyHook,
} from "../src/services/read-only-policy.js";
import { COORDINATOR_PROTECTED_DATA_DIR_ENV } from "@orkestrator/protocol/coordinator";

export const SECRET = "FIXTURE-OPERATOR-CREDENTIAL";
export const OWN_RESULT = "FIXTURE-OWN-TOOL-RESULT";

const policy = coordinatorProcessPolicy({});

export interface BoundaryFixture {
  dataDir: string;
  cwd: string;
  secrets: { credentials: string; database: string; account: string; otherRuntime: string };
  own: { toolResult: string; memory: string; attachment: string };
  link: string;
  env: NodeJS.ProcessEnv;
}

async function seed(path: string, content: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

/** A data directory laid out as the backend lays it out, holding only fixture values. */
async function boundaryFixture(root: string, cwd: string): Promise<BoundaryFixture> {
  const dataDir = join(root, "data dir");
  const runtime = (conversation: string) =>
    join(dataDir, "coordinator-runtime", "c1", "conversations", conversation, "claude-home");
  const home = runtime("v1");
  const attachments = join(dataDir, "coordinator-attachments", "c1", "v1");
  const secrets = {
    credentials: await seed(join(dataDir, "control-mcp.json"), SECRET),
    database: await seed(join(dataDir, "orkestrator.sqlite"), SECRET),
    account: await seed(join(dataDir, "agent-accounts", "claude", "a1", "credentials"), SECRET),
    otherRuntime: await seed(join(runtime("v2"), "projects", "p", "memory", "MEMORY.md"), SECRET),
  };
  const own = {
    toolResult: await seed(join(home, "projects", "p", "s", "tool-results", "big.txt"), OWN_RESULT),
    memory: await seed(join(home, "projects", "p", "memory", "MEMORY.md"), OWN_RESULT),
    attachment: await seed(join(attachments, "pasted.txt"), OWN_RESULT),
  };
  const link = join(cwd, "innocent.json");
  await symlink(secrets.credentials, link);
  return {
    dataDir,
    cwd,
    secrets,
    own,
    link,
    env: {
      [COORDINATOR_PROTECTED_DATA_DIR_ENV]: dataDir,
      CLAUDE_CONFIG_DIR: home,
      ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT: attachments,
    },
  };
}

export type BoundaryLayer =
  /** The control: the same sandbox with no read boundary, which must read the fixture. */
  "sandbox-without-boundary" | "sandbox-only" | "hook-and-sandbox" | "hook-only";

export interface ToolOutcome {
  input: Record<string, unknown>;
  name: string;
  isError: boolean;
  output: string;
}

/** Runs one scripted model turn per call, and returns what each tool answered. */
export async function qualifyReadBoundary(
  layer: BoundaryLayer,
  calls: (fixture: BoundaryFixture) => { name: string; input: Record<string, unknown> }[],
): Promise<ToolOutcome[]> {
  return withPolicyCliFixture(async (cli) => {
    // sandbox-exec matches canonical paths; macOS /var is a symlink.
    const root = await realpath(cli.root);
    const cwd = await realpath(cli.cwd);
    const fixture = await boundaryFixture(root, cwd);
    const scripted = calls(fixture);
    const endpoint = scriptedAnthropicEndpoint(() => [
      ...scripted.map((call, index): ScriptedBlock[] => [
        { type: "tool_use", id: `boundary_${index}`, name: call.name, input: call.input },
      ]),
      [{ type: "text", text: "Done." }],
    ]);
    const boundary =
      layer === "sandbox-without-boundary" ? null : coordinatorReadBoundary([cwd], fixture.env);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const commandSandbox = layer === "hook-only" ? "unavailable" : "required";
    const options: Options = {
      cwd,
      model: "claude-sonnet-4-6",
      maxTurns: scripted.length + 1,
      persistSession: false,
      settingSources: [],
      abortController: controller,
      ...(layer === "sandbox-only" || layer === "sandbox-without-boundary"
        ? {
            // No hook: what the OS sandbox alone refuses.
            tools: ["Bash"],
            permissionMode: "bypassPermissions" as const,
            allowDangerouslySkipPermissions: true,
          }
        : {
            permissionMode: claudePermissionMode(policy, undefined),
            allowedTools: claudeReadOnlyAllowedTools({ policy }),
            hooks: {
              PreToolUse: [
                {
                  hooks: [
                    createCoordinatorReadOnlyHook(policy, [], {
                      commandSandbox,
                      readBoundary: boundary,
                    }),
                  ],
                },
              ],
            },
          }),
      sandbox: claudeExecutionSandbox(policy, false, {
        cwd,
        commandSandbox,
        readBoundary: boundary,
      }),
      env: {
        ...scriptedClaudeEnv(cli, endpoint, String(fixture.env.CLAUDE_CONFIG_DIR)),
      },
      stderr: () => {},
    };
    const messages: SDKMessage[] = [];
    try {
      for await (const message of query({ prompt: "Run the fixture", options })) {
        messages.push(message);
        if (messages.length > 256) {
          controller.abort();
          throw new Error("CLI fixture message bound exceeded");
        }
      }
    } finally {
      clearTimeout(timeout);
      endpoint.stop();
    }
    const results = messages.flatMap((message) =>
      message.type === "user" && Array.isArray(message.message.content)
        ? message.message.content.filter((block) => block.type === "tool_result")
        : [],
    );
    return scripted.map((call, index) => ({
      ...call,
      isError: results[index]?.is_error === true,
      output: JSON.stringify(results[index]?.content ?? "(no result)"),
    }));
  });
}
