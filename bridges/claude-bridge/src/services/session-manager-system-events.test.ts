import { describe, expect, test } from "bun:test";
import type { NormalizedMessage, SSEEvent } from "../types/index.js";
// The harness installs its module mocks on evaluation, so it loads first.
import {
  abortSession,
  captureEvents,
  createSession,
  getSession,
  nextQueryCall,
  sendPrompt,
  track,
  waitFor,
} from "./session-manager-test-harness.js";
import {
  INTERRUPTED_NOTICE_TEXT,
  normalizePersistedSessionMessages,
  parseTaskNotification,
} from "./session-manager-messages.js";
import { THINKING_TOKENS_EMIT_INTERVAL_MS, memoryRecallPart } from "./session-manager-prompt.js";

// ---------------------------------------------------------------------------
// SDK frames the bridge used to drop: system subtypes with no branch, synthetic
// user turns, and the CLI's interruption markers. Each test pins what the user
// now sees in place of the gap.
// ---------------------------------------------------------------------------

const TASK_REPORT = `<task-notification>
<task-id>ae909f63ce9f9f00c</task-id>
<tool-use-id>agent-1</tool-use-id>
<output-file>/tmp/tasks/ae909f63ce9f9f00c.output</output-file>
<status>completed</status>
<summary>Agent "Validate head" finished</summary>
<note>A task-notification fires each time this agent stops.</note>
<result>Every command passed. The report quotes a tag: </result> and continues.</result>
<usage><total_tokens>10</total_tokens></usage>
</task-notification>`;

function statusRows(messages: NormalizedMessage[]) {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => message.parts[0])
    .filter((part) => part?.type === "status");
}

async function runTurn(
  name: string,
  frames: (call: Awaited<ReturnType<typeof nextQueryCall>>) => Promise<void> | void,
  options?: Parameters<typeof sendPrompt>[2],
) {
  const session = createSession(name);
  track(session.id);
  const promptPromise = sendPrompt(session.id, "hello", options);
  const call = await nextQueryCall();
  await frames(call);
  call.push({ type: "result", subtype: "success" });
  call.finish();
  await promptPromise;
  return getSession(session.id)!;
}

describe("system subtype dispositions", () => {
  test("handled task lifecycle subtypes are not also counted as notices", async () => {
    const session = await runTurn("task-lifecycle-no-notice", (call) => {
      call.push({ type: "system", subtype: "task_started", task_id: "t1", description: "work" });
      call.push({
        type: "system",
        subtype: "task_notification",
        task_id: "t1",
        status: "completed",
        summary: "done",
      });
    });
    const methods = session.health?.listNotices().map((notice) => notice.method) ?? [];
    expect(methods).not.toContain("system/task_started");
    expect(methods).not.toContain("system/task_notification");
  });

  test("hook progress is ignored and only a failed hook response is recorded", async () => {
    const session = await runTurn("hook-noise", (call) => {
      call.push({
        type: "system",
        subtype: "hook_started",
        hook_id: "h1",
        hook_name: "PreCompact",
      });
      call.push({ type: "system", subtype: "hook_progress", hook_id: "h1" });
      call.push({ type: "system", subtype: "hook_response", hook_id: "h1", outcome: "success" });
      call.push({ type: "system", subtype: "hook_response", hook_id: "h2", outcome: "error" });
    });
    const notices = session.health?.listNotices() ?? [];
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ method: "system/hook_response", severity: "error" });
  });

  test("a subtype newer than the table is counted as drift and kept as a notice", async () => {
    const session = await runTurn("system-subtype-drift", (call) => {
      call.push({ type: "system", subtype: "invented_later", message: "hello" });
    });
    expect(session.health?.drift()?.unknownKinds).toEqual(["system:invented_later"]);
    expect(session.health?.listNotices()[0]?.method).toBe("system/invented_later");
  });

  test("an unknown content block is counted as drift by name only", async () => {
    const session = await runTurn("content-block-drift", (call) => {
      call.push({
        type: "assistant",
        uuid: "asst-1",
        message: {
          model: "claude-sonnet-4-6",
          content: [{ type: "invented_block", secret: "file contents" }],
        },
      });
    });
    const drift = session.health?.drift();
    expect(drift?.unknownKinds).toEqual(["block:invented_block"]);
    expect(JSON.stringify(drift)).not.toContain("file contents");
  });
});

describe("thinking token estimates", () => {
  test("hold the estimate on the session, throttle frames, and clear on the answer", async () => {
    const { events, stop } = captureEvents();
    try {
      const session = createSession("thinking-tokens");
      track(session.id);
      const promptPromise = sendPrompt(session.id, "hello");
      const call = await nextQueryCall();
      for (const estimate of [120, 480, 960]) {
        call.push({
          type: "system",
          subtype: "thinking_tokens",
          estimated_tokens: estimate,
          estimated_tokens_delta: 1,
        });
      }
      await waitFor(() => session.thinkingTokens === 960);
      // Every value is kept; only the first inside one interval is published.
      const published = events.filter(
        (event) =>
          event.type === "session.updated" &&
          typeof (event.data as { thinkingTokens?: unknown }).thinkingTokens === "number",
      );
      expect(published).toHaveLength(1);
      expect(THINKING_TOKENS_EMIT_INTERVAL_MS).toBeGreaterThan(0);

      call.push({
        type: "assistant",
        uuid: "asst-1",
        message: { model: "claude-sonnet-4-6", content: [{ type: "text", text: "done" }] },
      });
      await waitFor(() => session.thinkingTokens === undefined);
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;

      expect(
        events.some(
          (event) =>
            event.type === "session.updated" &&
            (event.data as { thinkingTokens?: unknown }).thinkingTokens === null,
        ),
      ).toBe(true);
      expect(session.health?.listNotices() ?? []).toEqual([]);
    } finally {
      stop();
    }
  });
});

describe("status frames", () => {
  test("compaction is session activity while it runs and is cleared by the turn's end", async () => {
    const session = createSession("status-compacting");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "hello");
    const call = await nextQueryCall();
    call.push({ type: "system", subtype: "status", status: "compacting" });
    await waitFor(() => session.activity === "compacting");
    call.push({ type: "system", subtype: "status", status: null });
    await waitFor(() => session.activity === undefined);
    call.push({ type: "system", subtype: "status", status: "compacting" });
    await waitFor(() => session.activity === "compacting");
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;

    // A turn that ended mid-compaction must not leave the indicator behind.
    expect(session.activity).toBeUndefined();
    expect(session.health?.listNotices() ?? []).toEqual([]);
  });

  test("a failed compaction becomes a warning row, which the hook path never wrote", async () => {
    const session = await runTurn("status-compact-failed", (call) => {
      call.push({
        type: "system",
        subtype: "status",
        status: null,
        compact_result: "failed",
        compact_error: "Conversation too long to summarize",
      });
    });
    expect(statusRows(session.messages)).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        content: "Compaction failed: Conversation too long to summarize",
      }),
    );
  });

  test("leaving plan mode on a status frame clears the toggle for a plan turn", async () => {
    const session = await runTurn(
      "status-plan-exit",
      async (call) => {
        call.push({ type: "system", subtype: "status", status: null, permissionMode: "plan" });
        call.push({ type: "system", subtype: "status", status: null, permissionMode: "default" });
      },
      { permissionMode: "plan" },
    );
    expect(session.planMode).toBe(false);
  });

  test("a late status still saying plan never turns the toggle back on", async () => {
    const session = createSession("status-plan-late");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "hello", { permissionMode: "plan" });
    const call = await nextQueryCall();
    // As the approved ExitPlanMode handler leaves it.
    session.planMode = false;
    call.push({ type: "system", subtype: "status", status: "requesting", permissionMode: "plan" });
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
    expect(getSession(session.id)!.planMode).toBe(false);
  });

  test("a non-plan mode on a turn that never started in plan says nothing about the toggle", async () => {
    const session = createSession("status-plan-untouched");
    track(session.id);
    session.planMode = true;
    // No permissionMode: the turn runs in the policy mode, not in plan.
    const promptPromise = sendPrompt(session.id, "hello");
    const call = await nextQueryCall();
    call.push({ type: "system", subtype: "status", status: null, permissionMode: "default" });
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
    expect(getSession(session.id)!.planMode).toBe(true);
  });
});

describe("informational, permission and memory frames", () => {
  test("a warning is a row, a repeat for one tool use updates it, and info stays in health", async () => {
    const session = await runTurn("informational", (call) => {
      call.push({
        type: "system",
        subtype: "informational",
        level: "warning",
        content: "Hook blocked the prompt",
        tool_use_id: "tool-1",
      });
      call.push({
        type: "system",
        subtype: "informational",
        level: "warning",
        content: "Hook blocked the prompt (again)",
        tool_use_id: "tool-1",
      });
      call.push({ type: "system", subtype: "informational", level: "info", content: "verbose" });
      call.push({
        type: "system",
        subtype: "informational",
        level: "notice",
        content: "Stop hook ended the turn",
        prevent_continuation: true,
      });
    });
    const rows = statusRows(session.messages).map((part) => [part!.severity, part!.content]);
    expect(rows).toEqual([
      ["warning", "Hook blocked the prompt (again)"],
      ["warning", "Stop hook ended the turn"],
    ]);
    expect(session.health?.listNotices().map((notice) => notice.method)).toEqual([
      "system/informational",
    ]);
  });

  test("a permission denial is kept on the tool row it refused", async () => {
    const session = await runTurn("permission-denied", (call) => {
      call.push({
        type: "assistant",
        uuid: "asst-1",
        message: {
          model: "claude-sonnet-4-6",
          content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "rm -rf" } }],
        },
      });
      call.push({
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        tool_use_id: "tool-1",
        decision_reason_type: "rule",
        decision_reason: "Bash(rm:*) is denied by settings",
        message: "Permission denied",
      });
      call.push({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Permission denied",
              is_error: true,
            },
          ],
        },
      });
    });
    const tool = session.messages
      .flatMap((message) => message.parts)
      .find((part) => part.toolUseId === "tool-1")!;
    // The tool result arriving afterwards must not erase who refused it.
    expect(tool.toolDenied).toEqual({
      reason: "Bash(rm:*) is denied by settings",
      source: "rule",
    });
    expect(tool.toolState).toBe("failure");
  });

  test("a denial for a call this turn never saw is still shown", async () => {
    const session = await runTurn("permission-denied-untracked", (call) => {
      call.push({
        type: "system",
        subtype: "permission_denied",
        tool_name: "Write",
        tool_use_id: "elsewhere",
        message: "Denied in dontAsk mode",
      });
    });
    expect(statusRows(session.messages)).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        content: "Write was denied: Denied in dontAsk mode",
      }),
    );
  });

  test("recalled memories are named, never quoted", async () => {
    const session = await runTurn("memory-recall", (call) => {
      call.push({
        type: "system",
        subtype: "memory_recall",
        mode: "select",
        memories: [
          { path: "/home/u/.claude/memory/prefers-bun.md", scope: "personal", content: "secret" },
          { path: "/home/u/.claude/memory/deploy.md", scope: "team" },
        ],
      });
    });
    const rows = statusRows(session.messages);
    expect(rows.map((part) => part!.content)).toEqual([
      "Recalled from memory: prefers-bun.md, deploy.md",
    ]);
    expect(JSON.stringify(session.messages)).not.toContain("secret");
  });

  test("a synthesized recall does not name a directory sentinel", () => {
    expect(memoryRecallPart("synthesize", [{ path: "<synthesis:/home/u/.claude>" }]).content).toBe(
      "Recalled from memory (synthesized summary)",
    );
    const many = Array.from({ length: 10 }, (_, index) => ({ path: `/m/${index}.md` }));
    expect(memoryRecallPart("select", many).content).toEndWith("and 2 more");
  });
});

describe("task reports", () => {
  test("parses every field, taking the result up to its last closing tag", () => {
    expect(parseTaskNotification(TASK_REPORT)).toEqual({
      taskId: "ae909f63ce9f9f00c",
      toolUseId: "agent-1",
      status: "completed",
      summary: 'Agent "Validate head" finished',
      result: "Every command passed. The report quotes a tag: </result> and continues.",
    });
    expect(parseTaskNotification("an ordinary prompt")).toBeUndefined();
  });

  test("a background agent's report replaces the launch placeholder on its row", async () => {
    const session = await runTurn("task-report-live", (call) => {
      call.push({
        type: "assistant",
        uuid: "asst-1",
        message: {
          model: "claude-sonnet-4-6",
          content: [
            {
              type: "tool_use",
              id: "agent-1",
              name: "Agent",
              input: { description: "Validate head", run_in_background: true },
            },
          ],
        },
      });
      call.push({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "agent-1", content: "Async agent launched" },
          ],
        },
      });
      // The CLI injects the report as a bare-string user turn.
      call.push({ type: "user", message: { role: "user", content: TASK_REPORT } });
    });
    const agent = session.messages
      .flatMap((message) => message.parts)
      .find((part) => part.toolUseId === "agent-1")!;
    expect(agent.toolOutput).toContain("Every command passed.");
    expect(agent.toolState).toBe("success");
    // Not a user bubble: nobody typed it.
    expect(session.messages.some((message) => message.content.includes("task-notification"))).toBe(
      false,
    );
  });

  test("a report with no row to attach to becomes a status row", async () => {
    const session = await runTurn("task-report-unattached", (call) => {
      call.push({
        type: "user",
        message: {
          role: "user",
          content: TASK_REPORT.replace("<tool-use-id>agent-1</tool-use-id>", "").replace(
            "<status>completed</status>",
            "<status>failed</status>",
          ),
        },
      });
    });
    expect(statusRows(session.messages)).toContainEqual(
      expect.objectContaining({ severity: "error", content: 'Agent "Validate head" finished' }),
    );
  });
});

describe("interruptions", () => {
  test("a user stop leaves one interruption row", async () => {
    const { events, stop } = captureEvents();
    try {
      const session = createSession("interrupt-abort");
      track(session.id);
      const promptPromise = sendPrompt(session.id, "wait");
      await nextQueryCall();
      expect(abortSession(session.id)).toBe(true);
      await promptPromise;
      const rows = statusRows(getSession(session.id)!.messages);
      expect(rows.map((part) => part!.content)).toEqual([INTERRUPTED_NOTICE_TEXT]);
      expect(
        events.some(
          (event: SSEEvent) =>
            event.type === "message.updated" &&
            (event.data as { message?: NormalizedMessage }).message?.content ===
              INTERRUPTED_NOTICE_TEXT,
        ),
      ).toBe(true);
    } finally {
      stop();
    }
  });

  test("the CLI's interruption marker is a row, not a user bubble", async () => {
    const session = await runTurn("interrupt-marker", (call) => {
      call.push({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "[Request interrupted by user]" }],
        },
      });
    });
    expect(statusRows(session.messages).map((part) => part!.content)).toEqual([
      INTERRUPTED_NOTICE_TEXT,
    ]);
    // Only the prompt the bridge sent is a user bubble; the marker is not.
    expect(
      session.messages.filter((message) => message.role === "user").map((m) => m.content),
    ).toEqual(["hello"]);
  });
});

describe("replayed transcripts match the live tab", () => {
  const persisted = (records: Array<Record<string, unknown>>) =>
    records.map((record, index) => ({
      uuid: `record-${index}`,
      session_id: "sdk-session",
      parent_tool_use_id: null,
      timestamp: `2026-09-24T10:00:0${index}.000Z`,
      ...record,
    })) as Parameters<typeof normalizePersistedSessionMessages>[0];

  test("a task report lands on its agent row and the interruption marker is a row", () => {
    const { messages } = normalizePersistedSessionMessages(
      persisted([
        {
          type: "user",
          message: { role: "user", content: [{ type: "text", text: "Check the head" }] },
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "agent-1",
                name: "Agent",
                input: { description: "Validate head", run_in_background: true },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "agent-1", content: "Async agent launched" },
            ],
          },
        },
        { type: "user", message: { role: "user", content: TASK_REPORT } },
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
          },
        },
      ]),
    );

    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "Check the head"],
      ["assistant", ""],
      ["system", INTERRUPTED_NOTICE_TEXT],
    ]);
    const agent = messages[1]!.parts.find((part) => part.toolUseId === "agent-1")!;
    expect(agent.toolOutput).toContain("Every command passed.");
    // Stable across rehydrations, and never addressable as a fork boundary.
    expect(messages[2]!.id).toBe("record-4:notice:0");
    expect(messages[2]!.sdkUuid).toBeUndefined();
  });
});
