import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChangeEvidenceEntry,
  ProviderEvidence,
  ProviderEvidenceFrame,
  WorkspaceObservationReport,
} from "@orkestrator/protocol/change-evidence";
// The harness installs its module mocks on evaluation, so it loads first.
import {
  createSession,
  nextQueryCall,
  sendPrompt,
  track,
  waitFor,
} from "./session-manager-test-harness.js";
import {
  claudeChangeCapabilities,
  claudeChangeEvidence,
  claudeToolKind,
  detectCaptureExecutor,
  recordClaudeToolResult,
  recordClaudeToolUse,
  resetClaudeChangeEvidenceForTesting,
} from "./change-evidence.js";
import { coordinatorProcessPolicy } from "./read-only-policy.js";

type Hook = (
  input: Record<string, unknown>,
  toolUseId: string | undefined,
  options: unknown,
) => Promise<unknown>;
type Hooks = Record<string, Array<{ matcher?: string; hooks: Hook[] }>>;

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "claude-change-evidence-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "bridge@example.com");
  git("config", "user.name", "Bridge");
  writeFileSync(join(repo, "notes.txt"), "one\ntwo\n");
  git("add", "-A");
  git("commit", "-qm", "init");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

beforeEach(() => {
  resetClaudeChangeEvidenceForTesting({ executor: "host-worker" });
});

function entries(): ChangeEvidenceEntry[] {
  return claudeChangeEvidence().spool.read(0, 1_000).entries;
}

function toolFrames(callId: string): ProviderEvidenceFrame[] {
  return entries().flatMap((entry) =>
    entry.type === "frame" &&
    entry.frame.source.callId === callId &&
    entry.frame.event.kind === "tool"
      ? [entry.frame]
      : [],
  );
}

function observations(callId: string): WorkspaceObservationReport[] {
  return entries().flatMap((entry) =>
    entry.type === "observation" && entry.report.source.callId === callId ? [entry.report] : [],
  );
}

function toolEvent(frame: ProviderEvidenceFrame) {
  if (frame.event.kind !== "tool") throw new Error("not a tool frame");
  return frame.event;
}

function replacements(frame: ProviderEvidenceFrame) {
  return toolEvent(frame).evidence.map((update) => {
    if (update.kind !== "replace" || update.evidence.kind !== "replacement") {
      throw new Error("expected a replacement");
    }
    return { key: update.evidenceKey, evidence: update.evidence };
  });
}

function bodyText(side: Extract<ProviderEvidence, { kind: "replacement" }>["before"]) {
  if (side.state !== "present") return side;
  return new TextDecoder().decode(claudeChangeEvidence().spool.readBody(side.body.id)!);
}

/** Claude-native `tool_use` fixtures, as the CLI writes them. */
const fixtures = {
  edit: {
    callId: "toolu_edit",
    toolName: "Edit",
    input: { file_path: "/w/a.ts", old_string: "let a = 1;\n", new_string: "let a = 2;\n" },
  },
  write: {
    callId: "toolu_write",
    toolName: "Write",
    input: { file_path: "/w/new.ts", content: "export {};\n" },
  },
  multiEdit: {
    callId: "toolu_multi",
    toolName: "MultiEdit",
    input: {
      file_path: "/w/b.ts",
      edits: [
        { old_string: "first", new_string: "1st" },
        { old_string: "second", new_string: "2nd", replace_all: true },
      ],
    },
  },
  notebook: {
    callId: "toolu_nb",
    toolName: "NotebookEdit",
    input: { notebook_path: "/w/n.ipynb", cell_id: "c1", new_source: "print(1)\n" },
  },
};

describe("Claude tool proposals", () => {
  test("an Edit is one fragment replacement with input provenance", () => {
    recordClaudeToolUse("session-a", { ...fixtures.edit, turnId: "turn-1" });
    const [frame] = toolFrames("toolu_edit");
    expect(frame!.source).toMatchObject({
      conversationId: "session-a",
      callId: "toolu_edit",
      turnId: "turn-1",
      mode: "live",
    });
    expect(toolEvent(frame!)).toMatchObject({
      toolKind: "file-edit",
      phase: "running",
      executionOccurrence: "unknown",
    });
    const [block] = replacements(frame!);
    expect(block!.evidence).toMatchObject({
      path: "/w/a.ts",
      extent: "fragment",
      origin: "input",
      effectClaim: "proposal",
    });
    expect(bodyText(block!.evidence.before)).toBe("let a = 1;\n");
    expect(bodyText(block!.evidence.after)).toBe("let a = 2;\n");
  });

  test("a Write's before side is unknown, never an empty file", () => {
    recordClaudeToolUse("session-a", fixtures.write);
    const [block] = replacements(toolFrames("toolu_write")[0]!);
    expect(toolEvent(toolFrames("toolu_write")[0]!).toolKind).toBe("file-write");
    expect(block!.evidence.before).toEqual({ state: "unknown", reason: "before-not-captured" });
    expect(block!.evidence.extent).toBe("whole-file");
    expect(bodyText(block!.evidence.after)).toBe("export {};\n");
  });

  test("a MultiEdit keeps one ordered block per edit", () => {
    recordClaudeToolUse("session-a", fixtures.multiEdit);
    const blocks = replacements(toolFrames("toolu_multi")[0]!);
    expect(blocks.map((block) => block.key)).toEqual(["edit:0", "edit:1"]);
    expect(blocks.map((block) => bodyText(block.evidence.before))).toEqual(["first", "second"]);
    expect(blocks.map((block) => bodyText(block.evidence.after))).toEqual(["1st", "2nd"]);
    expect(blocks.every((block) => block.evidence.extent === "fragment")).toBe(true);
  });

  test("a NotebookEdit is a cell replacement with an unknown before side", () => {
    recordClaudeToolUse("session-a", fixtures.notebook);
    const [block] = replacements(toolFrames("toolu_nb")[0]!);
    expect(toolEvent(toolFrames("toolu_nb")[0]!).toolKind).toBe("notebook-edit");
    expect(block!.evidence).toMatchObject({ path: "/w/n.ipynb", extent: "notebook-cell" });
    expect(block!.evidence.before.state).toBe("unknown");
    expect(bodyText(block!.evidence.after)).toBe("print(1)\n");
  });

  test("tool kinds follow Claude's tool names", () => {
    expect(
      ["Bash", "Edit", "MultiEdit", "Write", "NotebookEdit", "Read", "Grep", "Glob", "Task"].map(
        claudeToolKind,
      ),
    ).toEqual([
      "shell",
      "file-edit",
      "file-edit",
      "file-write",
      "notebook-edit",
      "read",
      "read",
      "read",
      "other",
    ]);
  });

  test("a completion delivered twice is spooled once, with the proposal unchanged", () => {
    recordClaudeToolUse("session-a", fixtures.edit);
    recordClaudeToolResult("toolu_edit", false);
    recordClaudeToolResult("toolu_edit", false);
    const frames = toolFrames("toolu_edit");
    expect(frames.map((frame) => toolEvent(frame).phase)).toEqual(["running", "succeeded"]);
    // Same blocks, same revisions: the result never supersedes the proposal.
    expect(toolEvent(frames[1]!).evidence).toEqual(toolEvent(frames[0]!).evidence);
  });

  test("a result for a call this process never saw start is not guessed at", () => {
    recordClaudeToolResult("toolu_unknown", false);
    expect(toolFrames("toolu_unknown")).toEqual([]);
  });
});

describe("Claude capabilities", () => {
  test("declare what the bridge establishes", () => {
    const declared = claudeChangeEvidence().spool.read(0).capabilities;
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({
      ...claudeChangeCapabilities("host-worker"),
      beforeTool: "awaited",
      afterTool: "awaited",
      beforeTurn: "controlled-dispatch",
      afterTurn: "terminal-observed",
      historicalCallIdentity: "stable",
      turnDiff: "absent",
      backgroundCompletion: "launch-only",
      captureExecutor: "host-worker",
    });
  });

  test("the executor follows the container marker", () => {
    expect(detectCaptureExecutor((path) => path === "/.dockerenv")).toBe("container-worker");
    expect(detectCaptureExecutor((path) => path === "/run/.containerenv")).toBe("container-worker");
    expect(detectCaptureExecutor(() => false)).toBe("host-worker");
  });
});

// ---------------------------------------------------------------------------
// Live turns through the bridge's own handlers and hooks
// ---------------------------------------------------------------------------

function hookCaller(hooks: Hooks, event: string) {
  return async (input: Record<string, unknown>) => {
    const outputs: unknown[] = [];
    for (const matcher of hooks[event] ?? []) {
      if (matcher.matcher && !new RegExp(matcher.matcher).test(String(input.tool_name))) continue;
      for (const hook of matcher.hooks) {
        outputs.push(
          await hook({ hook_event_name: event, cwd: repo, ...input }, String(input.tool_use_id), {
            signal: new AbortController().signal,
          }),
        );
      }
    }
    return outputs;
  };
}

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  };
}

function toolResult(id: string, isError = false) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "out", is_error: isError }],
    },
  };
}

async function startTurn(name: string, readOnly = false) {
  const session = createSession(name);
  if (readOnly) session.executionPolicy = coordinatorProcessPolicy();
  track(session.id);
  const prompt = sendPrompt(session.id, "go", { requestId: `request-${name}` });
  const call = await nextQueryCall();
  const hooks = call.options.hooks as Hooks;
  return {
    sessionId: session.id,
    call,
    hooks,
    pre: hookCaller(hooks, "PreToolUse"),
    post: hookCaller(hooks, "PostToolUse"),
    postFailure: hookCaller(hooks, "PostToolUseFailure"),
    finish: async () => {
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await prompt;
    },
  };
}

describe("Claude evidence from a live turn", () => {
  test("the measuring hook runs after the denying hooks and before shell capture", async () => {
    const turn = await startTurn("evidence-hook-order");
    // Stale-MCP refusal, command-change measuring, shell-task capture: a call
    // a refusing hook denies is decided before any window opens.
    expect(turn.hooks.PreToolUse!.map((matcher) => matcher.matcher)).toEqual([
      undefined,
      "^(Bash|Edit|Write|MultiEdit|NotebookEdit)$",
      "^Bash$",
    ]);
    expect(turn.hooks.PostToolUseFailure!.map((matcher) => matcher.matcher)).toEqual([
      "^(Bash|Edit|Write|MultiEdit|NotebookEdit)$",
      "^Bash$",
    ]);
    await turn.finish();
  });

  test("a denied call is denied and did-not-run, keeps its proposal, and is never observed", async () => {
    const turn = await startTurn("evidence-denied");
    const input = { file_path: join(repo, "notes.txt"), old_string: "one", new_string: "uno" };
    turn.call.push(toolUse("edit-denied", "Edit", input));
    await waitFor(() => toolFrames("edit-denied").length > 0);
    await turn.pre({ tool_name: "Edit", tool_input: input, tool_use_id: "edit-denied" });
    turn.call.push({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Edit",
      tool_use_id: "edit-denied",
      message: "Permission denied",
    });
    turn.call.push(toolResult("edit-denied", true));
    await waitFor(() => toolFrames("edit-denied").some((f) => toolEvent(f).phase === "denied"));
    await turn.finish();

    const frames = toolFrames("edit-denied");
    expect(
      frames.map((frame) => [toolEvent(frame).phase, toolEvent(frame).executionOccurrence]),
    ).toEqual([
      ["running", "unknown"],
      ["denied", "did-not-run"],
    ]);
    expect(frames[1]!.source.conversationId).toBe(turn.sessionId);
    const [block] = replacements(frames[1]!);
    expect(block!.evidence.effectClaim).toBe("proposal");
    expect(observations("edit-denied")).toEqual([]);
  });

  test("a PreToolUse hook's refusal is a denial, and its error result is not a failure", async () => {
    const turn = await startTurn("evidence-hook-denied", true);
    const call = {
      tool_name: "Bash",
      tool_input: { command: "echo changed > notes.txt" },
      tool_use_id: "bash-hook-denied",
    };
    turn.call.push(toolUse("bash-hook-denied", "Bash", call.tool_input));
    await waitFor(() => toolFrames("bash-hook-denied").length > 0);
    const [decision] = await hookCaller(
      { PreToolUse: [turn.hooks.PreToolUse![0]!] },
      "PreToolUse",
    )(call);
    expect(decision).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    turn.call.push(toolResult("bash-hook-denied", true));
    // The stream is consumed in order, so the result is handled before the turn ends.
    await turn.finish();
    expect(
      toolFrames("bash-hook-denied").map((frame) => [
        toolEvent(frame).phase,
        toolEvent(frame).executionOccurrence,
      ]),
    ).toEqual([
      ["running", "unknown"],
      ["denied", "did-not-run"],
    ]);
    expect(observations("bash-hook-denied")).toEqual([]);
  });

  test("a failed Bash that changed files is failed, started and observed", async () => {
    const turn = await startTurn("evidence-failed-bash");
    const call = {
      tool_name: "Bash",
      tool_input: { command: "append && false" },
      tool_use_id: "bash-failed",
      session_id: "sdk-failed",
    };
    turn.call.push(toolUse("bash-failed", "Bash", call.tool_input));
    await waitFor(() => toolFrames("bash-failed").length > 0);
    await turn.pre(call);
    writeFileSync(join(repo, "notes.txt"), "one\ntwo\nthree\n");
    await turn.postFailure({ ...call, error: "exit code 1" });
    turn.call.push(toolResult("bash-failed", true));
    await waitFor(() => toolFrames("bash-failed").some((f) => toolEvent(f).phase === "failed"));
    await turn.finish();

    const frames = toolFrames("bash-failed");
    expect(toolEvent(frames.at(-1)!)).toMatchObject({
      toolKind: "shell",
      phase: "failed",
      executionOccurrence: "started",
      evidence: [],
    });
    const [report] = observations("bash-failed");
    expect(report).toMatchObject({
      source: {
        conversationId: turn.sessionId,
        callId: "bash-failed",
        turnId: "request-evidence-failed-bash",
      },
      executor: "host-worker",
      boundary: { before: "fresh-before", after: "after-terminal" },
      overlap: "none-observed",
      outcome: { kind: "measured", additions: 1, deletions: 0, changedFiles: 1 },
    });
  });

  test("a background launch is launch-only: no observation", async () => {
    const turn = await startTurn("evidence-background");
    const call = {
      tool_name: "Bash",
      tool_input: { command: "sleep 1", run_in_background: true },
      tool_use_id: "bash-bg",
    };
    turn.call.push(toolUse("bash-bg", "Bash", call.tool_input));
    await turn.pre(call);
    await turn.post({ ...call, tool_response: { backgroundTaskId: "task-1" } });
    turn.call.push(toolResult("bash-bg"));
    await waitFor(() => toolFrames("bash-bg").some((f) => toolEvent(f).phase === "succeeded"));
    await turn.finish();
    expect(observations("bash-bg")).toEqual([]);
    expect(toolEvent(toolFrames("bash-bg").at(-1)!).backgroundTaskId).toBe("task-1");
  });

  test("a turn reports running, then how it ended", async () => {
    const turn = await startTurn("evidence-turn");
    await turn.finish();
    const turns = entries().flatMap((entry) =>
      entry.type === "frame" && entry.frame.event.kind === "turn" ? [entry.frame] : [],
    );
    expect(turns.map((frame) => frame.source.turnId)).toEqual([
      "request-evidence-turn",
      "request-evidence-turn",
    ]);
    expect(turns.map((frame) => frame.event)).toEqual([
      { kind: "turn", phase: "running", writerLiveness: "may-write" },
      { kind: "turn", phase: "succeeded", writerLiveness: expect.any(String) },
    ]);
    expect(turns[1]!.event).not.toMatchObject({ writerLiveness: "may-write" });
  });
});
