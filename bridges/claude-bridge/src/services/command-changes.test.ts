import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedPart } from "../types/index.js";
// The harness installs its module mocks on evaluation, so it loads first.
import {
  PERSISTED_SDK_ID,
  createSession,
  getSession,
  hydratePersistedSessionMessages,
  materializePersistedSession,
  mockSdkGetSessionMessages,
  nextQueryCall,
  sendPrompt,
  track,
  transcriptWithToolResult,
  waitFor,
} from "./session-manager-test-harness.js";
import { commandChangeJournal, overlayCommandChanges } from "./command-changes.js";

type Hook = (
  input: Record<string, unknown>,
  toolUseId: string | undefined,
  options: unknown,
) => Promise<unknown>;
type Hooks = Record<string, Array<{ matcher?: string; hooks: Hook[] }>>;

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "claude-command-changes-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "bridge@example.com");
  git("config", "user.name", "Bridge");
  writeFileSync(join(repo, "notes.txt"), "one\ntwo\n");
  git("add", "-A");
  git("commit", "-qm", "init");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

function hookCaller(hooks: Hooks, event: string) {
  return async (input: Record<string, unknown>) => {
    for (const matcher of hooks[event] ?? []) {
      if (matcher.matcher && !new RegExp(matcher.matcher).test(String(input.tool_name))) continue;
      for (const hook of matcher.hooks) {
        await hook({ hook_event_name: event, cwd: repo, ...input }, String(input.tool_use_id), {
          signal: new AbortController().signal,
        });
      }
    }
  };
}

function bashCall(id: string, command = "edit notes") {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
  };
}

function toolResult(id: string) {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  };
}

function toolPart(sessionId: string, toolUseId: string): NormalizedPart | undefined {
  return getSession(sessionId)
    ?.messages.flatMap((message) => message.parts)
    .find((part) => part.toolUseId === toolUseId);
}

async function startTurn(name: string) {
  const session = createSession(name);
  track(session.id);
  const prompt = sendPrompt(session.id, "go");
  const call = await nextQueryCall();
  const hooks = call.options.hooks as Hooks;
  return {
    sessionId: session.id,
    call,
    pre: hookCaller(hooks, "PreToolUse"),
    post: hookCaller(hooks, "PostToolUse"),
    finish: async () => {
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await prompt;
    },
  };
}

describe("Bash command change measurement", () => {
  test("measures a Bash call and keeps the counts through its result", async () => {
    const turn = await startTurn("command-changes-live");
    turn.call.push(bashCall("bash-live"));
    await waitFor(() => toolPart(turn.sessionId, "bash-live") !== undefined);

    const call = { tool_name: "Bash", tool_input: { command: "x" }, tool_use_id: "bash-live" };
    await turn.pre({ ...call, session_id: "sdk-live" });
    writeFileSync(join(repo, "notes.txt"), "one\ntwo\nthree\nfour\n");
    await turn.post({ ...call, session_id: "sdk-live" });

    const expected = {
      additions: 2,
      deletions: 0,
      files: [{ path: "notes.txt", additions: 2, deletions: 0 }],
    };
    expect(toolPart(turn.sessionId, "bash-live")?.commandChanges).toEqual(expected);
    turn.call.push(toolResult("bash-live"));
    await waitFor(() => toolPart(turn.sessionId, "bash-live")?.toolState === "success");
    expect(toolPart(turn.sessionId, "bash-live")?.commandChanges).toEqual(expected);
    await turn.finish();

    expect((await commandChangeJournal("sdk-live")!.read()).get("bash-live")).toEqual(expected);
  });

  test("a measurement that outruns its tool call lands once the result arrives", async () => {
    const turn = await startTurn("command-changes-early");
    const call = { tool_name: "Bash", tool_input: { command: "x" }, tool_use_id: "bash-early" };
    await turn.pre({ ...call, session_id: "sdk-early" });
    writeFileSync(join(repo, "early.txt"), "new\n");
    await turn.post({ ...call, session_id: "sdk-early" });

    turn.call.push(bashCall("bash-early"));
    turn.call.push(toolResult("bash-early"));
    await waitFor(() => toolPart(turn.sessionId, "bash-early")?.toolState === "success");
    expect(toolPart(turn.sessionId, "bash-early")?.commandChanges?.additions).toBe(1);
    await turn.finish();
  });

  test("a denied call's window is closed and does not taint the next one", async () => {
    const turn = await startTurn("command-changes-denied");
    turn.call.push(bashCall("bash-denied"));
    await turn.pre({
      tool_name: "Bash",
      tool_input: { command: "rm" },
      tool_use_id: "bash-denied",
    });
    turn.call.push({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      tool_use_id: "bash-denied",
      message: "Permission denied",
    });
    turn.call.push(toolResult("bash-denied"));
    await waitFor(() => toolPart(turn.sessionId, "bash-denied")?.toolDenied !== undefined);

    turn.call.push(bashCall("bash-after"));
    const next = { tool_name: "Bash", tool_input: { command: "x" }, tool_use_id: "bash-after" };
    await turn.pre(next);
    writeFileSync(join(repo, "after.txt"), "a\nb\n");
    await turn.post(next);
    await waitFor(() => toolPart(turn.sessionId, "bash-after")?.commandChanges !== undefined);
    expect(toolPart(turn.sessionId, "bash-after")?.commandChanges?.approximate).toBeUndefined();
    expect(toolPart(turn.sessionId, "bash-denied")?.commandChanges).toBeUndefined();
    await turn.finish();
  });

  test("an overlapping Edit marks the Bash measurement approximate", async () => {
    const turn = await startTurn("command-changes-overlap");
    turn.call.push(bashCall("bash-overlap"));
    const bash = { tool_name: "Bash", tool_input: { command: "x" }, tool_use_id: "bash-overlap" };
    const edit = {
      tool_name: "Edit",
      tool_input: { file_path: join(repo, "notes.txt") },
      tool_use_id: "edit-overlap",
    };
    await turn.pre(bash);
    await turn.pre(edit);
    writeFileSync(join(repo, "notes.txt"), "rewritten\n");
    await turn.post(edit);
    await turn.post(bash);
    await waitFor(() => toolPart(turn.sessionId, "bash-overlap")?.commandChanges !== undefined);
    expect(toolPart(turn.sessionId, "bash-overlap")?.commandChanges?.approximate).toBe(true);
    await turn.finish();
  });

  test("a background launch is not measured", async () => {
    const turn = await startTurn("command-changes-background");
    turn.call.push(bashCall("bash-bg"));
    const call = {
      tool_name: "Bash",
      tool_input: { command: "sleep 1", run_in_background: true },
      tool_use_id: "bash-bg",
    };
    await turn.pre(call);
    writeFileSync(join(repo, "background.txt"), "x\n");
    await turn.post(call);
    turn.call.push(toolResult("bash-bg"));
    await waitFor(() => toolPart(turn.sessionId, "bash-bg")?.toolState === "success");
    expect(toolPart(turn.sessionId, "bash-bg")?.commandChanges).toBeUndefined();
    await turn.finish();
  });
});

describe("command change persistence", () => {
  test("a transcript rebuilt from disk regains its journaled counts", async () => {
    const change = {
      additions: 3,
      deletions: 1,
      files: [{ path: "a.ts", additions: 3, deletions: 1 }],
    };
    await commandChangeJournal(PERSISTED_SDK_ID)!.append("toolu_1", change);
    const state = await materializePersistedSession();
    mockSdkGetSessionMessages.mockImplementation(async () => transcriptWithToolResult());
    try {
      const messages = await hydratePersistedSessionMessages(state.id);
      const part = messages
        .flatMap((message) => message.parts)
        .find((p) => p.toolUseId === "toolu_1");
      expect(part?.commandChanges).toEqual(change);
    } finally {
      mockSdkGetSessionMessages.mockImplementation(async () => []);
      await commandChangeJournal(PERSISTED_SDK_ID)!.remove();
    }
  });

  test("overlayCommandChanges only touches tool calls it has a record for", () => {
    const change = { additions: 1, deletions: 0, files: [] };
    const messages = [
      {
        id: "m",
        role: "assistant" as const,
        content: "",
        createdAt: "",
        parts: [
          { type: "tool-invocation" as const, content: "Bash", toolUseId: "a" },
          { type: "tool-invocation" as const, content: "Bash", toolUseId: "b" },
          { type: "text" as const, content: "a" },
        ],
      },
    ];
    overlayCommandChanges(messages, new Map([["a", change]]));
    expect(messages[0]!.parts.map((part) => (part as NormalizedPart).commandChanges)).toEqual([
      change,
      undefined,
      undefined,
    ]);
  });
});
