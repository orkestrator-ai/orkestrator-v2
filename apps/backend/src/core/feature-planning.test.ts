import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FeaturePlanningRecord } from "@orkestrator/protocol/feature-planning";
import { StorageService } from "./storage.js";
import { FeaturePlanningService } from "./feature-planning.js";
import {
  AmbiguousPromptDispatchError,
  type BuildPipelineProvider,
  type ProviderActivityState,
  type ProviderCreateSessionOptions,
  type ProviderSendOptions,
  type ProviderStatus,
} from "./build-pipeline-provider.js";

const PLANNER_REPLY = [
  "Here is what I understand so far.",
  "<feature_planner_state>",
  '{"phase":"confirming","title":"Bulk export","summary":"Export every report as CSV"}',
  "</feature_planner_state>",
].join("\n");

const STORY_REPLY = [
  "Tightened the acceptance criteria.",
  "<story_refinement>",
  '{"storyId":"story-1","title":"Export as CSV","description":"A user exports every report.","acceptanceCriteria":["The file downloads"]}',
  "</story_refinement>",
].join("\n");

interface BridgeMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  modelId?: string;
}

/**
 * Bridge stand-in.
 *
 * Records every dispatch so at-most-once can be asserted directly, and lets a
 * test decide when the turn goes idle and what the transcript then contains.
 */
class FakeProvider implements BuildPipelineProvider {
  readonly agent = "codex" as const;
  readonly sends: Array<{ sessionId: string; prompt: string; requestId: string }> = [];
  readonly created: string[] = [];
  activityState: ProviderActivityState = "working";
  statusState: ProviderStatus = "idle";
  transcript: BridgeMessage[] = [];
  aborted: string[] = [];
  disposeCount = 0;
  sendBehaviour: "ok" | "ambiguous" | "reject" = "ok";
  statusError: Error | null = null;
  activityError: Error | null = null;
  messagesError: Error | null = null;
  createError: Error | null = null;
  sendGate: Promise<void> | null = null;
  onSendStart: (() => void) | null = null;
  onAbort: (() => void) | null = null;

  async createSession(
    _phase: string,
    _label: string,
    options?: ProviderCreateSessionOptions,
  ): Promise<string> {
    if (this.createError) throw this.createError;
    const id = `session-${this.created.length + 1}`;
    this.created.push(options?.clientSessionKey ?? id);
    return id;
  }

  async send(sessionId: string, prompt: string, options: ProviderSendOptions): Promise<void> {
    this.onSendStart?.();
    if (this.sendGate) await this.sendGate;
    if (this.sendBehaviour === "ambiguous") {
      // Recorded first: an ambiguous dispatch may well have reached the agent.
      this.sends.push({ sessionId, prompt, requestId: options.requestId });
      throw new AmbiguousPromptDispatchError("The bridge did not answer");
    }
    if (this.sendBehaviour === "reject") throw new Error("Prompt rejected");
    this.sends.push({ sessionId, prompt, requestId: options.requestId });
  }

  async status(): Promise<ProviderStatus> {
    if (this.statusError) throw this.statusError;
    return this.statusState;
  }

  async activity(): Promise<ProviderActivityState> {
    if (this.activityError) throw this.activityError;
    return this.activityState;
  }

  async messages(): Promise<unknown[]> {
    if (this.messagesError) throw this.messagesError;
    return this.transcript;
  }

  async structured<T>(): Promise<null> {
    void 0 as unknown as T;
    return null;
  }

  async abort(sessionId: string): Promise<void> {
    this.aborted.push(sessionId);
    this.onAbort?.();
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
  }

  /** The turn finishes with `content` as the newest assistant message. */
  reply(content: string, modelId = "gpt-5-codex"): void {
    this.transcript = [...this.transcript, {
      id: `assistant-${this.transcript.length + 1}`,
      role: "assistant",
      content,
      createdAt: new Date().toISOString(),
      modelId,
    }];
    this.activityState = "idle";
  }
}

interface Harness {
  service: FeaturePlanningService;
  storage: StorageService;
  provider: FakeProvider;
  providers: FakeProvider[];
  featureId: string;
  /**
   * Start an exchange and let the supervisor run its first pass.
   *
   * `start` deliberately returns before the turn is dispatched — the caller is
   * a command handler that must not block on a bridge. Production drives the
   * rest from the tick loop; these tests drive it explicitly.
   */
  start(input: { kind: "feature" | "story"; storyId?: string; userMessage: string }): Promise<void>;
  record(): Promise<FeaturePlanningRecord | undefined>;
  dispose(): Promise<void>;
}

type TestInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

async function harness(options: {
  withStory?: boolean;
  providers?: FakeProvider[];
  serviceOptions?: ConstructorParameters<typeof FeaturePlanningService>[2];
  invoke?: (storage: StorageService) => TestInvoker;
} = {}): Promise<Harness> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-feature-planning-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-1",
    projectId: "project-1",
    name: "planning",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/planning",
    setupScriptsComplete: true,
  });
  const plan = await storage.createFeaturePlan("project-1");
  await storage.updateFeaturePlan(plan.id, {
    codexEnvironmentId: "env-1",
    codexSessionId: "session-existing",
    ...(options.withStory
      ? {
        stories: [{
          id: "story-1",
          title: "Export",
          description: "A user exports.",
          acceptanceCriteria: ["It downloads"],
          messages: [],
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        }],
      }
      : {}),
  });
  const providers = options.providers ?? [new FakeProvider()];
  const provider = providers[0]!;
  let providerIndex = 0;
  const service = new FeaturePlanningService(
    storage,
    options.invoke?.(storage) ?? (async <T>() => undefined as T),
    {
      ...options.serviceOptions,
      autoAdvance: false,
      provider: async () => providers[Math.min(providerIndex++, providers.length - 1)]!,
    },
  );
  return {
    service,
    storage,
    provider,
    providers,
    featureId: plan.id,
    start: async (input) => {
      await service.start({ featureId: plan.id, ...input });
      await service.advanceNow(plan.id);
    },
    record: async () => (await storage.getFeaturePlan(plan.id))?.planning,
    dispose: async () => {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

describe("FeaturePlanningService", () => {
  test("carries a feature turn from dispatch to an applied state block", async () => {
    const context = await harness();
    try {
      await context.start({ kind: "feature", userMessage: "Let me export reports" });

      // The user's message is durable before anything reaches the bridge.
      const plan = await context.storage.getFeaturePlan(context.featureId);
      expect(plan?.messages.at(-1)).toMatchObject({
        role: "user",
        content: "Let me export reports",
      });
      expect((await context.record())?.phase).toBe("running");
      expect(context.provider.sends).toHaveLength(1);

      // Still working: nothing is read out of the transcript yet.
      await context.service.advanceNow(context.featureId);
      expect((await context.record())?.phase).toBe("running");

      context.provider.reply(PLANNER_REPLY);
      await context.service.advanceNow(context.featureId);
      expect((await context.record())?.phase).toBe("persisting");
      expect((await context.record())?.rawResponse).toBe(PLANNER_REPLY);

      await context.service.advanceNow(context.featureId);
      const settled = await context.storage.getFeaturePlan(context.featureId);
      expect(settled?.planning).toBeUndefined();
      expect(settled?.status).toBe("confirming");
      expect(settled?.title).toBe("Bulk export");
      expect(settled?.summary).toBe("Export every report as CSV");
      expect(settled?.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: PLANNER_REPLY,
        stateApplication: "applied",
        modelId: "gpt-5-codex",
      });
    } finally {
      await context.dispose();
    }
  });

  test("applies a story refinement to the card it names", async () => {
    const context = await harness({ withStory: true });
    try {
      await context.start({
        kind: "story",
        storyId: "story-1",
        userMessage: "Tighten the criteria",
      });
      context.provider.reply(STORY_REPLY);
      await context.service.advanceNow(context.featureId);
      await context.service.advanceNow(context.featureId);

      const plan = await context.storage.getFeaturePlan(context.featureId);
      const story = plan?.stories[0];
      expect(story?.title).toBe("Export as CSV");
      expect(story?.acceptanceCriteria).toEqual(["The file downloads"]);
      expect(story?.messages.map((entry) => entry.role)).toEqual(["user", "assistant"]);
      expect(story?.messages.at(-1)?.stateApplication).toBe("applied");
      expect(plan?.planning).toBeUndefined();
    } finally {
      await context.dispose();
    }
  });

  test("never re-dispatches a turn whose prompt may already have run", async () => {
    const context = await harness();
    try {
      context.provider.sendBehaviour = "ambiguous";
      await context.start({ kind: "feature", userMessage: "Let me export reports" });

      // The dispatch is recorded even though the bridge never confirmed it.
      expect(context.provider.sends).toHaveLength(1);
      const record = await context.record();
      expect(record?.phase).toBe("running");
      expect(record?.dispatchId).toBeString();

      // Every subsequent pass reconciles from the transcript instead of sending.
      context.provider.sendBehaviour = "ok";
      await context.service.advanceNow(context.featureId);
      await context.service.advanceNow(context.featureId);
      expect(context.provider.sends).toHaveLength(1);

      context.provider.reply(PLANNER_REPLY);
      await context.service.advanceNow(context.featureId);
      await context.service.advanceNow(context.featureId);
      expect(context.provider.sends).toHaveLength(1);
      expect((await context.storage.getFeaturePlan(context.featureId))?.status)
        .toBe("confirming");
    } finally {
      await context.dispose();
    }
  });

  test("a crash between recording the dispatch and sending does not send twice", async () => {
    const context = await harness();
    try {
      await context.start({ kind: "feature", userMessage: "Let me export reports" });
      expect(context.provider.sends).toHaveLength(1);

      // Rewind the record to the state a crash immediately after stamping the
      // dispatch id would have left behind.
      const record = (await context.record())!;
      await context.storage.mutateFeaturePlanning(
        context.featureId,
        record.operationId,
        (_plan, current) => {
          current.phase = "dispatching";
          current.dispatchState = "prepared";
        },
      );

      await context.service.advanceNow(context.featureId);

      expect(context.provider.sends).toHaveLength(1);
      expect((await context.record())?.phase).toBe("running");
    } finally {
      await context.dispose();
    }
  });

  test("a parse failure keeps the reply and retry dispatches a fresh turn", async () => {
    const context = await harness();
    try {
      await context.start({ kind: "feature", userMessage: "Let me export reports" });
      context.provider.reply("I have no idea what a state block is.");
      await context.service.advanceNow(context.featureId);
      await context.service.advanceNow(context.featureId);

      const record = await context.record();
      expect(record?.phase).toBe("failed");
      expect(record?.failure?.code).toBe("parse");
      expect(record?.failure?.retryPhase).toBe("dispatching");
      // The answer itself is on the record and on the plan.
      expect(record?.rawResponse).toBe("I have no idea what a state block is.");
      const plan = await context.storage.getFeaturePlan(context.featureId);
      expect(plan?.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "I have no idea what a state block is.",
        stateApplication: "pending",
      });
      // Retrying starts a new provider turn while retaining the malformed
      // answer as auditable history.
      context.provider.activityState = "working";
      await context.service.retry(context.featureId);
      await context.service.advanceNow(context.featureId);
      expect(context.provider.sends).toHaveLength(2);
      context.provider.reply(PLANNER_REPLY);
      await context.service.advanceNow(context.featureId);
      await context.service.advanceNow(context.featureId);
      const retried = await context.storage.getFeaturePlan(context.featureId);
      expect(
        retried?.messages.filter((entry) => entry.role === "assistant"
          && entry.content === "I have no idea what a state block is.").length,
      ).toBe(1);
      expect(retried?.messages.at(-1)?.content).toBe(PLANNER_REPLY);
      expect(retried?.messages.at(-2)?.stateApplication).toBe("superseded");
      expect(retried?.planning).toBeUndefined();
    } finally {
      await context.dispose();
    }
  });

  test("gives up on an idle session that never received the prompt", async () => {
    const context = await harness();
    try {
      await context.start({ kind: "feature", userMessage: "Let me export reports" });
      context.provider.activityState = "idle";

      await context.service.advanceNow(context.featureId);
      expect((await context.record())?.phase).toBe("running");

      // The grace period is what separates "the turn has not started yet" from
      // "the prompt was lost"; the second pass is past it.
      await Bun.sleep(5);
      const service = new FeaturePlanningService(
        context.storage,
        async <T>() => undefined as T,
        { autoAdvance: false, provider: async () => context.provider, idleWithoutReplyMs: 0 },
      );
      await service.advanceNow(context.featureId);
      await service.shutdown();

      const record = await context.record();
      expect(record?.phase).toBe("failed");
      expect(record?.failure?.code).toBe("dispatch");
      expect(record?.failure?.retryPhase).toBe("dispatching");
    } finally {
      await context.dispose();
    }
  });

  test("refuses a second concurrent exchange for the same feature", async () => {
    const context = await harness();
    try {
      await context.start({ kind: "feature", userMessage: "First" });
      await expect(context.service.start({
        featureId: context.featureId,
        kind: "feature",
        userMessage: "Second",
      })).rejects.toThrow("already running");
      expect(context.provider.sends).toHaveLength(1);
    } finally {
      await context.dispose();
    }
  });

  test("validates story targets and retry requests before starting work", async () => {
    const context = await harness();
    try {
      await expect(context.service.start({
        featureId: context.featureId,
        kind: "story",
        storyId: "missing-story",
        userMessage: "Refine it",
      })).rejects.toThrow("Feature story not found");
      await expect(context.service.retry(context.featureId)).rejects.toThrow(
        "There is no planning request to retry",
      );
      await context.service.cancel(context.featureId);
      expect(context.provider.sends).toHaveLength(0);
    } finally {
      await context.dispose();
    }
  });

  test("creates a replacement provider session when the stored session is missing", async () => {
    const context = await harness();
    try {
      context.provider.statusState = "missing";
      await context.start({ kind: "feature", userMessage: "Let me export reports" });

      expect(context.provider.created).toEqual([`feature-planning:${context.featureId}`]);
      expect(context.provider.sends[0]?.sessionId).toBe("session-1");
      expect((await context.storage.getFeaturePlan(context.featureId))?.codexSessionId)
        .toBe("session-1");
    } finally {
      await context.dispose();
    }
  });

  test("keeps environment creation failures retryable without dispatching", async () => {
    const context = await harness({
      invoke: () => async <T>(command: string) => {
        if (command === "create_environment") throw new Error("environment service unavailable");
        return undefined as T;
      },
    });
    try {
      await context.storage.updateFeaturePlan(context.featureId, {
        codexEnvironmentId: undefined,
        codexSessionId: undefined,
      });
      await context.storage.removeEnvironment("env-1");
      await context.service.start({
        featureId: context.featureId,
        kind: "feature",
        userMessage: "Let me export reports",
      });
      await context.service.advanceNow(context.featureId);

      expect((await context.record())?.phase).toBe("dispatching");
      expect((await context.record())?.failure).toBeUndefined();
      expect(context.provider.sends).toHaveLength(0);
    } finally {
      await context.dispose();
    }
  });

  test("cancelling aborts the turn and detaches the record without retracting the plan", async () => {
    const context = await harness();
    try {
      await context.start({ kind: "feature", userMessage: "Let me export reports" });

      await context.service.cancel(context.featureId);

      expect(context.provider.aborted).toEqual(["session-existing"]);
      const plan = await context.storage.getFeaturePlan(context.featureId);
      expect(plan?.planning).toBeUndefined();
      // The user's message is theirs; cancelling the workflow does not erase it.
      expect(plan?.messages.at(-1)?.content).toBe("Let me export reports");
    } finally {
      await context.dispose();
    }
  });

  test("cancelling while send is in flight aborts and never leaves a hidden turn", async () => {
    const context = await harness();
    try {
      let releaseSend!: () => void;
      let markStarted!: () => void;
      const sendStarted = new Promise<void>((resolve) => { markStarted = resolve; });
      context.provider.sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
      context.provider.onSendStart = markStarted;
      // Model a provider whose hung send is released only by abort. If cancel
      // waited for the feature lock before aborting, this test would deadlock.
      context.provider.onAbort = releaseSend;

      await context.service.start({
        featureId: context.featureId,
        kind: "feature",
        userMessage: "Let me export reports",
      });
      await sendStarted;
      await context.service.cancel(context.featureId);

      expect(context.provider.sends).toHaveLength(1);
      expect(context.provider.aborted).toEqual(["session-existing"]);
      expect((await context.storage.getFeaturePlan(context.featureId))?.planning).toBeUndefined();
    } finally {
      await context.dispose();
    }
  });

  test("does not accept a refinement block naming another story", async () => {
    const context = await harness({ withStory: true });
    try {
      await context.start({ kind: "story", storyId: "story-1", userMessage: "Tighten it" });
      context.provider.reply(STORY_REPLY.replace('"story-1"', '"story-other"'));
      await context.service.advanceNow(context.featureId);

      const record = await context.record();
      const story = (await context.storage.getFeaturePlan(context.featureId))?.stories[0];
      expect(record?.phase).toBe("running");
      expect(record?.rawResponse).toBeUndefined();
      expect(story?.title).toBe("Export");
      expect(story?.messages.map((entry) => entry.role)).toEqual(["user"]);
    } finally {
      await context.dispose();
    }
  });

  test("rejects a mismatched story id again at the persistence boundary", async () => {
    const context = await harness({ withStory: true });
    try {
      await context.start({ kind: "story", storyId: "story-1", userMessage: "Tighten it" });
      const record = (await context.record())!;
      const wrongReply = STORY_REPLY.replace('"story-1"', '"story-other"');
      await context.storage.mutateFeaturePlanning(
        context.featureId,
        record.operationId,
        (_plan, current) => {
          current.phase = "persisting";
          current.rawResponse = wrongReply;
        },
      );

      await context.service.advanceNow(context.featureId);
      const failed = await context.record();
      const story = (await context.storage.getFeaturePlan(context.featureId))?.stories[0];
      expect(failed?.phase).toBe("failed");
      expect(failed?.failure?.code).toBe("parse");
      expect(failed?.failure?.retryPhase).toBe("dispatching");
      expect(story?.title).toBe("Export");
    } finally {
      await context.dispose();
    }
  });

  test("uses dispatch time for reply timeout and resets attempt time on retry", async () => {
    const context = await harness({ serviceOptions: { replyDeadlineMs: 50 } });
    try {
      await context.start({ kind: "feature", userMessage: "Let me export reports" });
      const running = (await context.record())!;
      expect(running.dispatchedAt).toBeString();
      await context.storage.mutateFeaturePlanning(
        context.featureId,
        running.operationId,
        (_plan, current) => {
          // The overall exchange may be old; only the actual dispatch clock
          // governs a running provider turn.
          current.startedAt = new Date(0).toISOString();
        },
      );
      await context.service.advanceNow(context.featureId);
      expect((await context.record())?.phase).toBe("running");

      const stillRunning = (await context.record())!;
      await context.storage.mutateFeaturePlanning(
        context.featureId,
        stillRunning.operationId,
        (_plan, current) => { current.dispatchedAt = new Date(0).toISOString(); },
      );
      await context.service.advanceNow(context.featureId);
      expect((await context.record())?.phase).toBe("failed");

      const beforeRetry = Date.now();
      await context.service.retry(context.featureId);
      const retried = await context.record();
      expect(retried?.phase).not.toBe("failed");
      expect(Date.parse(retried?.attemptStartedAt ?? "")).toBeGreaterThanOrEqual(beforeRetry);
    } finally {
      await context.dispose();
    }
  });

  test("bounds a large transcript baseline without selecting omitted history", async () => {
    const context = await harness();
    try {
      context.provider.transcript = Array.from({ length: 700 }, (_, index) => ({
        id: `old-assistant-${index}`,
        role: "assistant",
        content: `Old response ${index}`,
        createdAt: new Date(index + 1).toISOString(),
      }));
      await context.start({ kind: "feature", userMessage: "A new request" });
      expect((await context.record())?.baselineAssistantIds).toHaveLength(512);

      context.provider.activityState = "idle";
      await context.service.advanceNow(context.featureId);
      expect((await context.record())?.phase).toBe("running");
      expect((await context.record())?.rawResponse).toBeUndefined();
    } finally {
      await context.dispose();
    }
  });

  test("a restarted backend finishes a turn the previous process dispatched", async () => {
    const context = await harness();
    try {
      await context.start({ kind: "feature", userMessage: "Let me export reports" });
      await context.service.shutdown();

      // A new process reads the same durable record.
      const restarted = new FeaturePlanningService(
        context.storage,
        async <T>() => undefined as T,
        { autoAdvance: false, provider: async () => context.provider },
      );
      await restarted.init();
      context.provider.reply(PLANNER_REPLY);
      await restarted.advanceNow(context.featureId);
      await restarted.advanceNow(context.featureId);
      await restarted.shutdown();

      const plan = await context.storage.getFeaturePlan(context.featureId);
      expect(plan?.status).toBe("confirming");
      expect(plan?.planning).toBeUndefined();
      expect(context.provider.sends).toHaveLength(1);
    } finally {
      await context.dispose();
    }
  });

  test("evicts a failed cached provider and resumes from a rediscovered bridge", async () => {
    const first = new FakeProvider();
    const second = new FakeProvider();
    const context = await harness({ providers: [first, second] });
    try {
      await context.start({ kind: "feature", userMessage: "Let me export reports" });
      first.activityError = new Error("bridge connection closed");

      // This pass is transient, but it invalidates the cached connection.
      await context.service.advanceNow(context.featureId);
      expect((await context.record())?.phase).toBe("running");
      expect(first.disposeCount).toBe(1);

      second.reply(PLANNER_REPLY);
      await context.service.advanceNow(context.featureId);
      await context.service.advanceNow(context.featureId);
      expect((await context.storage.getFeaturePlan(context.featureId))?.status).toBe("confirming");
      expect(first.sends).toHaveLength(1);
      expect(second.sends).toHaveLength(0);
    } finally {
      await context.dispose();
    }
  });

  test("rediscovers the bridge when session lookup fails before dispatch", async () => {
    const first = new FakeProvider();
    const second = new FakeProvider();
    first.statusError = new Error("stale bridge port");
    const context = await harness({ providers: [first, second] });
    try {
      await context.start({ kind: "feature", userMessage: "Let me export reports" });

      expect(first.disposeCount).toBe(1);
      expect(first.sends).toHaveLength(0);
      expect(second.sends).toHaveLength(1);
      expect((await context.record())?.phase).toBe("running");
    } finally {
      await context.dispose();
    }
  });

  test("adopts a conversation the renderer-driven controller left in flight", async () => {
    const context = await harness();
    try {
      // What an older version left behind: a persisted user message with no
      // answer after it, and no record of any kind.
      await context.storage.appendFeaturePlanMessage(
        context.featureId,
        "user",
        "Left in flight",
      );

      await context.service.init();

      const record = await context.record();
      expect(record?.phase).toBe("running");
      expect(record?.userMessage).toBe("Left in flight");
      // Adopted as already-dispatched, so it is reconciled and never re-sent.
      expect(record?.dispatchState).toBe("sent");
      expect(context.provider.sends).toHaveLength(0);

      context.provider.reply(PLANNER_REPLY);
      await context.service.advanceNow(context.featureId);
      await context.service.advanceNow(context.featureId);
      expect(context.provider.sends).toHaveLength(0);
      expect((await context.storage.getFeaturePlan(context.featureId))?.status)
        .toBe("confirming");
    } finally {
      await context.dispose();
    }
  });

  test("legacy adoption ignores assistant history from before the pending user message", async () => {
    const context = await harness();
    try {
      await context.storage.appendFeaturePlanMessage(
        context.featureId,
        "assistant",
        PLANNER_REPLY,
        "applied",
      );
      await Bun.sleep(2);
      await context.storage.appendFeaturePlanMessage(context.featureId, "user", "Left in flight");
      const pending = (await context.storage.getFeaturePlan(context.featureId))?.messages.at(-1);
      context.provider.transcript = [
        {
          id: "historical-assistant",
          role: "assistant",
          content: PLANNER_REPLY,
          createdAt: new Date(Date.parse(pending!.createdAt) - 1_000).toISOString(),
        },
        {
          id: "assistant-without-a-clock",
          role: "assistant",
          content: PLANNER_REPLY.replace("Bulk export", "Undated export"),
          createdAt: "",
        },
        {
          id: "assistant-with-an-invalid-clock",
          role: "assistant",
          content: PLANNER_REPLY.replace("Bulk export", "Invalid date export"),
          createdAt: "not-an-iso-date",
        },
      ];
      context.provider.activityState = "idle";

      await context.service.init();
      await context.service.advanceNow(context.featureId);
      expect((await context.record())?.phase).toBe("running");
      expect((await context.record())?.rawResponse).toBeUndefined();

      // Millisecond timestamps can collide; equality is not evidence that the
      // assistant message predates the pending user message.
      context.provider.transcript.push({
        id: "current-assistant",
        role: "assistant",
        content: PLANNER_REPLY.replace("Bulk export", "Current export"),
        createdAt: pending!.createdAt,
      });
      await context.service.advanceNow(context.featureId);
      await context.service.advanceNow(context.featureId);
      expect((await context.storage.getFeaturePlan(context.featureId))?.title).toBe("Current export");
    } finally {
      await context.dispose();
    }
  });

  test("fails safely when the target story is deleted before persistence", async () => {
    const context = await harness({ withStory: true });
    try {
      await context.start({ kind: "story", storyId: "story-1", userMessage: "Tighten it" });
      await context.storage.updateFeaturePlan(context.featureId, { stories: [] });
      context.provider.reply(STORY_REPLY);
      await context.service.advanceNow(context.featureId);
      await context.service.advanceNow(context.featureId);

      const failed = await context.record();
      expect(failed?.phase).toBe("failed");
      expect(failed?.failure?.code).toBe("persistence");
      expect((await context.storage.getFeaturePlan(context.featureId))?.stories).toEqual([]);
    } finally {
      await context.dispose();
    }
  });

  test("a plan already building is not dragged back by an in-flight reply", async () => {
    const context = await harness();
    try {
      await context.start({ kind: "feature", userMessage: "Let me export reports" });
      await context.storage.updateFeaturePlan(context.featureId, { status: "building" });

      context.provider.reply(PLANNER_REPLY);
      await context.service.advanceNow(context.featureId);
      await context.service.advanceNow(context.featureId);

      const plan = await context.storage.getFeaturePlan(context.featureId);
      expect(plan?.status).toBe("building");
      expect(plan?.messages.at(-1)?.stateApplication).toBe("superseded");
    } finally {
      await context.dispose();
    }
  });

  test("snapshot exposes the project's records", async () => {
    const context = await harness();
    try {
      expect(await context.service.snapshot("project-1")).toEqual([]);
      await context.start({ kind: "feature", userMessage: "Let me export reports" });
      const snapshot = await context.service.snapshot("project-1");
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0]?.featureId).toBe(context.featureId);
    } finally {
      await context.dispose();
    }
  });
});
