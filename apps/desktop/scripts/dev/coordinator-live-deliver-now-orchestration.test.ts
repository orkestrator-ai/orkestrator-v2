import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  CoordinatorLivePlatformSummary,
  CoordinatorTranscriptMessage,
} from "./coordinator-live.js";
import type { DelegationMailMessage } from "./coordinator-live-delegation.js";
import { runDeliverNowScenario } from "./coordinator-live-deliver-now-orchestration.js";
import { deliverNowBodies } from "./coordinator-live-deliver-now.js";
import { runCoordinatorCleanup, type DelegationCoordinator } from "./coordinator-live-observer.js";

const token = "scripted";
const tool = (toolName: string, toolOutput = ""): CoordinatorTranscriptMessage => ({
  role: "assistant",
  parts: [{ toolName, toolArgs: {}, toolOutput, toolState: "completed" }],
});

/**
 * Script only the command transport: the live observer, waits and verdict run
 * unchanged. `steer` is what the scripted backend does with the correction.
 */
function fixture(platform: AgentPlatform, steer: "steered" | "queued until idle") {
  const bodies = deliverNowBodies({
    platform,
    token,
    startedPath: "",
    gatePath: "",
    terminalStartedPath: "",
    terminalGatePath: "",
  });
  const now = () => new Date().toISOString();
  const environments: Array<{ id: string; name: string }> = [];
  const messages: CoordinatorTranscriptMessage[] = [];
  const workerMessages: CoordinatorTranscriptMessage[] = [{ role: "user", content: "task" }];
  const mail: DelegationMailMessage[] = [];
  const tmuxMail: DelegationMailMessage[] = [];
  const paths: Record<string, string> = {};
  let delegation: Record<string, unknown> | null = null;
  let wakeReads = 0;
  let workerDone = false;
  const touch = (prompt: string, key: string) => {
    const match = /touch '([^']+)'/.exec(prompt);
    const gate = /\[ -f '([^']+)' \]/.exec(prompt);
    if (match?.[1]) paths[`${key}Started`] = match[1];
    if (gate?.[1]) paths[`${key}Gate`] = gate[1];
  };
  const settleGates = async () => {
    if (paths.workerStarted && !existsSync(paths.workerStarted))
      await writeFile(paths.workerStarted, "");
    if (paths.terminalStarted && !existsSync(paths.terminalStarted))
      await writeFile(paths.terminalStarted, "");
    if (!workerDone && paths.workerGate && existsSync(paths.workerGate)) {
      workerDone = true;
      const correction = mail.find((message) => message.toEnvironmentId === "worker");
      if (correction && correction.placement !== "injected") {
        correction.placement = "injected";
        correction.injectedAt = now();
        workerMessages.push({ role: "user", content: correction.body ?? "" });
      }
      mail.push({
        id: "report",
        createdAt: now(),
        from: { kind: "tab", environmentId: "worker", tabId: "startup-agent" },
        toEnvironmentId: "coordinator",
        toTabId: "coord-tab",
        placement: "injected",
        body: steer === "steered" ? bodies.corrected : bodies.uncorrected,
      });
      delegation = { ...delegation, state: "completed", wokenAt: now() };
      wakeReads = 3;
    }
    const held = tmuxMail[0];
    if (
      held &&
      held.placement !== "injected" &&
      paths.terminalGate &&
      existsSync(paths.terminalGate)
    ) {
      held.placement = "injected";
      held.injectedAt = now();
      delete held.placementReason;
    }
  };
  const invoke: DelegationCoordinator["invoke"] = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ) => {
    await settleGates();
    let value: unknown = null;
    switch (command) {
      case "get_environments":
        value = [...environments];
        break;
      case "get_prompt_queue":
        value = { messages: [] };
        break;
      case "get_project_coordinator":
        value = {
          workflows: delegation
            ? [
                {
                  kind: "environment",
                  conversationId: "conversation",
                  resourceId: "worker",
                  delegation,
                },
              ]
            : [],
        };
        break;
      case "dispatch_native_agent_intent": {
        const prompt = String(args.prompt);
        messages.push({ role: "user", content: "harness prompt" });
        if (prompt.includes("launch_environment")) {
          touch(
            JSON.parse(`"${/this exact prompt: "((?:[^"\\]|\\.)*)"/.exec(prompt)![1]}"`),
            "worker",
          );
          environments.push({ id: "worker", name: `deliver-now-${token}` });
          delegation = { requestedAt: now(), workerTabId: "startup-agent", state: "running" };
          messages.push(tool("launch_environment", '{"environmentId":"worker"}'));
        } else if (prompt.includes("launch_terminal")) {
          touch(
            JSON.parse(`"${/this exact prompt: "((?:[^"\\]|\\.)*)"/.exec(prompt)![1]}"`),
            "terminal",
          );
          messages.push(tool("mcp__orkestrator__launch_terminal", '{"tabId":"tmux-1"}'));
        } else if (prompt.includes('toTabId "tmux-1"')) {
          tmuxMail.push({
            id: "tmux-correction",
            createdAt: now(),
            from: { kind: "coordinator" },
            toEnvironmentId: "worker",
            toTabId: "tmux-1",
            placement: "pending-inject",
            placementReason: "steer-unsupported",
            body: bodies.terminalCorrection,
          });
          messages.push(tool("send_message", '{"deliverNow":"unsupported, queued"}'));
        } else {
          const steered = steer === "steered";
          mail.push({
            id: "correction",
            createdAt: now(),
            from: { kind: "coordinator" },
            toEnvironmentId: "worker",
            toTabId: "startup-agent",
            placement: steered ? "injected" : "pending-inject",
            ...(steered ? { injectedAt: now(), injectedVia: "steer" } : {}),
            body: bodies.correction,
          });
          if (steered) workerMessages.push({ role: "user", content: bodies.correction });
          messages.push(tool("send_message", JSON.stringify({ deliverNow: steer })));
        }
        break;
      }
      case "get_agent_mail_mailbox": {
        const all = args.tabId === "tmux-1" ? tmuxMail : mail;
        value = {
          messages: all
            .filter(
              (message) =>
                message.toEnvironmentId === args.environmentId && message.toTabId === args.tabId,
            )
            .map(({ body: _body, ...rest }) => ({ ...rest })),
        };
        break;
      }
      case "get_agent_mail_message": {
        const message = [...mail, ...tmuxMail].find((item) => item.id === args.messageId);
        value = message ? { body: message.body } : null;
        break;
      }
      case "get_native_agent_projection": {
        if (args.environmentId === "coordinator") {
          const phase = wakeReads > 0 ? "working" : "idle";
          if (wakeReads > 0) wakeReads -= 1;
          value = { turn: { phase }, messages: [...messages] };
        } else {
          value = {
            turn: { phase: workerDone ? "idle" : "working" },
            messages: [...workerMessages],
          };
        }
        break;
      }
      case "stop_environment":
      case "delete_environment":
        break;
      default:
        throw new Error(`unscripted command ${command}`);
    }
    return value as T;
  };
  const coordinator: DelegationCoordinator = {
    invoke,
    identity: { environmentId: "coordinator", agent: platform, logicalSessionKey: "coord" },
    conversation: { id: "conversation", tabId: "coord-tab" },
    projectId: "project",
  };
  const summary: CoordinatorLivePlatformSummary = {
    version: 1,
    platform,
    verdict: "passed",
    startedAt: "test",
  };
  return { coordinator, summary, paths };
}

async function run(platform: AgentPlatform, steer: "steered" | "queued until idle") {
  const { coordinator, summary, paths } = fixture(platform, steer);
  const cleanup: Array<() => Promise<unknown>> = [];
  try {
    const result = await runDeliverNowScenario({
      coordinator,
      summary,
      cleanup,
      token,
      pollIntervalMs: 1,
      quietMs: 5,
      steerWaitMs: 50,
    });
    return { ...result, paths };
  } finally {
    await runCoordinatorCleanup(cleanup, summary);
  }
}

const failures = (checks: Array<{ name: string; passed: boolean; detail?: string }>) =>
  checks.filter((item) => !item.passed).map((item) => `${item.name}: ${item.detail ?? ""}`);

test("a steered correction on a native worker qualifies, with no terminal case off Claude", async () => {
  const { checks, paths } = await run("codex", "steered");
  expect(failures(checks)).toEqual([]);
  expect(checks.some((item) => item.name.startsWith("terminal-"))).toBe(false);
  // The gate directory is removed with the case.
  expect(existsSync(paths.workerGate!)).toBe(false);
});

test("on Claude the tmux worker reports unsupported and gets the mail after its gate", async () => {
  const { checks } = await run("claude", "steered");
  expect(failures(checks)).toEqual([]);
  expect(checks.filter((item) => item.name.startsWith("terminal-"))).toHaveLength(4);
});

test("a correction that only reaches the worker at idle fails the scenario", async () => {
  const { checks } = await run("codex", "queued until idle");
  expect(failures(checks).map((failure) => failure.split(":")[0])).toEqual([
    "correction-steered",
    "steered-into-running-turn",
    "report-reflects-correction",
  ]);
});
