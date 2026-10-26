import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  codexHome,
  harness,
  threadPayload,
  type Harness,
} from "./app-server-runtime-test-harness.js";
import { recordTypedPrompt } from "./sessions/typed-prompts.js";
import type { NormalizedMessage } from "./messages/types.js";

const TIDY_PATH = "/tmp/ws/.codex/skills/tidy/SKILL.md";

function writeUserPrompt(name: string, content: string): void {
  const dir = join(codexHome, "prompts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content);
}

function writeRollout(threadId: string, records: unknown[]): void {
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  writeFileSync(
    join(codexHome, "sessions", `${threadId}.jsonl`),
    `${[
      {
        type: "session_meta",
        payload: { id: threadId, cwd: "/tmp/ws", timestamp: "2026-10-26T12:00:00.000Z" },
      },
      ...records,
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
    "utf8",
  );
}

const user = (...texts: string[]) => ({
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: texts.map((text) => ({ type: "input_text", text })),
  },
});
const assistant = (text: string) => ({
  type: "response_item",
  payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
});
const turnContext = (turnId: string) => ({
  type: "turn_context",
  payload: { turn_id: turnId, cwd: "/tmp/ws" },
});

/** The text item of each `turn/start`, exactly as the bridge sent it. */
function sentTexts(h: Harness): string[] {
  return h
    .child()
    .requests.filter((request) => request.method === "turn/start")
    .map((request) => {
      const input = request.params.input as Array<{ type: string; text?: string }>;
      return input.find((item) => item.type === "text")!.text!;
    });
}

const userRows = (messages: NormalizedMessage[] | null) =>
  (messages ?? []).filter((message) => message.role === "user");

describe("resumed transcript of rewritten prompts", () => {
  test("shows each prompt as typed, as the live tab did", async () => {
    // A thread whose rollout app-server can no longer resume: the bridge
    // shows it from the parser and sends it as context with the next prompt.
    writeRollout("thread-gone", [user("Remember the parser constraint"), assistant("Kept.")]);
    writeUserPrompt("review", "---\nargument-hint: <target>\n---\nReview $ARGUMENTS and report.");
    let turn = 0;
    const handlers = {
      "skills/list": () => ({
        data: [
          {
            cwd: "/tmp/ws",
            errors: [],
            skills: [
              {
                name: "tidy",
                description: "Tidy the named thing",
                path: TIDY_PATH,
                scope: "repo",
                enabled: true,
                pluginId: null,
              },
            ],
          },
        ],
      }),
      "thread/resume": (params: Record<string, unknown>) => {
        if (params.threadId === "thread-gone") {
          const error = new Error("thread/resume: no rollout found for thread id thread-gone");
          (error as { rpcCode?: number }).rpcCode = -32600;
          throw error;
        }
        return { thread: threadPayload(String(params.threadId)) };
      },
      "turn/start": () => ({ turn: { id: `turn-${++turn}` } }),
    };
    const live = await harness(handlers);
    const resumedGone = await live.runtime.resumeSession({
      threadId: "thread-gone",
      mode: "build",
    });
    const sessionId = resumedGone!.sessionId;
    await live.runtime.getCommandCatalogue(sessionId);

    const prompts: Array<{ prompt: string; mode: "build" | "plan" }> = [
      // Recovered context: sent inside the replayed transcript.
      { prompt: "Continue now", mode: "build" },
      // Skill: sent as `$tidy the header` plus the skill binding.
      { prompt: "/skill:tidy the header", mode: "build" },
      // Prompt template: sent expanded.
      { prompt: "/review src/a.ts", mode: "build" },
      // Plan mode: sent behind the preamble, with no record kept.
      { prompt: "Plan the header", mode: "plan" },
      // A reminder the user typed, in plan mode and out of it, stays.
      { prompt: "<system-reminder>Keep mine</system-reminder>\n\nPlan it", mode: "plan" },
      { prompt: "<system-reminder>Mine too</system-reminder>", mode: "build" },
      // Both rewrites at once: a template in plan mode.
      { prompt: "/review src/b.ts", mode: "plan" },
    ];
    for (const [index, { prompt, mode }] of prompts.entries()) {
      await live.runtime.updateConfig(sessionId, { mode });
      const outcome = await live.runtime.prompt(sessionId, {
        prompt,
        requestId: `req-${index + 1}`,
        attachments: [],
      });
      expect(outcome).toMatchObject({ ok: true });
      live.child().notify("turn/completed", {
        threadId: "thread-1",
        turn: { id: `turn-${index + 1}`, status: "completed" },
      });
      await live.drain();
    }

    // The live rows of the new thread, each on its turn.
    const liveUsers = userRows(await live.runtime.getMessages(sessionId))
      .filter((message) => message.turnId)
      .map((message) => ({ content: message.content, turnId: message.turnId }));
    expect(liveUsers.map((row) => row.content)).toEqual(prompts.map((entry) => entry.prompt));

    // What the bridge sent is not what the user typed.
    const sent = sentTexts(live);
    expect(sent[0]).toContain("<recovered_conversation>");
    expect(sent[0]).toEndWith("Latest user request:\nContinue now");
    expect(sent[1]).toBe("$tidy the header");
    expect(sent[2]).toBe("Review src/a.ts and report.");
    expect(sent[3]).toStartWith("<system-reminder>\nYou are in Orkestrator plan mode.");
    expect(sent[6]).toEndWith("\n\nReview src/b.ts and report.");

    // The rollout keeps the sent text, plus Codex's own blocks and a turn
    // continued from the Codex CLI, which has no record of what was typed.
    writeRollout("thread-1", [
      ...sent.flatMap((text, index) => [
        turnContext(`turn-${index + 1}`),
        user(text),
        ...(index === 1
          ? [user("<skill>\n<name>tidy</name>\n<path>/skills/tidy/SKILL.md</path>\n</skill>")]
          : []),
        assistant(`Reply ${index + 1}.`),
      ]),
      turnContext("turn-cli"),
      user("$tidy from the CLI"),
      assistant("Tidied from the CLI."),
    ]);

    // Close the tab, then resume the thread from a fresh bridge.
    expect(await live.runtime.closeSessionRetaining(sessionId)).toBe("closed");
    const resumed = await harness(handlers);
    const session = await resumed.runtime.resumeSession({ threadId: "thread-1", mode: "build" });
    const resumedUsers = userRows(await resumed.runtime.getMessages(session!.sessionId)).map(
      (message) => ({ content: message.content, turnId: message.turnId }),
    );
    expect(resumedUsers).toEqual([
      ...liveUsers,
      { content: "$tidy from the CLI", turnId: "turn-cli" },
    ]);
  });

  test("a record applies only to the message it was written for", async () => {
    // Recorded for turn-1's `$tidy`, then the turn holds a steer and turn-2
    // sends the same text from another client.
    await recordTypedPrompt(codexHome, "thread-1", "turn-1", "$tidy now", "/skill:tidy now");
    await recordTypedPrompt(codexHome, "thread-1", "turn-3", "$tidy rewritten", "/skill:tidy");
    writeRollout("thread-1", [
      turnContext("turn-1"),
      user("$tidy now"),
      assistant("Working."),
      user("Also the footer"),
      assistant("Done."),
      turnContext("turn-2"),
      user("$tidy now"),
      assistant("Again."),
      turnContext("turn-3"),
      user("$tidy something else"),
      assistant("Different."),
    ]);
    const h = await harness();
    const session = await h.runtime.resumeSession({ threadId: "thread-1", mode: "build" });
    expect(userRows(await h.runtime.getMessages(session!.sessionId)).map((m) => m.content)).toEqual(
      ["/skill:tidy now", "Also the footer", "$tidy now", "$tidy something else"],
    );
  });

  test("a fork keeps its parent's typed prompts", async () => {
    await recordTypedPrompt(codexHome, "thread-1", "turn-1", "$tidy now", "/skill:tidy now");
    const rollout = [turnContext("turn-1"), user("$tidy now"), assistant("Tidied.")];
    writeRollout("thread-1", rollout);
    writeRollout("thread-fork", rollout);
    const h = await harness({
      "thread/fork": () => ({ thread: threadPayload("thread-fork") }),
    });
    const parent = await h.runtime.resumeSession({ threadId: "thread-1", mode: "build" });
    const fork = await h.runtime.forkSession(parent!.sessionId);
    expect(fork).toMatchObject({ outcome: "created", threadId: "thread-fork" });
    const forkSessionId = (fork as { sessionId: string }).sessionId;
    expect(userRows(await h.runtime.getMessages(forkSessionId)).map((m) => m.content)).toEqual([
      "/skill:tidy now",
    ]);
  });
});
