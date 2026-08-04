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
  sendBehaviour: "ok" | "ambiguous" | "reject" = "ok";

  async createSession(
    _phase: string,
    _label: string,
    options?: ProviderCreateSessionOptions,
  ): Promise<string> {
    const id = `session-${this.created.length + 1}`;
    this.created.push(options?.clientSessionKey ?? id);
    return id;
  }

  async send(sessionId: string, prompt: string, options: ProviderSendOptions): Promise<void> {
    if (this.sendBehaviour === "ambiguous") {
      // Recorded first: an ambiguous dispatch may well have reached the agent.
      this.sends.push({ sessionId, prompt, requestId: options.requestId });
      throw new AmbiguousPromptDispatchError("The bridge did not answer");
    }
    if (this.sendBehaviour === "reject") throw new Error("Prompt rejected");
    this.sends.push({ sessionId, prompt, requestId: options.requestId });
  }

  async status(): Promise<ProviderStatus> {
    return this.statusState;
  }

  async activity(): Promise<ProviderActivityState> {
    return this.activityState;
  }

  async messages(): Promise<unknown[]> {
    return this.transcript;
  }

  async structured<T>(): Promise<null> {
    void 0 as unknown as T;
    return null;
  }

  async abort(sessionId: string): Promise<void> {
    this.aborted.push(sessionId);
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

async function harness(options: { withStory?: boolean } = {}): Promise<Harness> {
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
  const provider = new FakeProvider();
  const service = new FeaturePlanningService(
    storage,
    async <T>() => undefined as T,
    { autoAdvance: false, provider: async () => provider },
  );
  return {
    service,
    storage,
    provider,
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

  test("a parse failure keeps the reply and offers a retry from persisting", async () => {
    const context = await harness();
    try {
      await context.start({ kind: "feature", userMessage: "Let me export reports" });
      context.provider.reply("I have no idea what a state block is.");
      await context.service.advanceNow(context.featureId);
      await context.service.advanceNow(context.featureId);

      const record = await context.record();
      expect(record?.phase).toBe("failed");
      expect(record?.failure?.code).toBe("parse");
      expect(record?.failure?.retryPhase).toBe("persisting");
      // The answer itself is on the record and on the plan.
      expect(record?.rawResponse).toBe("I have no idea what a state block is.");
      const plan = await context.storage.getFeaturePlan(context.featureId);
      expect(plan?.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "I have no idea what a state block is.",
        stateApplication: "pending",
      });
      // Retrying does not append the answer a second time.
      await context.service.retry(context.featureId);
      await context.service.advanceNow(context.featureId);
      const retried = await context.storage.getFeaturePlan(context.featureId);
      expect(
        retried?.messages.filter((entry) => entry.role === "assistant"
          && entry.content === "I have no idea what a state block is.").length,
      ).toBe(1);
      expect(context.provider.sends).toHaveLength(1);
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
