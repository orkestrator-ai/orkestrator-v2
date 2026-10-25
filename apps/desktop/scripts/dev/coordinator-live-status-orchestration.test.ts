import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentInteractionKind } from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  CoordinatorLivePlatformSummary,
  CoordinatorTranscriptMessage,
} from "./coordinator-live.js";
import type { DelegationMailMessage } from "./coordinator-live-delegation.js";
import { runCoordinatorCleanup, type DelegationCoordinator } from "./coordinator-live-observer.js";
import { runStatusScenario } from "./coordinator-live-status-orchestration.js";
import {
  STATUS_REVIEWEE_FILE,
  STATUS_REVIEW_DONE_MARKER,
  STATUS_WAITING_MARKER,
  STATUS_WAITER_DONE_MARKER,
} from "./coordinator-live-status.js";

const token = "scripted";
const assistant = (content: string): CoordinatorTranscriptMessage => ({
  role: "assistant",
  content,
});
const tool = (toolName: string, toolArgs = {}, toolOutput = ""): CoordinatorTranscriptMessage => ({
  role: "assistant",
  parts: [{ toolName, toolArgs, toolOutput, toolState: "completed" }],
});
const carrier = (id: string): CoordinatorTranscriptMessage => ({
  role: "user",
  content: `<orkestrator-peer-message version="1">\n<orkestrator-peer-payload-json>\n${JSON.stringify({ messageId: id })}\n</orkestrator-peer-payload-json>\n</orkestrator-peer-message>`,
});

/** Script only the command transport: the live observer, waits and evaluators run unchanged. */
async function fixture(
  options: {
    platform?: AgentPlatform;
    startupInteraction?: AgentInteractionKind;
    reviewFails?: boolean;
    releaseFailsOnce?: boolean;
  } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "status-orchestration-"));
  const platform = options.platform ?? "claude";
  const cleanup: Array<() => Promise<unknown>> = [];
  const summary: CoordinatorLivePlatformSummary = {
    version: 1,
    platform,
    verdict: "passed",
    startedAt: "test",
  };
  const commands: Array<{ command: string; args: Record<string, unknown> }> = [];
  const environments: Array<{ id: string; name: string }> = [{ id: "existing", name: "existing" }];
  const previousSettings = { defaultAgent: "pi", multiReview: { autoFix: true } };
  let global: Record<string, unknown> = { agentSettings: previousSettings, preserved: true };
  let stage = "startup";
  let reads = 0;
  let startupPending = !!options.startupInteraction;
  let released = false;
  let releaseAttempts = 0;
  const createdAt = Date.now() - 25_000;
  let messages: CoordinatorTranscriptMessage[] = [];
  const mail: DelegationMailMessage[] = [];
  const notice = (id: string, state: string, environmentId: string, kind: string, tone: string) => {
    mail.push({
      id,
      createdAt: new Date(createdAt + 20_000).toISOString(),
      from: { kind: "system" },
      toEnvironmentId: "coordinator",
      toTabId: "tab",
      placement: "injected",
      notice: { resource: { kind, id: `${environmentId}:resource`, environmentId }, state, tone },
    });
    messages.push(carrier(id));
  };
  const invoke: DelegationCoordinator["invoke"] = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ) => {
    commands.push({ command, args });
    let value: unknown = null;
    switch (command) {
      case "get_environments":
        value = [...environments];
        break;
      case "get_config":
        value = { global };
        break;
      case "update_global_config":
        global = args.global as Record<string, unknown>;
        break;
      case "create_environment": {
        const id = String(args.name).startsWith("status-review-") ? "reviewee" : "waiter";
        environments.push({ id, name: String(args.name) });
        value = { id };
        break;
      }
      case "start_environment":
        break;
      case "get_environment":
        value = { worktreePath: directory };
        break;
      case "stop_environment":
        break;
      case "delete_environment": {
        const index = environments.findIndex((item) => item.id === args.environmentId);
        environments.splice(index, 1);
        break;
      }
      case "get_prompt_queue":
        value = { messages: [] };
        break;
      case "get_project_coordinator":
        value = {
          workflows:
            stage === "waiting" || released
              ? [
                  {
                    kind: "environment",
                    conversationId: "conversation",
                    resourceId: "waiter",
                    delegation: {
                      state: released ? "completed" : "running",
                      workerTabId: "startup-agent",
                    },
                  },
                ]
              : [],
        };
        break;
      case "dispatch_native_agent_intent": {
        stage = String(args.prompt).includes("launch_multi_review") ? "review" : "waiting";
        reads = 0;
        messages.push({ role: "user", content: "scenario prompt" });
        messages.push(
          stage === "review"
            ? tool("launch_multi_review", {}, '{"delivery":"async"}')
            : tool("send_prompt_to_tab", { environmentId: "waiter" }),
        );
        break;
      }
      case "get_agent_mail_mailbox": {
        if (args.environmentId === "coordinator") {
          reads += 1;
          if (stage === "review" && reads === 2) {
            notice(
              "ready",
              options.reviewFails ? "failed" : "ready",
              "reviewee",
              "multi-review",
              "attention",
            );
            if (!options.reviewFails) messages.push(tool("address_multi_review"));
          }
          if (stage === "review" && reads === 4 && !options.reviewFails) {
            notice("fix", "fix-done", "reviewee", "multi-review", "success");
            messages.push(assistant(`${STATUS_REVIEW_DONE_MARKER} ${token}`));
          }
          if (stage === "waiting" && reads === 4) {
            notice("waiting", "waiting", "waiter", "agent-tab", "attention");
            messages.push(assistant(`${STATUS_WAITING_MARKER} ${token}`));
          }
        }
        value = { messages: args.environmentId === "coordinator" ? [...mail] : [] };
        break;
      }
      case "get_native_agent_projection": {
        if (args.environmentId === "coordinator")
          value = { turn: { phase: "idle" }, messages: [...messages] };
        else {
          const pending = startupPending || (stage === "waiting" && !released);
          value = {
            turn: { phase: pending ? "waiting" : "idle" },
            messages: [assistant("ready")],
            interactions: pending
              ? [
                  {
                    id: startupPending ? "startup" : "held",
                    kind: startupPending ? options.startupInteraction : "command-approval",
                    state: "pending",
                    sessionId: "s",
                    createdAt,
                  },
                ]
              : [],
          };
        }
        break;
      }
      case "resolve_native_agent_interaction": {
        const resolution = args.resolution as { action: string };
        if (args.interactionId === "startup") {
          expect(resolution.action).toBe(
            options.startupInteraction === "question" ? "cancel" : "deny",
          );
          startupPending = false;
        } else {
          expect(stage).toBe("waiting");
          expect(reads).toBeGreaterThanOrEqual(4);
          expect(messages.at(-1)?.content).toBe(`${STATUS_WAITING_MARKER} ${token}`);
          expect(resolution.action).toBe("deny");
          releaseAttempts += 1;
          if (options.releaseFailsOnce && releaseAttempts === 1)
            throw new Error("transient denial failure");
          released = true;
          mail.push({
            id: "report",
            createdAt: new Date().toISOString(),
            from: { kind: "tab", environmentId: "waiter" },
            toEnvironmentId: "coordinator",
            toTabId: "tab",
            placement: "injected",
          });
          messages.push(carrier("report"), assistant(`${STATUS_WAITER_DONE_MARKER} ${token}`));
        }
        break;
      }
      default:
        throw new Error(`Unexpected command ${command}`);
    }
    return value as T;
  };
  const coordinator: DelegationCoordinator = {
    invoke,
    identity: { agent: platform, environmentId: "coordinator", logicalSessionKey: "session" },
    projectId: "project",
    conversation: { id: "conversation", tabId: "tab" },
  };
  return {
    directory,
    cleanup,
    summary,
    commands,
    environments,
    previousSettings,
    config: () => global,
    run: () => runStatusScenario({ coordinator, summary, cleanup, token, pollIntervalMs: 0 }),
    close: async () => {
      await runCoordinatorCleanup(cleanup, summary);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("status flow creates/starts environments, waits for review and waiting wakes, then releases and receives report", async () => {
  const f = await fixture();
  try {
    const result = await f.run();
    expect(result.checks.filter((check) => !check.passed)).toEqual([]);
    expect(await readFile(path.join(f.directory, STATUS_REVIEWEE_FILE.path), "utf8")).toBe(
      STATUS_REVIEWEE_FILE.content,
    );
    expect(
      f.commands
        .filter((item) => item.command === "start_environment")
        .map((item) => item.args.environmentId),
    ).toEqual(["reviewee", "waiter"]);
    expect(
      f.commands.filter((item) => item.command === "resolve_native_agent_interaction"),
    ).toHaveLength(1);
    expect(result.watch.held("waiter")).toEqual([
      {
        kind: "command-approval",
        createdAt: expect.any(Number),
        seenAt: expect.any(Number),
        releasedAt: expect.any(Number),
      },
    ]);
    expect(
      result.watch.observations.some(
        (sample) =>
          sample.mail.some((item) => item.id === "waiting") &&
          !sample.mail.some((item) => item.id === "report"),
      ),
    ).toBe(true);
    expect(result.watch.observations.at(-1)?.mail.some((item) => item.id === "report")).toBe(true);
    expect((f.config().agentSettings as { defaultAgent: string }).defaultAgent).toBe("claude");
  } finally {
    await f.close();
  }
  expect(f.environments.map((item) => item.id)).toEqual(["existing"]);
  expect(f.config()).toEqual({ agentSettings: f.previousSettings, preserved: true });
  expect(f.summary.verdict).toBe("passed");
});

for (const kind of ["question", "command-approval"] as const) {
  test(`startup ${kind} is cleaned up and fails qualification even after the worker goes idle`, async () => {
    const f = await fixture({ startupInteraction: kind });
    try {
      await expect(f.run()).rejects.toThrow(`startup turn required harness intervention: ${kind}`);
      expect(f.summary.escapedInteractions).toEqual([kind]);
      expect(
        f.commands.filter((item) => item.command === "resolve_native_agent_interaction"),
      ).toHaveLength(1);
      expect(f.commands.some((item) => item.command === "dispatch_native_agent_intent")).toBe(
        false,
      );
    } finally {
      await f.close();
    }
    expect(f.environments.map((item) => item.id)).toEqual(["existing"]);
    expect(f.config().agentSettings).toEqual(f.previousSettings);
  });
}

test("a failed review notice fails qualification while the approval part still cleans up", async () => {
  const f = await fixture({ reviewFails: true });
  try {
    const result = await f.run();
    expect(result.checks.find((item) => item.name === "review-finished")).toMatchObject({
      passed: false,
      detail: "the Multi Review reported failed",
    });
    expect(result.checks.find((item) => item.name === "waiting-finished")?.passed).toBe(true);
  } finally {
    await f.close();
  }
});

test("Cursor runs review qualification without creating an approval waiter", async () => {
  const f = await fixture({ platform: "cursor" });
  try {
    const result = await f.run();
    expect(result.checks.filter((check) => !check.passed)).toEqual([]);
    expect(result.holdsApproval).toBe(false);
    expect(f.commands.filter((item) => item.command === "create_environment")).toHaveLength(1);
    expect(f.commands.some((item) => item.command === "resolve_native_agent_interaction")).toBe(
      false,
    );
  } finally {
    await f.close();
  }
});

test("a release failure fails qualification and the recovery release retries it", async () => {
  const f = await fixture({ releaseFailsOnce: true });
  try {
    const result = await f.run();
    expect(result.checks.find((item) => item.name === "waiting-finished")).toMatchObject({
      passed: false,
      detail: "Held interaction release failed",
    });
    expect(
      f.commands.filter((item) => item.command === "resolve_native_agent_interaction"),
    ).toHaveLength(2);
    expect(result.watch.held("waiter")[0]?.releasedAt).toEqual(expect.any(Number));
  } finally {
    await f.close();
  }
  expect(f.environments.map((item) => item.id)).toEqual(["existing"]);
});
