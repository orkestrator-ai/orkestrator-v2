import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";
import { PromptQueueDrainer } from "./prompt-queue-drainer.js";

const ENVIRONMENT_ID = "env-1";
const TAB_ID = "tab-1";
const STATE_KEY = `env:${ENVIRONMENT_ID}:tab:${TAB_ID}`;
const QUEUE_KEY = `claude-tmux\0${STATE_KEY}`;
const DRAFT_KEY = `claude-tmux:${ENVIRONMENT_ID}:${encodeURIComponent(STATE_KEY)}`;

interface Invocation {
  command: string;
  args: Record<string, unknown>;
}

interface Harness {
  drainer: PromptQueueDrainer;
  storage: StorageService;
  calls: Invocation[];
  submits(): Invocation[];
  /** Controls what `claude_tmux_status` reports on the next read. */
  tmux: { running: boolean; busy: boolean } | null;
  fail: { start?: string; submit?: string };
  onStatus?: () => Promise<void>;
  queue(): Promise<Awaited<ReturnType<StorageService["getPromptQueue"]>>>;
  dispose(): Promise<void>;
}

async function harness(
  options: {
    environmentName?: string;
    setupScriptsComplete?: boolean;
    setupPhase?: "pending" | "running" | "ready" | "failed";
    status?: "running" | "stopped";
    containerId?: string | null;
    maxDispatchAttempts?: number;
  } = {},
): Promise<Harness> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-prompt-queue-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: ENVIRONMENT_ID,
    projectId: "project-1",
    name: options.environmentName ?? "exports",
    branch: "main",
    containerId: options.containerId ?? null,
    status: options.status ?? "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/tmux",
    setupScriptsComplete: options.setupScriptsComplete ?? true,
    ...(options.setupPhase === undefined ? {} : { setupPhase: options.setupPhase }),
  });

  const context: Harness = {
    tmux: { running: true, busy: false },
    fail: {},
    calls: [],
  } as unknown as Harness;

  const drainer = new PromptQueueDrainer(
    storage,
    async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
      context.calls.push({ command, args });
      if (command === "claude_tmux_status") {
        await context.onStatus?.();
        return context.tmux as T;
      }
      if (command === "claude_tmux_start") {
        if (context.fail.start) throw new Error(context.fail.start);
        context.tmux = { running: true, busy: false };
        return context.tmux as T;
      }
      if (command === "claude_tmux_submit_queued") {
        if (context.fail.submit) throw new Error(context.fail.submit);
        return undefined as T;
      }
      return undefined as T;
    },
    {
      ...(options.maxDispatchAttempts === undefined
        ? {}
        : { maxDispatchAttempts: options.maxDispatchAttempts }),
      // Zero backoff so a test can drive consecutive attempts without waiting.
      retryBaseMs: 0,
      retryCeilingMs: 0,
    },
  );

  context.drainer = drainer;
  context.storage = storage;
  context.submits = () =>
    context.calls.filter((call) => call.command === "claude_tmux_submit_queued");
  context.queue = () => storage.getPromptQueue(QUEUE_KEY);
  context.dispose = async () => {
    await drainer.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  };
  return context;
}

async function enqueue(
  storage: StorageService,
  messages: Array<Record<string, unknown>>,
): Promise<void> {
  await storage.savePromptQueue(QUEUE_KEY, ENVIRONMENT_ID, messages);
}

describe("PromptQueueDrainer", () => {
  test("types a queued prompt into the pane and acknowledges the claim", async () => {
    const context = await harness();
    try {
      await enqueue(context.storage, [
        { id: "m-1", text: "First queued prompt", attachments: [] },
        { id: "m-2", text: "Second queued prompt", attachments: [] },
      ]);

      await context.drainer.drainAll();

      expect(context.submits()).toHaveLength(1);
      expect(context.submits()[0]?.args).toMatchObject({
        environmentId: ENVIRONMENT_ID,
        tabId: TAB_ID,
        text: "First queued prompt",
      });
      const queue = await context.queue();
      expect(queue?.messages.map((entry) => (entry as { id: string }).id)).toEqual(["m-2"]);
      expect(queue?.inFlight).toBeUndefined();

      // The next pass takes the next head, in order.
      await context.drainer.drainAll();
      expect(context.submits()).toHaveLength(2);
      expect(context.submits()[1]?.args).toMatchObject({ text: "Second queued prompt" });
      expect((await context.queue())?.messages).toEqual([]);
    } finally {
      await context.dispose();
    }
  });

  test("reconstructs a missing tmux manager session after restart with no renderer", async () => {
    const context = await harness();
    try {
      // What a quit leaves behind: prompts queued, nothing mounted.
      await enqueue(context.storage, [
        { id: "m-1", text: "One", attachments: [] },
        { id: "m-2", text: "Two", attachments: [] },
        { id: "m-3", text: "Three", attachments: [] },
      ]);
      context.tmux = null;

      for (let pass = 0; pass < 3; pass += 1) await context.drainer.drainAll();

      expect(context.calls.some((call) => call.command === "claude_tmux_start")).toBe(true);
      expect(context.submits().map((call) => call.args.text)).toEqual(["One", "Two", "Three"]);
      expect((await context.queue())?.messages).toEqual([]);
    } finally {
      await context.dispose();
    }
  });

  test("appends staged attachments as workspace paths", async () => {
    const context = await harness();
    try {
      await enqueue(context.storage, [
        {
          id: "m-1",
          text: "Look at this",
          attachments: [{ name: "shot.png", path: "/tmp/my shots/shot.png" }],
        },
      ]);

      await context.drainer.drainAll();

      const text = context.submits()[0]?.args.text as string;
      expect(text).toContain("Look at this");
      // A host path is typed into a shell-like input, so it arrives escaped.
      expect(text).toContain("/tmp/my\\ shots/shot.png");
    } finally {
      await context.dispose();
    }
  });

  test("waits while the turn in flight is busy, without consuming an attempt", async () => {
    const context = await harness();
    try {
      await enqueue(context.storage, [{ id: "m-1", text: "Queued", attachments: [] }]);
      context.tmux = { running: true, busy: true };

      await context.drainer.drainAll();
      expect(context.submits()).toHaveLength(0);
      expect((await context.queue())?.messages).toHaveLength(1);

      context.tmux = { running: true, busy: false };
      await context.drainer.drainAll();
      expect(context.submits()).toHaveLength(1);
    } finally {
      await context.dispose();
    }
  });

  test("never types over a draft the user is still writing", async () => {
    const context = await harness();
    try {
      await enqueue(context.storage, [{ id: "m-1", text: "Queued", attachments: [] }]);
      await context.storage.saveComposeDraft(DRAFT_KEY, "environment", ENVIRONMENT_ID, {
        text: "half-written thought",
        mentions: [],
        attachments: [],
      });

      await context.drainer.drainAll();

      expect(context.submits()).toHaveLength(0);
      expect((await context.queue())?.messages).toHaveLength(1);
    } finally {
      await context.dispose();
    }
  });

  test("fails closed for malformed or unreadable durable drafts", async () => {
    const malformed = await harness();
    try {
      await enqueue(malformed.storage, [{ id: "m-1", text: "Queued", attachments: [] }]);
      await malformed.storage.saveComposeDraft(DRAFT_KEY, "environment", ENVIRONMENT_ID, {
        text: 42,
        mentions: [],
        attachments: [],
      });
      await malformed.drainer.drainAll();
      expect(malformed.submits()).toHaveLength(0);
    } finally {
      await malformed.dispose();
    }

    const unreadable = await harness();
    try {
      await enqueue(unreadable.storage, [{ id: "m-1", text: "Queued", attachments: [] }]);
      unreadable.storage.getComposeDraft = async () => {
        throw new Error("draft store unavailable");
      };
      await unreadable.drainer.drainAll();
      expect(unreadable.submits()).toHaveLength(0);
      expect((await unreadable.queue())?.messages).toHaveLength(1);
    } finally {
      await unreadable.dispose();
    }
  });

  test("backs off when autonomous tmux reconstruction fails", async () => {
    const context = await harness();
    try {
      await enqueue(context.storage, [{ id: "m-1", text: "Queued", attachments: [] }]);
      context.tmux = null;
      context.fail.start = "tmux unavailable";

      await context.drainer.drainAll();

      expect(context.submits()).toHaveLength(0);
      expect((await context.queue())?.messages).toHaveLength(1);
      expect((await context.queue())?.inFlight).toBeUndefined();
    } finally {
      await context.dispose();
    }
  });

  test("leaves the queue alone until the environment is ready for agents", async () => {
    const context = await harness({ setupScriptsComplete: false });
    try {
      await enqueue(context.storage, [{ id: "m-1", text: "Queued", attachments: [] }]);

      await context.drainer.drainAll();

      expect(context.submits()).toHaveLength(0);
      expect(context.calls.some((call) => call.command === "claude_tmux_status")).toBe(false);
      expect((await context.queue())?.messages).toHaveLength(1);
    } finally {
      await context.dispose();
    }
  });

  test("treats the authoritative ready phase as ready during legacy flag convergence", async () => {
    const context = await harness({
      setupScriptsComplete: false,
      setupPhase: "ready",
    });
    try {
      await enqueue(context.storage, [{ id: "m-1", text: "Queued", attachments: [] }]);

      await context.drainer.drainAll();

      expect(context.submits()).toHaveLength(1);
      expect((await context.queue())?.messages).toHaveLength(0);
    } finally {
      await context.dispose();
    }
  });

  test("parks an ambiguous failed submit instead of automatically typing it twice", async () => {
    const context = await harness({ maxDispatchAttempts: 10 });
    try {
      await enqueue(context.storage, [{ id: "m-1", text: "Queued", attachments: [] }]);
      context.fail.submit = "tmux send-keys failed";

      await context.drainer.drainAll();

      const afterFailure = await context.queue();
      expect(afterFailure?.inFlight).toBeUndefined();
      expect(afterFailure?.dispatchError?.message).toContain("may have partially completed");
      expect(afterFailure?.messages).toHaveLength(1);

      context.fail.submit = undefined;
      await context.drainer.drainAll();

      expect(context.submits()).toHaveLength(1);
      expect((await context.queue())?.messages).toHaveLength(1);
    } finally {
      await context.dispose();
    }
  });

  test("leaves an ambiguous submit latched until an explicit retry", async () => {
    const context = await harness({ maxDispatchAttempts: 2 });
    try {
      await enqueue(context.storage, [{ id: "m-1", text: "Queued", attachments: [] }]);
      context.fail.submit = "tmux send-keys failed";

      await context.drainer.drainAll();

      const queue = await context.queue();
      expect(queue?.dispatchError?.message).toContain("Error");
      // A latched queue is the user's to clear; the sweep must not spin on it.
      await context.drainer.drainAll();
      expect(context.submits()).toHaveLength(1);
    } finally {
      await context.dispose();
    }
  });

  test("only retries acknowledgement after a confirmed submit", async () => {
    const context = await harness();
    try {
      await enqueue(context.storage, [{ id: "m-1", text: "Queued", attachments: [] }]);
      const acknowledge = context.storage.acknowledgePromptQueueDispatch.bind(context.storage);
      let failures = 1;
      context.storage.acknowledgePromptQueueDispatch = async (...args) => {
        if (failures-- > 0) throw new Error("disk temporarily unavailable");
        return acknowledge(...args);
      };

      await context.drainer.drainAll();
      expect(context.submits()).toHaveLength(1);
      expect((await context.queue())?.inFlight?.submittedAt).toBeString();

      await context.drainer.drainAll();
      expect(context.submits()).toHaveLength(1);
      expect((await context.queue())?.inFlight).toBeUndefined();
    } finally {
      await context.dispose();
    }
  });

  test("parks a submission interrupted after its pre-submit marker", async () => {
    const context = await harness();
    try {
      await enqueue(context.storage, [{ id: "m-1", text: "Queued", attachments: [] }]);
      const reservation = await context.storage.reservePromptQueueHeadForDispatch(QUEUE_KEY);
      expect(reservation).not.toBeNull();
      await context.storage.markPromptQueueDispatchSubmitting(QUEUE_KEY, reservation!.requestId);

      await context.drainer.drainAll();

      expect(context.submits()).toHaveLength(0);
      const queue = await context.queue();
      expect(queue?.dispatchError?.message).toContain("may already have reached Claude");
      expect(queue?.messages).toHaveLength(1);
    } finally {
      await context.dispose();
    }
  });

  test("rejects a queue whose owner differs from its encoded target", async () => {
    const context = await harness();
    try {
      await enqueue(context.storage, [{ id: "m-1", text: "Wrong target", attachments: [] }]);
      const getPromptQueue = context.storage.getPromptQueue.bind(context.storage);
      context.storage.getPromptQueue = async (queueKey) => {
        const queue = await getPromptQueue(queueKey);
        return queue ? { ...queue, environmentId: "env-2" } : null;
      };

      await context.drainer.drainAll();

      expect(context.calls).toEqual([]);
      expect((await getPromptQueue(QUEUE_KEY))?.messages).toHaveLength(1);
    } finally {
      await context.dispose();
    }
  });

  test("does not submit after deletion begins during the status check", async () => {
    const context = await harness();
    try {
      await enqueue(context.storage, [{ id: "m-1", text: "Queued", attachments: [] }]);
      context.onStatus = async () => {
        await context.storage.updateEnvironment(ENVIRONMENT_ID, {
          deletionRequestedAt: new Date().toISOString(),
        });
      };

      await context.drainer.drainAll();

      expect(context.submits()).toHaveLength(0);
      expect((await context.queue())?.dispatchError?.message).toContain("target changed");
    } finally {
      await context.dispose();
    }
  });

  test("does not submit when the durable pre-submit fence loses its reservation", async () => {
    const context = await harness();
    try {
      await enqueue(context.storage, [{ id: "m-1", text: "Queued", attachments: [] }]);
      context.storage.markPromptQueueDispatchSubmitting = async () => null;

      await context.drainer.drainAll();

      expect(context.submits()).toHaveLength(0);
      expect((await context.queue())?.inFlight?.submittingAt).toBeUndefined();
    } finally {
      await context.dispose();
    }
  });

  test("renames an environment that still carries a generated name", async () => {
    const context = await harness({ environmentName: "20260804-093809" });
    try {
      await enqueue(context.storage, [{ id: "m-1", text: "Add CSV export", attachments: [] }]);

      await context.drainer.drainAll();

      const rename = context.calls.find(
        (call) => call.command === "rename_environment_from_prompt",
      );
      expect(rename?.args).toMatchObject({
        environmentId: ENVIRONMENT_ID,
        prompt: "Add CSV export",
      });
    } finally {
      await context.dispose();
    }
  });

  test("leaves an already-named environment alone", async () => {
    const context = await harness({ environmentName: "csv-export" });
    try {
      await enqueue(context.storage, [{ id: "m-1", text: "Add CSV export", attachments: [] }]);

      await context.drainer.drainAll();

      expect(context.calls.some((call) => call.command === "rename_environment_from_prompt")).toBe(
        false,
      );
      expect(context.submits()).toHaveLength(1);
    } finally {
      await context.dispose();
    }
  });

  test("ignores queues belonging to agents with their own drainer", async () => {
    const context = await harness();
    try {
      await context.storage.savePromptQueue(`codex\0env-${ENVIRONMENT_ID}:tab-1`, ENVIRONMENT_ID, [
        { id: "m-1", text: "Codex work", attachments: [] },
      ]);

      await context.drainer.drainAll();

      expect(context.calls).toEqual([]);
    } finally {
      await context.dispose();
    }
  });
});
