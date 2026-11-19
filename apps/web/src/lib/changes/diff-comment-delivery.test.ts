import { afterAll, beforeEach, describe, expect, test, type Mock } from "bun:test";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { invoke } from "@/lib/native/backend";
import { appCommandScope } from "@/lib/node-scope-slots";
import { appCommandStore } from "@/test/app-command-store";
import {
  diffCommentsStore,
  environmentDiffComments,
  type DiffCommentAnchor,
} from "@/stores/diffCommentsStore";
import type { TabInfo } from "@/types/paneLayout";
import {
  defaultDiffCommentDestination,
  diffCommentDestinations,
  selectedDiffCommentRequest,
  sendDiffComments,
  type DiffCommentDestination,
} from "./diff-comment-delivery";

type InvokeArgs = Record<string, unknown> | undefined;
const invokeMock = invoke as unknown as Mock<
  (command: string, args?: InvokeArgs) => Promise<unknown>
>;

const ENV = "env-1";
const CLAUDE: DiffCommentDestination = { tabId: "tab-1", platform: "claude", label: "Claude" };

function anchor(line: number): DiffCommentAnchor {
  return {
    source: "live",
    diffIdentityId: "diff-1",
    measurementId: "m-1",
    scope: "environment-net",
    pathId: "p:src/app.ts",
    path: "src/app.ts",
    contentKey: "blob:a|blob:b",
    kind: "line",
    side: "new",
    line,
    hunkHeader: "@@ -1,9 +1,9 @@",
    excerpt: [{ type: "add", text: `line ${line}`, oldLine: null, newLine: line }],
    excerptTruncated: false,
  };
}

function agentTab(id: string, platform: AgentPlatform | undefined, extra: Partial<TabInfo> = {}) {
  return {
    id,
    type: "agent-native",
    nativeAgentData: { environmentId: ENV, ...(platform ? { platform } : {}) },
    ...extra,
  } as TabInfo;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const store = () => appCommandStore(diffCommentsStore);
const env = () => environmentDiffComments(store().getState(), ENV);

beforeEach(() => {
  store().setState({ environments: new Map() });
  invokeMock.mockClear();
});

afterAll(() => {
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("diffCommentDestinations", () => {
  test("lists assigned agent chats, numbering repeated names", () => {
    const destinations = diffCommentDestinations([
      agentTab("a", "claude"),
      { id: "t", type: "file" } as TabInfo,
      agentTab("b", "codex", { displayTitle: "Reviewer" }),
      agentTab("c", undefined),
      agentTab("d", "claude"),
      agentTab("e", "codex", { isReviewTab: true }),
    ]);
    expect(destinations).toEqual([
      { tabId: "a", platform: "claude", label: "Claude Code 1" },
      { tabId: "b", platform: "codex", label: "Reviewer" },
      { tabId: "d", platform: "claude", label: "Claude Code 2" },
    ]);
    expect(defaultDiffCommentDestination(destinations, "d")?.tabId).toBe("d");
    expect(defaultDiffCommentDestination(destinations, "gone")?.tabId).toBe("a");
    expect(defaultDiffCommentDestination([], null)).toBeNull();
  });
});

describe("sendDiffComments", () => {
  test("queues the selected comments as one prompt on the chosen tab", async () => {
    const enqueued: InvokeArgs[] = [];
    invokeMock.mockImplementation(async (command, args) => {
      if (command !== "enqueue_prompt_queue_message") throw new Error(`Unexpected ${command}`);
      enqueued.push(args);
      return { queueKey: args?.queueKey, environmentId: ENV, messages: [] };
    });
    for (const line of [1, 2, 3, 4, 5]) {
      store().getState().addComment(ENV, anchor(line), `fix ${line}`);
    }
    const skipped = env().comments[4]!.id;
    store().getState().setSelected(ENV, skipped, false);
    const expectedText = selectedDiffCommentRequest(appCommandScope(), ENV);

    const result = await sendDiffComments(appCommandScope(), ENV, CLAUDE);

    expect(result).toEqual({ kind: "sent", sent: 4, kept: 0 });
    expect(enqueued).toHaveLength(1);
    const [args] = enqueued;
    expect(args?.queueKey).toBe(`claude\u0000env-${ENV}:tab-1`);
    expect(args?.environmentId).toBe(ENV);
    const message = args?.message as Record<string, unknown>;
    expect(message.id).toMatch(/^diff-comments:/);
    expect(message.requestId).toBe(message.id);
    expect(message.preserveSessionMode).toBe(true);
    expect(message.text).toBe(expectedText);
    expect(message.text as string).toContain("(4 comments)");
    expect(message.text as string).not.toContain("fix 5");
    // Only the unselected comment remains.
    expect(env().comments.map((comment) => comment.id)).toEqual([skipped]);
  });

  test("keeps comments added or edited while the send is in flight", async () => {
    const write = deferred<unknown>();
    invokeMock.mockImplementation(() => write.promise);
    for (const line of [1, 2, 3, 4, 5]) {
      store().getState().addComment(ENV, anchor(line), `fix ${line}`);
    }
    const edited = env().comments[1]!.id;

    const sending = sendDiffComments(appCommandScope(), ENV, CLAUDE);
    expect(env().sending?.items).toHaveLength(5);
    // A second send cannot start while this one is in flight.
    expect(await sendDiffComments(appCommandScope(), ENV, CLAUDE)).toEqual({ kind: "busy" });

    store().getState().editComment(ENV, edited, "fix 2, but differently");
    const added = store().getState().addComment(ENV, anchor(9), "fix 9")!;
    write.resolve({ messages: [] });

    expect(await sending).toEqual({ kind: "sent", sent: 4, kept: 1 });
    expect(env().comments.map((comment) => [comment.id, comment.body])).toEqual([
      [edited, "fix 2, but differently"],
      [added, "fix 9"],
    ]);
    expect(env().sending).toBeNull();
  });

  test("keeps every comment when the queue refuses the prompt, and retries under the same id", async () => {
    const ids: unknown[] = [];
    invokeMock.mockImplementation(async (_command, args) => {
      ids.push((args!.message as Record<string, unknown>).id);
      throw new Error("Environment is stopped");
    });
    store().getState().addComment(ENV, anchor(1), "fix 1");
    store().getState().addComment(ENV, anchor(2), "fix 2");

    expect(await sendDiffComments(appCommandScope(), ENV, CLAUDE)).toEqual({
      kind: "failed",
      message: "Environment is stopped",
    });
    expect(env().comments).toHaveLength(2);
    expect(env().lastError).toBe("Environment is stopped");

    invokeMock.mockImplementation(async (_command, args) => {
      ids.push((args!.message as Record<string, unknown>).id);
      return { messages: [] };
    });
    expect(await sendDiffComments(appCommandScope(), ENV, CLAUDE)).toEqual({
      kind: "sent",
      sent: 2,
      kept: 0,
    });
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(env().lastError).toBeNull();
  });

  test("sends nothing when no comment is selected", async () => {
    store().getState().addComment(ENV, anchor(1), "fix 1");
    store().getState().setAllSelected(ENV, false);
    expect(await sendDiffComments(appCommandScope(), ENV, CLAUDE)).toEqual({ kind: "empty" });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
