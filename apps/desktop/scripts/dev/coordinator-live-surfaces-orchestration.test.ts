import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CoordinatorLivePlatformSummary,
  CoordinatorTranscriptMessage,
} from "./coordinator-live.js";
import type { DelegationMailMessage } from "./coordinator-live-delegation.js";
import { runCoordinatorCleanup, type DelegationCoordinator } from "./coordinator-live-observer.js";
import {
  runSurfacesScenario,
  type RootChangesApproval,
} from "./coordinator-live-surfaces-orchestration.js";
import { surfacesRootFile } from "./coordinator-live-surfaces.js";

const token = "scripted";
const terminalTab = "terminal-coordinator-scripted";
const browserTab = "browser-coordinator-0123456789abcdef01234567";

// Real `git` builds the checkout and digests it on every run.
setDefaultTimeout(30_000);

let root: string;
let checkout: string;
let worktree: string;

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@invalid.local",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@invalid.local",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "coordinator-live-surfaces-"));
  checkout = path.join(root, "project");
  worktree = path.join(root, "worker");
  await mkdir(checkout, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(path.join(checkout, "README.md"), "# Fixture\n");
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "Initial fixture");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const tool = (toolName: string, toolOutput: string): CoordinatorTranscriptMessage => ({
  role: "assistant",
  parts: [{ toolName, toolArgs: {}, toolOutput, toolState: "completed" }],
});

/**
 * Script only the command transport: the live observer, waits and verdict run
 * unchanged. The surfaces turn adds its tool rows and leaves a pending
 * request; the approver settles it as the dialog's Apply would, and the
 * outcome wakes the coordinator.
 */
type Script = {
  /** The approval runs but no outcome mail or wake follows. */
  neverWakes?: boolean;
  /** A second wake arrives in the quiet window. */
  duplicate?: boolean;
  /** `edit_worker_tab` did not close the browser tab. */
  browserLeftOpen?: boolean;
  /** The approval writes into the checkout as well as the worker. */
  touchesCheckout?: boolean;
  /** The coordinator never calls `request_root_changes`. */
  noRequest?: boolean;
  /** The terminal tab opens but its command never runs: only the prompt and the typed line show. */
  commandNeverRan?: boolean;
  /** No terminal output can be read at all. */
  terminalUnreadable?: boolean;
};

function fixture(script: Script = {}) {
  const now = () => new Date().toISOString();
  const environments: Array<{ id: string; name: string }> = [];
  const messages: CoordinatorTranscriptMessage[] = [];
  const mail: DelegationMailMessage[] = [];
  const turns: Array<{ turnId: string }> = [];
  const requests: Array<{ requestId: string; kind: string; state: string }> = [];
  const commands: string[] = [];
  const settings: Array<Record<string, unknown>> = [];
  const sent: string[] = [];
  let workingReads = 0;
  let wakeFinish: (() => void) | undefined;
  let quietReads = 0;
  let extraWakes = 0;
  let browserOpen = false;

  const wake = (turnId: string) => {
    workingReads = 2;
    wakeFinish = () => turns.push({ turnId });
  };

  const invoke: DelegationCoordinator["invoke"] = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ) => {
    commands.push(command);
    let value: unknown = null;
    switch (command) {
      case "get_config":
        value = { repositories: {} };
        break;
      case "patch_repository_settings":
        settings.push(args);
        break;
      case "get_environments":
        value = [...environments];
        break;
      case "create_environment":
        environments.push({ id: "worker", name: String(args.name) });
        value = { id: "worker" };
        break;
      case "start_environment":
        break;
      case "get_environment":
        value = { worktreePath: worktree };
        break;
      case "get_prompt_queue":
        value = { messages: [] };
        break;
      case "get_project_coordinator":
        value = { workflows: [] };
        break;
      case "dispatch_native_agent_intent": {
        sent.push(String(args.prompt));
        turns.push({ turnId: `prompt-${turns.length}` });
        messages.push({ role: "user", content: "harness prompt" });
        browserOpen = true;
        messages.push(
          tool(
            "mcp__orkestrator__launch_terminal",
            JSON.stringify({ environmentId: "worker", tabId: terminalTab, status: "running" }),
          ),
          tool("mcp__orkestrator__open_worker_browser", JSON.stringify({ tabId: browserTab })),
          tool(
            "mcp__orkestrator__list_tabs",
            JSON.stringify({
              tabs: [{ id: "startup-agent" }, { id: terminalTab }, { id: browserTab }],
            }),
          ),
          tool("mcp__orkestrator__edit_worker_tab", '{"ok":true}'),
          tool("mcp__orkestrator__edit_worker_tab", '{"ok":true}'),
        );
        if (!script.browserLeftOpen) browserOpen = false;
        if (!script.noRequest) {
          requests.push({ requestId: "request-1", kind: "apply-root-changes", state: "pending" });
          messages.push(
            tool(
              "mcp__orkestrator__request_root_changes",
              JSON.stringify({ approvalRequestId: "request-1", delivery: "async" }),
            ),
          );
        }
        break;
      }
      case "list_node_action_requests":
        value = requests.map((request) => ({ ...request }));
        break;
      case "get_terminal_output_snapshot":
        if (script.terminalUnreadable || args.sessionId !== `local-worker:${terminalTab}`) {
          throw new Error("no such terminal session");
        }
        value = {
          output: script.commandNeverRan
            ? `\x1b[1m$\x1b[0m echo surfaces-${token}`
            : `\x1b[1m$\x1b[0m echo surfaces-${token}\r\n\x1b[32msurfaces-${token}\x1b[0m\r\n\x1b[1m$\x1b[0m `,
        };
        break;
      case "get_pane_layout":
        value = {
          root: {
            kind: "leaf",
            id: "pane-1",
            activeTabId: terminalTab,
            tabs: [
              { id: "startup-agent", type: "agent-native" },
              { id: terminalTab, type: "plain" },
              ...(browserOpen ? [{ id: browserTab, type: "browser" }] : []),
            ],
          },
        };
        break;
      case "get_agent_mail_mailbox":
        value = {
          messages: mail
            .filter(
              (message) =>
                message.toEnvironmentId === args.environmentId && message.toTabId === args.tabId,
            )
            .map(({ body: _body, ...rest }) => ({ ...rest })),
        };
        break;
      case "get_agent_mail_message": {
        const message = mail.find((item) => item.id === args.messageId);
        value = message ? { body: message.body } : null;
        break;
      }
      case "get_native_agent_projection":
        if (args.environmentId === "coordinator") {
          if (workingReads === 0 && wakeFinish) {
            wakeFinish();
            wakeFinish = undefined;
          }
          let phase = "idle";
          if (workingReads > 0) {
            workingReads -= 1;
            phase = "working";
          } else if (requests[0]?.state === "executed") {
            quietReads += 1;
            if (script.duplicate && quietReads === 3 && extraWakes === 0) {
              extraWakes += 1;
              turns.push({ turnId: "duplicate-wake" });
            }
          }
          value = { turn: { phase }, messages: [...messages], contextUsage: { turns: [...turns] } };
        } else {
          value = { turn: { phase: "idle" }, messages: [] };
        }
        break;
      case "stop_environment":
      case "delete_environment":
        break;
      default:
        throw new Error(`unscripted command ${command}`);
    }
    return value as T;
  };

  /** The dialog's Apply: the request runs, the file lands, the outcome is mailed. */
  const approve = async (request: RootChangesApproval) => {
    const file = surfacesRootFile(token);
    expect(request).toEqual({
      requestId: "request-1",
      file: file.path,
      workerName: `surfaces-${token}`,
    });
    // The file the harness put in the checkout is there to copy.
    expect(await readFile(path.join(checkout, request.file), "utf8")).toBe(file.content);
    await writeFile(path.join(worktree, request.file), file.content);
    if (script.touchesCheckout) await writeFile(path.join(checkout, "README.md"), "# Changed\n");
    requests[0]!.state = "executed";
    if (script.neverWakes) return;
    mail.push({
      id: "outcome",
      createdAt: now(),
      from: { kind: "system" },
      toEnvironmentId: "coordinator",
      toTabId: "coord-tab",
      placement: "injected",
      body: "Applied 1 file.",
    });
    wake("outcome-wake");
  };

  const coordinator: DelegationCoordinator = {
    invoke,
    identity: { environmentId: "coordinator", agent: "claude", logicalSessionKey: "coord" },
    conversation: { id: "conversation", tabId: "coord-tab" },
    projectId: "project",
  };
  const summary: CoordinatorLivePlatformSummary = {
    version: 1,
    platform: "claude",
    verdict: "passed",
    startedAt: "test",
  };
  return { coordinator, summary, approve, sent, settings, commands };
}

async function run(script: Script = {}) {
  const world = fixture(script);
  const cleanup: Array<() => Promise<unknown>> = [];
  const previous = process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS;
  process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS = "150";
  try {
    const result = await runSurfacesScenario({
      coordinator: world.coordinator,
      summary: world.summary,
      cleanup,
      checkout,
      approveRootChanges: world.approve,
      token,
      pollIntervalMs: 1,
      quietMs: 25,
      terminalWaitMs: 25,
    });
    return { ...result, world };
  } finally {
    if (previous === undefined)
      delete process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS;
    else process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS = previous;
    await runCoordinatorCleanup(cleanup, world.summary);
    await rm(path.join(worktree, surfacesRootFile(token).path), { force: true });
    git(checkout, "checkout", "-q", "--", ".");
  }
}

const names = (checks: Array<{ name: string; passed: boolean }>) =>
  checks.filter((item) => !item.passed).map((item) => item.name);

test("every tool once, the approval applied in the worker and one wake qualifies", async () => {
  const { checks, world } = await run();
  expect(checks.filter((item) => !item.passed)).toEqual([]);
  expect(world.sent).toHaveLength(1);
  expect(world.sent[0]).toContain('environmentId "worker"');
});

test("the project opt-in is set for the run and removed again, and so are the file and worker", async () => {
  const { world } = await run();
  expect(world.settings).toEqual([
    { projectId: "project", updates: { coordinatorOtherEnvironments: true } },
    { projectId: "project", updates: {}, unset: ["coordinatorOtherEnvironments"] },
  ]);
  expect(world.commands).toContain("delete_environment");
  expect(
    await readFile(path.join(checkout, surfacesRootFile(token).path), "utf8").catch(() => null),
  ).toBeNull();
});

test("a request that is never woken on is reported, not hung on", async () => {
  const { checks } = await run({ neverWakes: true });
  expect(names(checks)).toEqual(expect.arrayContaining(["finished", "one-outcome-wake"]));
});

test("a second wake in the quiet window fails", async () => {
  const { checks } = await run({ duplicate: true });
  expect(names(checks)).toEqual(["one-outcome-wake"]);
});

test("a browser tab left open fails", async () => {
  const { checks } = await run({ browserLeftOpen: true });
  expect(names(checks)).toEqual(["browser-closed"]);
});

test("a terminal tab whose command never ran fails, though the tab exists and is focused", async () => {
  const { checks, world } = await run({ commandNeverRan: true });
  expect(names(checks)).toEqual(["terminal-ran-command"]);
  expect(checks.find((item) => item.name === "terminal-ran-command")?.detail).toBe(
    "the echoed marker never appeared",
  );
  expect(
    world.commands.filter((command) => command === "get_terminal_output_snapshot").length,
  ).toBeGreaterThan(1);
});

test("terminal output that cannot be read fails rather than passing", async () => {
  const { checks } = await run({ terminalUnreadable: true });
  expect(names(checks)).toEqual(["terminal-ran-command"]);
  expect(checks.find((item) => item.name === "terminal-ran-command")?.detail).toBe(
    "no terminal output could be read",
  );
});

test("an approval that also changed the checkout fails", async () => {
  const { checks } = await run({ touchesCheckout: true });
  expect(names(checks)).toEqual(["checkout-unchanged"]);
});

test("no root-changes request ends the case at once with the reason", async () => {
  const { checks } = await run({ noRequest: true });
  expect(names(checks)).toEqual(
    expect.arrayContaining([
      "finished",
      "each-tool-called",
      "root-changes-requested",
      "root-changes-landed",
    ]),
  );
  expect(checks.find((item) => item.name === "finished")?.detail).toContain(
    "asked for no approval",
  );
});
