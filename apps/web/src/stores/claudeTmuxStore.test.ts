import { beforeEach, describe, expect, test } from "bun:test";
import type { TranscriptContent, TranscriptLine } from "@/lib/claude-tmux-client";
import { ERROR_MESSAGE_PREFIX, type ClaudeMessage } from "@/lib/claude-client";
import {
  createClaudeTmuxStateKey,
  getEnvironmentIdFromClaudeTmuxStateKey,
  migrateLegacyClaudeTmuxState,
  compactConsecutiveAssistantMessages,
  payloadToApproval,
  payloadToElicitation,
  payloadToInfoEvent,
  payloadToPermission,
  payloadToPlan,
  payloadToQuestion,
  useClaudeTmuxStore,
} from "./claudeTmuxStore";
import {
  tmuxElicitationDraftKey,
  tmuxPlanDraftKey,
  tmuxQuestionDraftKey,
  usePromptDraftStore,
} from "./promptDraftStore";
import { seedQueuedPrompt } from "@/stores/testing/queue-projection";

function reset() {
  useClaudeTmuxStore.setState({
    tabs: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
    effortLevels: new Map(),
  });
  usePromptDraftStore.getState().reset();
}

beforeEach(() => {
  reset();
});

describe("state keys", () => {
  test("creates and parses environment-scoped tmux state keys", () => {
    const key = createClaudeTmuxStateKey("env-1", "tab-a");

    expect(key).toBe("env:env-1:tab:tab-a");
    expect(getEnvironmentIdFromClaudeTmuxStateKey(key)).toBe("env-1");
    expect(getEnvironmentIdFromClaudeTmuxStateKey("tab-a")).toBeNull();
    expect(getEnvironmentIdFromClaudeTmuxStateKey("env::tab:tab-a")).toBeNull();
    expect(getEnvironmentIdFromClaudeTmuxStateKey("env:env-1")).toBeNull();
  });

  test("atomically migrates matching legacy tab and compose state to a scoped key", () => {
    const store = useClaudeTmuxStore.getState();
    const scopedKey = createClaudeTmuxStateKey("env-1", "tab-a");
    store.setRunning("tab-a", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.setDraftText("tab-a", "legacy draft");
    store.setDraftMentions("tab-a", [
      { id: "mention-1", filename: "a.ts", relativePath: "src/a.ts" },
    ]);
    store.addAttachment("tab-a", {
      id: "attachment-1",
      type: "image",
      path: "/workspace/a.png",
      previewUrl: "data:image/png;base64,a",
      name: "a.png",
    });
    seedQueuedPrompt(store, "tab-a", {
      id: "queue-1",
      text: "legacy queue",
      attachments: [],
    });
    store.setEffortLevel("tab-a", "xhigh");

    expect(migrateLegacyClaudeTmuxState("tab-a", scopedKey, "env-1")).toBe(true);

    const migrated = useClaudeTmuxStore.getState();
    expect(migrated.tabs.has("tab-a")).toBe(false);
    expect(migrated.getTab(scopedKey)).toMatchObject({
      running: true,
      environmentId: "env-1",
      sessionId: "session-1",
    });
    expect(migrated.getDraftText(scopedKey)).toBe("legacy draft");
    expect(migrated.getDraftMentions(scopedKey)).toEqual([
      { id: "mention-1", filename: "a.ts", relativePath: "src/a.ts" },
    ]);
    expect(migrated.getAttachments(scopedKey).map((item) => item.id)).toEqual(["attachment-1"]);
    expect(migrated.getQueuedMessages(scopedKey).map((item) => item.id)).toEqual(["queue-1"]);
    expect(migrated.effortLevels.get(scopedKey)).toBe("xhigh");
    expect(migrated.draftText.has("tab-a")).toBe(false);
    expect(migrated.draftMentions.has("tab-a")).toBe(false);
    expect(migrated.attachments.has("tab-a")).toBe(false);
    expect(migrated.messageQueue.has("tab-a")).toBe(false);
    expect(migrated.effortLevels.has("tab-a")).toBe(false);
  });

  test("does not migrate legacy state owned by another environment", () => {
    const store = useClaudeTmuxStore.getState();
    const scopedKey = createClaudeTmuxStateKey("env-2", "tab-a");
    store.setRunning("tab-a", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.setDraftText("tab-a", "do not move");

    expect(migrateLegacyClaudeTmuxState("tab-a", scopedKey, "env-2")).toBe(false);
    expect(useClaudeTmuxStore.getState().tabs.has(scopedKey)).toBe(false);
    expect(useClaudeTmuxStore.getState().getDraftText("tab-a")).toBe("do not move");
  });

  test("keeps newer scoped values while removing duplicate legacy values", () => {
    const store = useClaudeTmuxStore.getState();
    const scopedKey = createClaudeTmuxStateKey("env-1", "tab-a");
    store.setRunning("tab-a", true, {
      environmentId: "env-1",
      sessionId: "legacy-session",
    });
    store.setDraftText("tab-a", "legacy draft");
    store.setRunning(scopedKey, true, {
      environmentId: "env-1",
      sessionId: "scoped-session",
    });
    store.setDraftText(scopedKey, "new scoped draft");

    expect(migrateLegacyClaudeTmuxState("tab-a", scopedKey, "env-1")).toBe(true);

    const migrated = useClaudeTmuxStore.getState();
    expect(migrated.tabs.has("tab-a")).toBe(false);
    expect(migrated.getTab(scopedKey).sessionId).toBe("scoped-session");
    expect(migrated.getDraftText(scopedKey)).toBe("new scoped draft");
    expect(migrated.draftText.has("tab-a")).toBe(false);
  });

  test("reports no migration when there is nothing to move", () => {
    const scopedKey = createClaudeTmuxStateKey("env-1", "tab-a");

    // Already scoped: source and destination are the same key.
    expect(migrateLegacyClaudeTmuxState(scopedKey, scopedKey, "env-1")).toBe(false);
    // Nothing was ever stored under the bare id.
    expect(migrateLegacyClaudeTmuxState("tab-a", scopedKey, "env-1")).toBe(false);
    expect(useClaudeTmuxStore.getState().tabs.has(scopedKey)).toBe(false);
  });

  test("resolves a bare tab id onto its one scoped tab for every compose accessor", () => {
    /**
     * Components that have not been migrated yet still address their state by
     * bare tab id. Writing that through as its own key would split a tab's
     * draft and queue across two entries, one of which nothing reads.
     */
    const scopedKey = createClaudeTmuxStateKey("env-1", "tab-a");
    const store = useClaudeTmuxStore.getState();
    store.setRunning(scopedKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });

    store.setDraftText("tab-a", "bare draft");
    store.setDraftMentions("tab-a", [
      { id: "mention-1", filename: "a.ts", relativePath: "src/a.ts" },
    ]);
    store.addAttachment("tab-a", {
      id: "attachment-1",
      type: "image",
      path: "/workspace/a.png",
      previewUrl: "data:image/png;base64,a",
      name: "a.png",
    });
    store.setEffortLevel("tab-a", "xhigh");
    seedQueuedPrompt(store, "tab-a", {
      id: "queue-1",
      text: "bare queue",
      attachments: [],
    });

    const state = useClaudeTmuxStore.getState();
    expect(state.draftText.has("tab-a")).toBe(false);
    expect(state.messageQueue.has("tab-a")).toBe(false);
    expect(state.getDraftText(scopedKey)).toBe("bare draft");
    expect(state.getDraftMentions(scopedKey)).toHaveLength(1);
    expect(state.getAttachments(scopedKey).map((item) => item.id)).toEqual(["attachment-1"]);
    expect(state.effortLevels.get(scopedKey)).toBe("xhigh");
    expect(state.getQueuedMessages(scopedKey).map((item) => item.id)).toEqual(["queue-1"]);

    // The bare id reads back through the same resolution.
    expect(state.getDraftText("tab-a")).toBe("bare draft");
    expect(state.getQueueLength("tab-a")).toBe(1);
    expect(state.getAttachments("tab-a").map((item) => item.id)).toEqual(["attachment-1"]);
  });

  test("keeps an ambiguous bare tab id on its own key rather than guessing", () => {
    /**
     * The same tab id can exist under two environments. Picking either one
     * would put a prompt into the wrong environment's queue, so an ambiguous
     * id stays unresolved.
     */
    const store = useClaudeTmuxStore.getState();
    const keyA = createClaudeTmuxStateKey("env-1", "tab-a");
    const keyB = createClaudeTmuxStateKey("env-2", "tab-a");
    store.setRunning(keyA, true, { environmentId: "env-1", sessionId: "a" });
    store.setRunning(keyB, true, { environmentId: "env-2", sessionId: "b" });

    store.setDraftText("tab-a", "ambiguous");
    seedQueuedPrompt(store, "tab-a", {
      id: "queue-1",
      text: "ambiguous queue",
      attachments: [],
    });

    const state = useClaudeTmuxStore.getState();
    expect(state.draftText.get("tab-a")).toBe("ambiguous");
    expect(state.getDraftText(keyA)).toBe("");
    expect(state.getDraftText(keyB)).toBe("");
    expect(state.getQueueLength(keyA)).toBe(0);
    expect(state.getQueueLength(keyB)).toBe(0);
  });
});

describe("applyTranscriptLine", () => {
  test("preserves the model Claude Code recorded on an assistant transcript line", () => {
    useClaudeTmuxStore.getState().applyTranscriptLine("e", {
      type: "assistant",
      uuid: "assistant-model",
      message: {
        role: "assistant",
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "Done" }],
      },
    });

    expect(useClaudeTmuxStore.getState().getTab("e").messages[0]?.modelId).toBe("claude-opus-4-6");
  });

  test("rejects synthetic, subagent, sidechain, and blank model attribution", () => {
    const store = useClaudeTmuxStore.getState();
    store.applyTranscriptLine("e", {
      type: "assistant",
      uuid: "synthetic",
      message: {
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: "Generated" }],
      },
    });
    store.applyTranscriptLine("e", {
      type: "assistant",
      uuid: "subagent",
      parent_tool_use_id: "tool-1",
      message: {
        role: "assistant",
        model: "claude-subagent",
        content: [{ type: "text", text: "Subagent" }],
      },
    });
    store.applyTranscriptLine("e", {
      type: "assistant",
      uuid: "sidechain",
      isSidechain: true,
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        model: "claude-sidechain",
        content: [{ type: "text", text: "Sidechain" }],
      },
    });
    store.applyTranscriptLine("e", {
      type: "assistant",
      uuid: "blank",
      message: {
        role: "assistant",
        model: "   ",
        content: [{ type: "text", text: "Blank" }],
      },
    });

    expect(store.getTab("e").messages.map((message) => message.modelId)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("adopts model attribution from a later line with the same uuid", () => {
    const store = useClaudeTmuxStore.getState();
    store.applyTranscriptLine("e", {
      type: "assistant",
      uuid: "assistant-repeat",
      message: { role: "assistant", content: [{ type: "text", text: "Partial" }] },
    });
    store.applyTranscriptLine("e", {
      type: "assistant",
      uuid: "assistant-repeat",
      message: {
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "Final" }],
      },
    });

    expect(store.getTab("e").messages[0]?.modelId).toBe("claude-opus-5");
  });

  test("user text line becomes a message", () => {
    const line: TranscriptLine = {
      type: "user",
      uuid: "u1",
      createdAt: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "hello" },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("env-1", line);
    const env = useClaudeTmuxStore.getState().getTab("env-1");
    expect(env.messages).toHaveLength(1);
    expect(env.messages[0]!.content).toBe("hello");
    expect(env.messages[0]!.role).toBe("user");
    expect(env.messages[0]!.id).toBe("u1");
    expect(env.messages[0]!.parts.find((p) => p.type === "text")?.content).toBe("hello");
  });

  test("replaceTranscript removes stale messages without clearing local drafts", () => {
    const store = useClaudeTmuxStore.getState();
    store.applyTranscriptLine("e", {
      type: "assistant",
      uuid: "stale",
      message: { role: "assistant", content: "stale copy" },
    });
    store.setDraftText("e", "keep my draft");

    store.replaceTranscript("e", [
      {
        type: "assistant",
        uuid: "server",
        message: { role: "assistant", content: "server copy" },
      },
    ]);

    expect(useClaudeTmuxStore.getState().getTab("e").messages).toMatchObject([
      { id: "server", content: "server copy" },
    ]);
    expect(useClaudeTmuxStore.getState().getDraftText("e")).toBe("keep my draft");
  });

  test("replaceTranscript accepts an authoritative empty snapshot", () => {
    const store = useClaudeTmuxStore.getState();
    store.applyTranscriptLine("e", {
      type: "assistant",
      uuid: "stale",
      message: { role: "assistant", content: "stale copy" },
    });

    store.replaceTranscript("e", []);

    expect(useClaudeTmuxStore.getState().getTab("e").messages).toEqual([]);
  });

  test("assistant tool_use + later tool_result merge into prior assistant message", () => {
    const useLine: TranscriptLine = {
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "thinking…" },
          { type: "tool_use", id: "tu1", name: "Bash", input: { cmd: "ls" } },
        ],
      },
    };
    const resultLine: TranscriptLine = {
      type: "user",
      uuid: "result-line-uuid",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu1",
            content: "ok\n",
            is_error: false,
          },
        ],
      },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", useLine);
    useClaudeTmuxStore.getState().applyTranscriptLine("e", resultLine);
    const env = useClaudeTmuxStore.getState().getTab("e");
    // Crucial: the tool_result-only "user" line should NOT create a second
    // message; it merges into the prior assistant message's parts.
    expect(env.messages).toHaveLength(1);
    const parts = env.messages[0]!.parts;
    const invocation = parts.find((p) => p.type === "tool-invocation" && p.toolUseId === "tu1");
    const result = parts.find((p) => p.type === "tool-result" && p.toolUseId === "tu1");
    expect(invocation).toBeTruthy();
    expect(invocation!.toolState).toBe("success");
    expect(result).toBeTruthy();
    expect(result!.toolOutput).toBe("ok\n");
  });

  describe("settle stamps on merged tool results", () => {
    /*
     * A tool that launched a long-running child settles where the record says
     * it did, and that stamp is the transcript position its card holds once it
     * stops. It has to come off the record: a clock read during replay would
     * put the card somewhere different after every reload, and somewhere
     * different again in a second tab.
     */
    const launch: TranscriptLine = {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-08-17T10:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu1", name: "Task", input: {} }],
      },
    };
    const resultLine = (timestamp?: unknown): TranscriptLine =>
      ({
        type: "user",
        uuid: "r1",
        ...(timestamp === undefined ? {} : { timestamp }),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu1", content: "done" }],
        },
      }) as TranscriptLine;

    const settleOf = (line: TranscriptLine) => {
      useClaudeTmuxStore.getState().applyTranscriptLine("e", launch);
      useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
      const parts = useClaudeTmuxStore.getState().getTab("e").messages[0]!.parts;
      const invocation = parts.find((p) => p.type === "tool-invocation" && p.toolUseId === "tu1");
      expect(invocation!.toolState).toBe("success");
      return invocation!.settledAt;
    };

    test("stamps the card from the record's own clock", () => {
      expect(settleOf(resultLine("2026-08-17T10:04:30.000Z"))).toBe("2026-08-17T10:04:30.000Z");
    });

    test.each([
      ["no timestamp at all", undefined],
      ["an unparseable timestamp", "not-a-date"],
      ["a non-string timestamp", 1_755_000_000_000],
    ])("leaves the card unstamped for a record with %s", (_label, timestamp) => {
      /*
       * The regression this guards: the message clock falls back to
       * `new Date()` so a bubble always has something to render, and reusing
       * that for the settle position stamped the card with the replay time —
       * dropping it at the bottom of the transcript, differently every reload.
       */
      expect(settleOf(resultLine(timestamp))).toBeUndefined();
    });

    test("keeps the first stamp when a later record repeats the result", () => {
      useClaudeTmuxStore.getState().applyTranscriptLine("e", launch);
      useClaudeTmuxStore
        .getState()
        .applyTranscriptLine("e", resultLine("2026-08-17T10:04:30.000Z"));
      useClaudeTmuxStore.getState().applyTranscriptLine("e", {
        ...resultLine("2026-08-17T11:00:00.000Z"),
        uuid: "r2",
      });

      const parts = useClaudeTmuxStore.getState().getTab("e").messages[0]!.parts;
      // A tool settles once. Restamping would move a card the reader has
      // already found in its place.
      expect(parts.find((p) => p.type === "tool-invocation")?.settledAt).toBe(
        "2026-08-17T10:04:30.000Z",
      );
    });
  });

  test("lands the backend's task snapshot on the tool invocation", () => {
    // tmux mode does not derive the task list; the backend that reads the
    // transcript stamps it on the result line, and it has to survive the merge
    // onto the invocation, which is what TodoToolPart renders.
    const useLine: TranscriptLine = {
      type: "assistant",
      uuid: "task-a1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "task-tu1",
            name: "TaskUpdate",
            input: { taskId: "2", status: "in_progress" },
          },
        ],
      },
    };
    const snapshot = {
      items: [
        { id: "1", subject: "First", status: "completed" as const },
        { id: "2", subject: "Second", status: "in_progress" as const },
      ],
      complete: true,
      changedTaskId: "2",
    };
    const resultLine: TranscriptLine = {
      type: "user",
      uuid: "task-result-uuid",
      taskSnapshots: { "task-tu1": snapshot },
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "task-tu1", content: "Updated task #2 status" },
        ],
      },
    };

    useClaudeTmuxStore.getState().applyTranscriptLine("e", useLine);
    useClaudeTmuxStore.getState().applyTranscriptLine("e", resultLine);

    const parts = useClaudeTmuxStore.getState().getTab("e").messages[0]!.parts;
    const invocation = parts.find(
      (p) => p.type === "tool-invocation" && p.toolUseId === "task-tu1",
    );
    expect(invocation?.taskSnapshot).toEqual(snapshot);
  });

  test("gives a co-located non-task result no task snapshot", () => {
    // One user line can close several tools at once. Only the task tool's own
    // result carries a list.
    const useLine: TranscriptLine = {
      type: "assistant",
      uuid: "mixed-a1",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "mixed-task", name: "TaskCreate", input: { subject: "Task" } },
          { type: "tool_use", id: "mixed-bash", name: "Bash", input: { cmd: "ls" } },
        ],
      },
    };
    const snapshot = {
      items: [{ id: "1", subject: "Task", status: "pending" as const }],
      complete: true,
      changedTaskId: "1",
    };
    const resultLine: TranscriptLine = {
      type: "user",
      uuid: "mixed-result",
      taskSnapshots: { "mixed-task": snapshot },
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "mixed-task",
            content: "Task #1 created successfully: Task",
          },
          { type: "tool_result", tool_use_id: "mixed-bash", content: "file-a" },
        ],
      },
    };

    useClaudeTmuxStore.getState().applyTranscriptLine("e", useLine);
    useClaudeTmuxStore.getState().applyTranscriptLine("e", resultLine);

    const parts = useClaudeTmuxStore.getState().getTab("e").messages[0]!.parts;
    const byId = (id: string) =>
      parts.find((p) => p.type === "tool-invocation" && p.toolUseId === id);

    expect(byId("mixed-task")?.taskSnapshot).toEqual(snapshot);
    expect(byId("mixed-bash")?.taskSnapshot).toBeUndefined();
  });

  test("leaves the task snapshot absent on ordinary tool results", () => {
    const useLine: TranscriptLine = {
      type: "assistant",
      uuid: "plain-a1",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "plain-tu1", name: "Bash", input: { cmd: "ls" } }],
      },
    };
    const resultLine: TranscriptLine = {
      type: "user",
      uuid: "plain-result-uuid",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "plain-tu1", content: "ok" }],
      },
    };

    useClaudeTmuxStore.getState().applyTranscriptLine("e", useLine);
    useClaudeTmuxStore.getState().applyTranscriptLine("e", resultLine);

    const parts = useClaudeTmuxStore.getState().getTab("e").messages[0]!.parts;
    expect(parts.find((p) => p.type === "tool-invocation")?.taskSnapshot).toBeUndefined();
  });

  test("ignores non-message line types", () => {
    useClaudeTmuxStore.getState().applyTranscriptLine("e", {
      type: "summary",
    } as unknown as TranscriptLine);
    expect(useClaudeTmuxStore.getState().getTab("e").messages).toHaveLength(0);
  });

  test("re-applying the same line is idempotent (dedup by uuid)", () => {
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "u-stable",
      message: { role: "assistant", content: "hi" },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    expect(useClaudeTmuxStore.getState().getTab("e").messages).toHaveLength(1);
  });

  test("falls back to a stable hash when uuid and timestamp are absent", () => {
    const line: TranscriptLine = {
      type: "system",
      message: { role: "system", content: "boot" },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    // Two applications of an identical line MUST dedupe.
    expect(useClaudeTmuxStore.getState().getTab("e").messages).toHaveLength(1);
  });

  test("drops user messages that only contain slash-command meta wrappers", () => {
    // When the user runs `/model` from the Claude CLI, the transcript gains
    // synthetic user-role lines containing only command-meta tags. These
    // should never appear as chat bubbles.
    const caveat: TranscriptLine = {
      type: "user",
      uuid: "caveat-1",
      message: {
        role: "user",
        content:
          "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond.</local-command-caveat>",
      },
    };
    const cmdMeta: TranscriptLine = {
      type: "user",
      uuid: "cmd-meta-1",
      message: {
        role: "user",
        content:
          "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>",
      },
    };
    const stdout: TranscriptLine = {
      type: "user",
      uuid: "stdout-1",
      message: {
        role: "user",
        content: "<local-command-stdout>Set model to [1mSonnet 4.6[22m</local-command-stdout>",
      },
    };
    const store = useClaudeTmuxStore.getState();
    store.applyTranscriptLine("e", caveat);
    store.applyTranscriptLine("e", cmdMeta);
    store.applyTranscriptLine("e", stdout);
    expect(useClaudeTmuxStore.getState().getTab("e").messages).toHaveLength(0);
  });

  test("preserves user text that surrounds command-meta wrappers", () => {
    const line: TranscriptLine = {
      type: "user",
      uuid: "mixed-1",
      message: {
        role: "user",
        content: "Please run this:\n<command-name>/help</command-name>\nand let me know.",
      },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const msg = useClaudeTmuxStore.getState().getTab("e").messages[0];
    expect(msg).toBeTruthy();
    expect(msg!.content).toBe("Please run this:\n\nand let me know.");
  });

  test("strips embedded ANSI escapes from user text", () => {
    const line: TranscriptLine = {
      type: "user",
      uuid: "ansi-1",
      message: {
        role: "user",
        content: "model is [1mSonnet 4.6[22m now",
      },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const msg = useClaudeTmuxStore.getState().getTab("e").messages[0]!;
    expect(msg.content).toBe("model is Sonnet 4.6 now");
  });

  test("Edit tool_use populates toolDiff with file_path and before/after", () => {
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "edit-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-edit",
            name: "Edit",
            input: {
              file_path: "/work/apps/web/package.json",
              old_string: '"react": "18.0.0"',
              new_string: '"react": "19.0.0"',
            },
          },
        ],
      },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const msg = useClaudeTmuxStore.getState().getTab("e").messages[0]!;
    const tool = msg.parts.find((p) => p.type === "tool-invocation");
    expect(tool?.toolDiff?.filePath).toBe("/work/apps/web/package.json");
    expect(tool?.toolDiff?.before).toBe('"react": "18.0.0"');
    expect(tool?.toolDiff?.after).toBe('"react": "19.0.0"');
    expect(tool?.toolDiff?.additions).toBe(1);
    expect(tool?.toolDiff?.deletions).toBe(1);
  });

  test("Write tool_use populates toolDiff with after = content", () => {
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "write-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-write",
            name: "Write",
            input: { file_path: "/work/foo.txt", content: "line1\nline2" },
          },
        ],
      },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const msg = useClaudeTmuxStore.getState().getTab("e").messages[0]!;
    const tool = msg.parts.find((p) => p.type === "tool-invocation");
    expect(tool?.toolDiff?.filePath).toBe("/work/foo.txt");
    expect(tool?.toolDiff?.before).toBe("");
    expect(tool?.toolDiff?.after).toBe("line1\nline2");
    expect(tool?.toolDiff?.additions).toBe(2);
    expect(tool?.toolDiff?.deletions).toBe(0);
  });

  test("MultiEdit tool_use populates synthetic before/after chunks", () => {
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "multi-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-multi",
            name: "MultiEdit",
            input: {
              file_path: "/work/foo.ts",
              edits: [
                { old_string: "one", new_string: "two" },
                { old_string: "three", new_string: "four" },
              ],
            },
          },
        ],
      },
    };

    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const tool = useClaudeTmuxStore
      .getState()
      .getTab("e")
      .messages[0]!.parts.find((p) => p.type === "tool-invocation");
    expect(tool?.toolDiff?.filePath).toBe("/work/foo.ts");
    expect(tool?.toolDiff?.before).toBe("one\nthree");
    expect(tool?.toolDiff?.after).toBe("two\nfour");
    expect(tool?.toolDiff?.additions).toBe(2);
    expect(tool?.toolDiff?.deletions).toBe(2);
  });

  test("MultiEdit chunks that already end in a newline gain no blank line", () => {
    // Joining unconditionally with "\n" would render a line the file never had
    // and count it, so two deletions would be badged as three.
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "multi-nl",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-multi-nl",
            name: "MultiEdit",
            input: {
              file_path: "/work/foo.ts",
              edits: [
                { old_string: "one\n", new_string: "two\n" },
                { old_string: "three", new_string: "four" },
              ],
            },
          },
        ],
      },
    };

    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const tool = useClaudeTmuxStore
      .getState()
      .getTab("e")
      .messages[0]!.parts.find((p) => p.type === "tool-invocation");
    expect(tool?.toolDiff?.before).toBe("one\nthree");
    expect(tool?.toolDiff?.after).toBe("two\nfour");
    expect(tool?.toolDiff?.additions).toBe(2);
    expect(tool?.toolDiff?.deletions).toBe(2);
  });

  test("NotebookEdit tool_use captures notebook path and new source", () => {
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "notebook-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-notebook",
            name: "NotebookEdit",
            input: {
              notebook_path: "/work/analysis.ipynb",
              new_source: "print('done')",
            },
          },
        ],
      },
    };

    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const tool = useClaudeTmuxStore
      .getState()
      .getTab("e")
      .messages[0]!.parts.find((p) => p.type === "tool-invocation");
    expect(tool?.toolDiff?.filePath).toBe("/work/analysis.ipynb");
    expect(tool?.toolDiff?.after).toBe("print('done')");
    expect(tool?.toolDiff?.additions).toBe(1);
    expect(tool?.toolDiff?.deletions).toBe(0);
  });

  test("delete-mode NotebookEdit keeps the path but claims no line counts", () => {
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "notebook-del",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-notebook-del",
            name: "NotebookEdit",
            input: {
              notebook_path: "/work/analysis.ipynb",
              edit_mode: "delete",
            },
          },
        ],
      },
    };

    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const tool = useClaudeTmuxStore
      .getState()
      .getTab("e")
      .messages[0]!.parts.find((p) => p.type === "tool-invocation");
    expect(tool?.toolDiff?.filePath).toBe("/work/analysis.ipynb");
    expect(tool?.toolDiff?.additions).toBeUndefined();
    expect(tool?.toolDiff?.deletions).toBeUndefined();
  });

  test("an unmapped tool still surfaces the file path it touched", () => {
    useClaudeTmuxStore.getState().applyTranscriptLine("e", {
      type: "assistant",
      uuid: "read-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-read",
            name: "Read",
            input: { file_path: "/work/foo.ts" },
          },
        ],
      },
    });
    const tool = useClaudeTmuxStore
      .getState()
      .getTab("e")
      .messages[0]!.parts.find((p) => p.type === "tool-invocation");
    expect(tool?.toolDiff).toEqual({ filePath: "/work/foo.ts" });
  });

  test("failed tool_result marks invocation failure and stores error text", () => {
    useClaudeTmuxStore.getState().applyTranscriptLine("e", {
      type: "assistant",
      uuid: "a-fail",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu-fail", name: "Bash", input: {} }],
      },
    });
    useClaudeTmuxStore.getState().applyTranscriptLine("e", {
      type: "user",
      uuid: "r-fail",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-fail",
            content: "permission denied",
            is_error: true,
          },
        ],
      },
    });

    const parts = useClaudeTmuxStore.getState().getTab("e").messages[0]!.parts;
    const invocation = parts.find((p) => p.type === "tool-invocation");
    const result = parts.find((p) => p.type === "tool-result");
    expect(invocation?.toolState).toBe("failure");
    expect(invocation?.toolError).toBe("permission denied");
    expect(result?.toolError).toBe("permission denied");
  });

  test("unmatched tool_result falls back to a standalone user message", () => {
    useClaudeTmuxStore.getState().applyTranscriptLine("e", {
      type: "user",
      uuid: "r-orphan",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "missing",
            content: "orphaned",
          },
        ],
      },
    });

    const env = useClaudeTmuxStore.getState().getTab("e");
    expect(env.messages).toHaveLength(1);
    expect(env.messages[0]!.role).toBe("user");
    expect(env.messages[0]!.parts[0]?.type).toBe("tool-result");
  });

  test("array content collects text, thinking, and tool_use", () => {
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "a2",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me see" },
          { type: "text", text: "result" },
          { type: "tool_use", id: "tu2", name: "Read", input: { path: "f" } },
        ],
      },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const msg = useClaudeTmuxStore.getState().getTab("e").messages[0]!;
    const thinking = msg.parts.find((p) => p.type === "thinking");
    const text = msg.parts.find((p) => p.type === "text");
    const tool = msg.parts.find((p) => p.type === "tool-invocation");
    expect(thinking?.content).toContain("let me see");
    expect(text?.content).toContain("result");
    expect(tool?.toolName).toBe("Read");
  });

  test("drops redacted thinking blocks that carry a signature but no text", () => {
    // What the CLI writes when thinking display is "omitted" — the reasoning is
    // sealed in the signature, so there is nothing to render. The tmux launcher
    // asks for "summarized" precisely so this shape does not reach the UI.
    const redacted: TranscriptContent = {
      type: "thinking",
      thinking: "",
      signature: "EqQBCkYIBxgC",
    };
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "a3",
      message: {
        role: "assistant",
        content: [redacted, { type: "text", text: "answer" }],
      },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const msg = useClaudeTmuxStore.getState().getTab("e").messages[0]!;
    expect(msg.parts.map((p) => p.type)).toEqual(["text"]);
  });

  test("keeps a summarized thinking block that carries both text and a signature", () => {
    // The shape `--thinking-display summarized` produces, and the reason the
    // launcher asks for it: the signature rides along, but so does the summary.
    const summarized: TranscriptContent = {
      type: "thinking",
      thinking: "weighing two options",
      signature: "EqQBCkYIBxgC",
    };
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "a4",
      message: {
        role: "assistant",
        content: [summarized, { type: "text", text: "answer" }],
      },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const msg = useClaudeTmuxStore.getState().getTab("e").messages[0]!;
    expect(msg.parts.map((p) => p.type)).toEqual(["thinking", "text"]);
    expect(msg.parts[0]?.content).toBe("weighing two options");
  });
});

describe("compactConsecutiveAssistantMessages", () => {
  test("combines adjacent assistant transcript messages for native-style spacing", () => {
    const messages: ClaudeMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "inspect",
        createdAt: "2026-01-01T00:00:00Z",
        parts: [{ type: "text", content: "inspect" }],
      },
      {
        id: "a1",
        role: "assistant",
        content: "",
        createdAt: "2026-01-01T00:00:01Z",
        parts: [
          {
            type: "tool-invocation",
            content: "",
            toolName: "Read",
            toolUseId: "tu1",
            toolState: "success",
          },
        ],
      },
      {
        id: "a2",
        role: "assistant",
        content: "",
        createdAt: "2026-01-01T00:00:02Z",
        parts: [
          {
            type: "tool-invocation",
            content: "",
            toolName: "Grep",
            toolUseId: "tu2",
            toolState: "success",
          },
        ],
      },
      {
        id: "a3",
        role: "assistant",
        content: "done",
        createdAt: "2026-01-01T00:00:03Z",
        parts: [{ type: "text", content: "done" }],
      },
    ];

    const compacted = compactConsecutiveAssistantMessages(messages);

    expect(compacted).toHaveLength(2);
    expect(compacted[1]!.id).toBe("a1");
    expect(compacted[1]!.createdAt).toBe("2026-01-01T00:00:01Z");
    expect(compacted[1]!.content).toBe("done");
    expect(compacted[1]!.parts.map((part) => part.type)).toEqual([
      "tool-invocation",
      "tool-invocation",
      "text",
    ]);
  });

  test("uses the latest model attribution in a compacted assistant run", () => {
    const messages: ClaudeMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "partial",
        createdAt: "2026-01-01T00:00:01Z",
        parts: [{ type: "text", content: "partial" }],
      },
      {
        id: "a2",
        role: "assistant",
        content: "final",
        createdAt: "2026-01-01T00:00:02Z",
        parts: [{ type: "text", content: "final" }],
        modelId: "claude-opus-5",
      },
    ];

    expect(compactConsecutiveAssistantMessages(messages)[0]?.modelId).toBe("claude-opus-5");
  });

  test("does not combine assistant messages across a visible user message", () => {
    const messages: ClaudeMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "first",
        createdAt: "2026-01-01T00:00:00Z",
        parts: [{ type: "text", content: "first" }],
      },
      {
        id: "u1",
        role: "user",
        content: "next",
        createdAt: "2026-01-01T00:01:00Z",
        parts: [{ type: "text", content: "next" }],
      },
      {
        id: "a2",
        role: "assistant",
        content: "second",
        createdAt: "2026-01-01T00:02:00Z",
        parts: [{ type: "text", content: "second" }],
      },
    ];

    expect(compactConsecutiveAssistantMessages(messages)).toHaveLength(3);
  });

  test("does not combine assistant messages across error entries", () => {
    const messages: ClaudeMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "first",
        createdAt: "2026-01-01T00:00:00Z",
        parts: [{ type: "text", content: "first" }],
      },
      {
        id: `${ERROR_MESSAGE_PREFIX}auth`,
        role: "assistant",
        content: "auth failed",
        createdAt: "2026-01-01T00:00:01Z",
        parts: [],
      },
      {
        id: "a2",
        role: "assistant",
        content: "second",
        createdAt: "2026-01-01T00:00:02Z",
        parts: [{ type: "text", content: "second" }],
      },
    ];

    const compacted = compactConsecutiveAssistantMessages(messages);

    expect(compacted.map((message) => message.id)).toEqual([
      "a1",
      `${ERROR_MESSAGE_PREFIX}auth`,
      "a2",
    ]);
  });
});

describe("pendingApprovals", () => {
  test("addPendingApproval dedupes by eventId", () => {
    const a = payloadToApproval("evt-1", { tool_name: "Bash", tool_input: {} });
    useClaudeTmuxStore.getState().addPendingApproval("e", a);
    useClaudeTmuxStore.getState().addPendingApproval("e", a);
    useClaudeTmuxStore.getState().addPendingApproval("e", a);
    expect(useClaudeTmuxStore.getState().getTab("e").pendingApprovals).toHaveLength(1);
  });

  test("removePendingApproval removes by eventId", () => {
    useClaudeTmuxStore
      .getState()
      .addPendingApproval("e", payloadToApproval("evt-1", { tool_name: "Bash", tool_input: {} }));
    useClaudeTmuxStore
      .getState()
      .addPendingApproval("e", payloadToApproval("evt-2", { tool_name: "Write", tool_input: {} }));
    useClaudeTmuxStore.getState().removePendingApproval("e", "evt-1");
    const env = useClaudeTmuxStore.getState().getTab("e");
    expect(env.pendingApprovals).toHaveLength(1);
    expect(env.pendingApprovals[0]!.eventId).toBe("evt-2");
  });
});

describe("prompt draft clearing", () => {
  /**
   * The plan/elicitation/question cards keep in-progress user input in the
   * prompt-draft store so it survives the tab unmounting; every path that
   * drops a pending prompt must drop its draft, or the stale input would
   * resurface on a future prompt that reuses the event id.
   */
  const drafts = () => usePromptDraftStore.getState();

  test("removePendingPlan clears the plan feedback draft", () => {
    const store = useClaudeTmuxStore.getState();
    store.addPendingPlan("e", payloadToPlan("evt-1", { tool_input: { plan: "p" } }));
    drafts().setDraftValue(tmuxPlanDraftKey("e", "evt-1"), "feedback", "typed");

    store.removePendingPlan("e", "evt-1");

    expect(drafts().drafts.has(tmuxPlanDraftKey("e", "evt-1"))).toBe(false);
  });

  test("removePendingElicitation clears the typed values draft", () => {
    const store = useClaudeTmuxStore.getState();
    store.addPendingElicitation("e", payloadToElicitation("evt-1", {}));
    drafts().setDraftValue(tmuxElicitationDraftKey("e", "evt-1"), "values", { a: "1" });

    store.removePendingElicitation("e", "evt-1");

    expect(drafts().drafts.has(tmuxElicitationDraftKey("e", "evt-1"))).toBe(false);
  });

  test("removePendingQuestion clears the question answer draft", () => {
    const store = useClaudeTmuxStore.getState();
    store.addPendingQuestion("e", payloadToQuestion("evt-1", {}));
    drafts().setDraftValue(tmuxQuestionDraftKey("e", "evt-1"), "answers", [["A"]]);

    store.removePendingQuestion("e", "evt-1");

    expect(drafts().drafts.has(tmuxQuestionDraftKey("e", "evt-1"))).toBe(false);
  });

  test("scoped cleanup preserves another session that reused the same event id", () => {
    const store = useClaudeTmuxStore.getState();
    const firstKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const secondKey = createClaudeTmuxStateKey("env-2", "tab-1");
    store.addPendingQuestion(firstKey, payloadToQuestion("shared-event", {}));
    store.addPendingQuestion(secondKey, payloadToQuestion("shared-event", {}));
    drafts().setDraftValue(tmuxQuestionDraftKey(firstKey, "shared-event"), "answers", [["first"]]);
    drafts().setDraftValue(tmuxQuestionDraftKey(secondKey, "shared-event"), "answers", [
      ["second"],
    ]);

    store.removePendingQuestion(firstKey, "shared-event");

    expect(drafts().drafts.has(tmuxQuestionDraftKey(firstKey, "shared-event"))).toBe(false);
    expect(drafts().drafts.get(tmuxQuestionDraftKey(secondKey, "shared-event"))).toEqual({
      answers: [["second"]],
    });
  });

  test("replacePendingHooks drops drafts for withdrawn prompts and keeps live ones", () => {
    const store = useClaudeTmuxStore.getState();
    const keptPlan = payloadToPlan("evt-kept", { tool_input: { plan: "p" } });
    store.addPendingPlan("e", keptPlan);
    store.addPendingPlan("e", payloadToPlan("evt-gone", { tool_input: { plan: "q" } }));
    drafts().setDraftValue(tmuxPlanDraftKey("e", "evt-kept"), "feedback", "keep me");
    drafts().setDraftValue(tmuxPlanDraftKey("e", "evt-gone"), "feedback", "drop me");

    store.replacePendingHooks("e", {
      approvals: [],
      questions: [],
      plans: [keptPlan],
      permissions: [],
      elicitations: [],
    });

    expect(drafts().drafts.has(tmuxPlanDraftKey("e", "evt-kept"))).toBe(true);
    expect(drafts().drafts.has(tmuxPlanDraftKey("e", "evt-gone"))).toBe(false);
  });

  test("resetTab sweeps drafts for every pending prompt on the tab", () => {
    const store = useClaudeTmuxStore.getState();
    store.addPendingPlan("e", payloadToPlan("evt-plan", { tool_input: { plan: "p" } }));
    store.addPendingElicitation("e", payloadToElicitation("evt-elic", {}));
    drafts().setDraftValue(tmuxPlanDraftKey("e", "evt-plan"), "feedback", "typed");
    drafts().setDraftValue(tmuxElicitationDraftKey("e", "evt-elic"), "values", { a: "1" });
    // A different tab's draft is untouched.
    drafts().setDraftValue(tmuxPlanDraftKey("other", "evt-other"), "feedback", "other tab");

    store.resetTab("e");

    expect(drafts().drafts.has(tmuxPlanDraftKey("e", "evt-plan"))).toBe(false);
    expect(drafts().drafts.has(tmuxElicitationDraftKey("e", "evt-elic"))).toBe(false);
    expect(drafts().drafts.has(tmuxPlanDraftKey("other", "evt-other"))).toBe(true);
  });
});

describe("payloadToApproval", () => {
  test("reads snake_case tool_name and tool_input", () => {
    const a = payloadToApproval("e1", {
      tool_name: "Bash",
      tool_input: { cmd: "ls" },
    });
    expect(a.toolName).toBe("Bash");
    expect(a.toolInput).toEqual({ cmd: "ls" });
  });

  test("preserves authoritative timing and falls back safely when it is absent", () => {
    const timed = payloadToApproval(
      "e1",
      { tool_name: "Bash" },
      { requestedAt: 1_900_000_000_000, expiresAt: 1_900_000_300_000 },
    );
    expect(timed).toMatchObject({
      requestedAt: 1_900_000_000_000,
      expiresAt: 1_900_000_300_000,
      receivedAt: "2030-03-17T17:46:40.000Z",
    });
    const withStrayRuntimeFields = payloadToApproval("e2", {}, {
      requestedAt: 1_900_000_000_000,
      expiresAt: 1_900_000_300_000,
      id: "must-not-leak",
      kind: "PreToolUse",
    } as { requestedAt: number; expiresAt: number });
    expect(withStrayRuntimeFields).not.toHaveProperty("id");
    expect(withStrayRuntimeFields).not.toHaveProperty("kind");
    expect(payloadToApproval("legacy", {}).requestedAt).toBeUndefined();
    expect(payloadToApproval("legacy", {}).expiresAt).toBeUndefined();
  });

  test("accepts camelCase variants", () => {
    const a = payloadToApproval("e1", {
      toolName: "Read",
      toolInput: { path: "x" },
    });
    expect(a.toolName).toBe("Read");
    expect(a.toolInput).toEqual({ path: "x" });
  });

  test("falls back when payload is empty", () => {
    const a = payloadToApproval("e1", {});
    expect(a.toolName).toBe("tool");
    expect(a.toolInput).toEqual({});
  });

  test("handles null payload", () => {
    const a = payloadToApproval("e1", null);
    expect(a.toolName).toBe("tool");
    expect(a.toolInput).toEqual({});
  });
});

describe("pending hook payload conversion", () => {
  test("normalizes question, plan, permission, and elicitation payload variants", () => {
    expect(
      payloadToQuestion("question", {
        toolInput: { questions: [{ question: "Continue?", header: "Choice", options: [] }] },
      }),
    ).toMatchObject({
      eventId: "question",
      questions: [{ question: "Continue?" }],
    });
    expect(
      payloadToPlan("plan", {
        tool_input: {
          plan: "Ship it",
          plan_file_path: "/tmp/plan.md",
          allowed_prompts: ["Bash"],
        },
      }),
    ).toMatchObject({
      eventId: "plan",
      plan: "Ship it",
      planFilePath: "/tmp/plan.md",
      allowedPrompts: ["Bash"],
    });
    expect(
      payloadToPermission("permission", {
        toolName: "Edit",
        toolInput: { file_path: "a.ts" },
        permissionSuggestions: ["allow"],
      }),
    ).toMatchObject({
      eventId: "permission",
      toolName: "Edit",
      toolInput: { file_path: "a.ts" },
      permissionSuggestions: ["allow"],
    });
    expect(
      payloadToElicitation("elicitation", {
        mcp_server_name: "docs",
        message: "Choose a value",
        mode: "form",
        requested_schema: { type: "object" },
      }),
    ).toMatchObject({
      eventId: "elicitation",
      mcpServerName: "docs",
      message: "Choose a value",
      mode: "form",
      requestedSchema: { type: "object" },
    });
  });

  test("uses safe empty fallbacks for malformed payloads", () => {
    expect(payloadToQuestion("question", null)).toMatchObject({
      questions: [],
      toolInput: {},
    });
    expect(payloadToPlan("plan", { tool_input: "invalid" })).toMatchObject({
      plan: null,
      planFilePath: null,
      allowedPrompts: [],
    });
    expect(payloadToPermission("permission", null)).toMatchObject({
      toolName: "tool",
      toolInput: {},
      permissionSuggestions: [],
    });
    expect(payloadToElicitation("elicitation", { requested_schema: "invalid" })).toMatchObject({
      mcpServerName: "MCP server",
      message: "MCP server requested input",
      mode: null,
      url: null,
      requestedSchema: null,
    });
  });
});

describe("payloadToInfoEvent", () => {
  test("prefers .message field", () => {
    const e = payloadToInfoEvent("e1", "Notification", { message: "hi" });
    expect(e.message).toBe("hi");
  });

  test("falls back to .notification then to kind", () => {
    expect(payloadToInfoEvent("e1", "Stop", { notification: "n" }).message).toBe("n");
    expect(payloadToInfoEvent("e1", "Stop", {}).message).toBe("Stop");
  });
});

describe("infoEvents", () => {
  test("pushInfoEvent keeps at most 20", () => {
    for (let i = 0; i < 25; i++) {
      useClaudeTmuxStore.getState().pushInfoEvent("e", {
        id: `i${i}`,
        kind: "Notification",
        message: String(i),
        receivedAt: "now",
      });
    }
    const events = useClaudeTmuxStore.getState().getTab("e").infoEvents;
    expect(events).toHaveLength(20);
    expect(events[events.length - 1]!.id).toBe("i24");
  });

  test("dismissInfoEvent removes by id", () => {
    useClaudeTmuxStore.getState().pushInfoEvent("e", {
      id: "a",
      kind: "Notification",
      message: "x",
      receivedAt: "n",
    });
    useClaudeTmuxStore.getState().pushInfoEvent("e", {
      id: "b",
      kind: "Notification",
      message: "y",
      receivedAt: "n",
    });
    useClaudeTmuxStore.getState().dismissInfoEvent("e", "a");
    const events = useClaudeTmuxStore.getState().getTab("e").infoEvents;
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("b");
  });
});

describe("drafts, attachments, and queue helpers", () => {
  test("stores draft text and mentions per scoped tab and deletes empty values", () => {
    const keyA = createClaudeTmuxStateKey("env-a", "tab-1");
    const keyB = createClaudeTmuxStateKey("env-b", "tab-1");
    const store = useClaudeTmuxStore.getState();

    store.setDraftText(keyA, "hello @src/App.tsx");
    store.setDraftMentions(keyA, [
      {
        id: "mention-1",
        filename: "App.tsx",
        relativePath: "src/App.tsx",
      },
    ]);
    store.setDraftText(keyB, "other draft");

    expect(store.getDraftText(keyA)).toBe("hello @src/App.tsx");
    expect(store.getDraftMentions(keyA)).toEqual([
      {
        id: "mention-1",
        filename: "App.tsx",
        relativePath: "src/App.tsx",
      },
    ]);
    expect(store.getDraftText(keyB)).toBe("other draft");

    store.setDraftText(keyA, "");
    store.setDraftMentions(keyA, []);

    expect(useClaudeTmuxStore.getState().getDraftText(keyA)).toBe("");
    expect(useClaudeTmuxStore.getState().getDraftMentions(keyA)).toEqual([]);
    expect(useClaudeTmuxStore.getState().getDraftText(keyB)).toBe("other draft");
  });

  test("adds, removes, and clears attachments per scoped tab", () => {
    const keyA = createClaudeTmuxStateKey("env-a", "tab-1");
    const keyB = createClaudeTmuxStateKey("env-b", "tab-1");
    const store = useClaudeTmuxStore.getState();

    store.addAttachment(keyA, {
      id: "att-1",
      type: "image",
      path: "/workspace/one.png",
      previewUrl: "data:image/png;base64,one",
      name: "one.png",
    });
    store.addAttachment(keyA, {
      id: "att-2",
      type: "image",
      path: "/workspace/two.png",
      previewUrl: "data:image/png;base64,two",
      name: "two.png",
    });
    store.addAttachment(keyB, {
      id: "att-b",
      type: "image",
      path: "/workspace/b.png",
      previewUrl: "data:image/png;base64,b",
      name: "b.png",
    });

    expect(store.getAttachments(keyA).map((attachment) => attachment.id)).toEqual([
      "att-1",
      "att-2",
    ]);

    store.removeAttachment(keyA, "att-1");
    expect(
      useClaudeTmuxStore
        .getState()
        .getAttachments(keyA)
        .map((a) => a.id),
    ).toEqual(["att-2"]);
    expect(
      useClaudeTmuxStore
        .getState()
        .getAttachments(keyB)
        .map((a) => a.id),
    ).toEqual(["att-b"]);

    useClaudeTmuxStore.getState().clearAttachments(keyA);
    expect(useClaudeTmuxStore.getState().getAttachments(keyA)).toEqual([]);
    expect(
      useClaudeTmuxStore
        .getState()
        .getAttachments(keyB)
        .map((a) => a.id),
    ).toEqual(["att-b"]);
  });

  test("projects and replaces queued messages per scoped tab", () => {
    const keyA = createClaudeTmuxStateKey("env-a", "tab-1");
    const keyB = createClaudeTmuxStateKey("env-b", "tab-1");
    const store = useClaudeTmuxStore.getState();

    seedQueuedPrompt(store, keyA, { id: "q-1", text: "first", attachments: [] });
    seedQueuedPrompt(store, keyA, { id: "q-2", text: "second", attachments: [] });
    seedQueuedPrompt(store, keyA, { id: "q-3", text: "third", attachments: [] });
    seedQueuedPrompt(store, keyB, { id: "q-b", text: "other", attachments: [] });

    expect(store.getQueueLength(keyA)).toBe(3);
    expect(store.getQueuedMessages(keyA).map((message) => message.id)).toEqual([
      "q-1",
      "q-2",
      "q-3",
    ]);

    // Reordering and removal are backend commands; the store only adopts the
    // snapshot they return, scoped to the tab that owns it.
    useClaudeTmuxStore.getState().setQueueProjection(keyA, [
      { id: "q-3", text: "third", attachments: [] },
      { id: "q-2", text: "second", attachments: [] },
    ]);
    expect(
      useClaudeTmuxStore
        .getState()
        .getQueuedMessages(keyA)
        .map((m) => m.id),
    ).toEqual(["q-3", "q-2"]);

    expect(
      useClaudeTmuxStore
        .getState()
        .getQueuedMessages(keyB)
        .map((m) => m.id),
    ).toEqual(["q-b"]);
    useClaudeTmuxStore.getState().setQueueProjection(keyB, []);
    expect(useClaudeTmuxStore.getState().getQueueLength(keyB)).toBe(0);
  });
});

describe("session lifecycle", () => {
  test("accepts restarted-session observations from revision one and rejects the retired generation", () => {
    const store = useClaudeTmuxStore.getState();
    const oldPrompt = {
      question: "Old prompt",
      options: [{ number: 1, label: "Continue", optionIndex: 0, selected: true }],
      selectedOptionIndex: 0,
      inputMode: "navigate" as const,
    };
    store.setRunning("e", true, {
      sessionId: "sess-1",
      observationGeneration: "generation-a",
    });
    store.setObservation("e", {
      generation: "generation-a",
      revision: 47,
      observedAt: "2026-08-04T12:00:00.000Z",
      usage: [],
      prompt: oldPrompt,
    });

    // Replacing a tmux process may resume the same provider session id. The
    // backend generation, not that id, scopes the revision counter.
    store.setRunning("e", true, {
      sessionId: "sess-1",
      observationGeneration: "generation-b",
    });
    expect(useClaudeTmuxStore.getState().getTab("e").observation).toMatchObject({
      generation: "generation-b",
      revision: 0,
      prompt: null,
    });

    store.setObservation("e", {
      generation: "generation-a",
      revision: 48,
      observedAt: "2026-08-04T12:00:01.000Z",
      usage: [],
      prompt: oldPrompt,
    });
    store.setObservation("e", {
      generation: "generation-b",
      revision: 1,
      observedAt: "2026-08-04T12:00:02.000Z",
      usage: [],
      prompt: null,
    });

    expect(useClaudeTmuxStore.getState().getTab("e").observation).toMatchObject({
      generation: "generation-b",
      revision: 1,
      prompt: null,
    });
  });

  test("a stopped transition drops the dead session prompt", () => {
    const store = useClaudeTmuxStore.getState();
    store.setRunning("e", true, { sessionId: "sess-1" });
    store.setObservation("e", {
      revision: 4,
      observedAt: "2026-08-04T12:00:00.000Z",
      usage: [],
      prompt: {
        question: "Still there?",
        options: [{ number: 1, label: "Yes", optionIndex: 0, selected: true }],
        selectedOptionIndex: 0,
        inputMode: "navigate",
      },
    });

    store.setRunning("e", false, { sessionId: null });

    expect(useClaudeTmuxStore.getState().getTab("e").observation).toMatchObject({
      revision: 0,
      prompt: null,
    });
  });

  test("optimistic prompt clearing does not erase a newer authoritative prompt", () => {
    const store = useClaudeTmuxStore.getState();
    const first = {
      question: "First",
      options: [{ number: 1, label: "One", optionIndex: 0, selected: true }],
      selectedOptionIndex: 0,
      inputMode: "navigate" as const,
    };
    const second = {
      ...first,
      question: "Second",
    };
    store.setObservation("e", {
      revision: 1,
      observedAt: "2026-08-04T12:00:00.000Z",
      usage: [],
      prompt: first,
    });
    store.clearSelectionPrompt("e", first);
    expect(useClaudeTmuxStore.getState().getTab("e").observation.prompt).toBeNull();

    store.setObservation("e", {
      revision: 2,
      observedAt: "2026-08-04T12:00:01.000Z",
      usage: [],
      prompt: second,
    });
    store.clearSelectionPrompt("e", first);
    expect(useClaudeTmuxStore.getState().getTab("e").observation.prompt).toBe(second);
  });

  test("setRunning preserves prior sessionId when called without sessionId", () => {
    useClaudeTmuxStore.getState().setRunning("e", true, { sessionId: "sess-1" });
    // Subsequent setRunning that doesn't pass sessionId leaves it intact.
    useClaudeTmuxStore.getState().setRunning("e", false);
    const tab = useClaudeTmuxStore.getState().getTab("e");
    expect(tab.running).toBe(false);
    expect(tab.sessionId).toBe("sess-1");
  });

  test("setRunning with sessionId=null clears it", () => {
    useClaudeTmuxStore.getState().setRunning("e", true, { sessionId: "sess-1" });
    useClaudeTmuxStore.getState().setRunning("e", false, { sessionId: null });
    const tab = useClaudeTmuxStore.getState().getTab("e");
    expect(tab.sessionId).toBeNull();
  });

  test("setRunning records resumed and environmentId", () => {
    useClaudeTmuxStore.getState().setRunning("tab-a", true, {
      sessionId: "sess-2",
      environmentId: "env-x",
      resumed: true,
    });
    const tab = useClaudeTmuxStore.getState().getTab("tab-a");
    expect(tab.sessionId).toBe("sess-2");
    expect(tab.environmentId).toBe("env-x");
    expect(tab.resumed).toBe(true);
  });

  test("resetTab clears state", () => {
    const store = useClaudeTmuxStore.getState();
    store.setRunning("e", true, { sessionId: "sess-1" });
    store.applyTranscriptLine("e", {
      type: "user",
      uuid: "u",
      message: { role: "user", content: "hi" },
    });
    store.setDraftText("e", "queued draft");
    store.addAttachment("e", {
      id: "att-1",
      type: "image",
      path: "/workspace/att.png",
      previewUrl: "data:image/png;base64,att",
      name: "att.png",
    });
    seedQueuedPrompt(store, "e", {
      id: "queue-1",
      text: "queued prompt",
      attachments: [],
    });

    store.resetTab("e");
    const tab = useClaudeTmuxStore.getState().getTab("e");
    expect(tab.running).toBe(false);
    expect(tab.sessionId).toBeNull();
    expect(tab.messages).toHaveLength(0);
    expect(useClaudeTmuxStore.getState().getDraftText("e")).toBe("");
    expect(useClaudeTmuxStore.getState().getAttachments("e")).toEqual([]);
    expect(useClaudeTmuxStore.getState().getQueuedMessages("e")).toEqual([]);
  });
});
