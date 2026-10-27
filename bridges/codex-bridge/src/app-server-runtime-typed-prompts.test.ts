import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  codexHome,
  harness,
  threadPayload,
  type Harness,
} from "./app-server-runtime-test-harness.js";
import {
  MAX_TYPED_PROMPT_CHARS,
  readTypedPrompt,
  recordTypedPrompt,
  typedPromptDigest,
  typedPromptRecordPath,
} from "./sessions/typed-prompts.js";
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
    writeUserPrompt("synthetic", "<skill>\n<name>template</name>\n</skill>");
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
      { prompt: "/synthetic", mode: "build" },
      { prompt: "/review image", mode: "build" },
    ];
    for (const [index, { prompt, mode }] of prompts.entries()) {
      await live.runtime.updateConfig(sessionId, { mode });
      const outcome = await live.runtime.prompt(sessionId, {
        prompt,
        requestId: `req-${index + 1}`,
        attachments:
          index === 8
            ? [{ path: "/tmp/ws/shot.png", filename: "shot.png", mimeType: "image/png" }]
            : [],
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
    const rows = userRows(await resumed.runtime.getMessages(session!.sessionId));
    expect(rows[8]?.parts.some((part) => part.type === "file")).toBe(true);
    expect(resumedUsers).toEqual([
      ...liveUsers,
      { content: "$tidy from the CLI", turnId: "turn-cli" },
    ]);
  });

  test.each([
    { mode: "build", prompt: "" },
    { mode: "plan", prompt: "" },
    { mode: "plan", prompt: "Continue with a plan" },
  ] as const)(
    "recovered context in $mode mode retains the typed row '$prompt'",
    async ({ mode, prompt }) => {
      writeRollout("thread-gone", [user("Remember the parser constraint"), assistant("Kept.")]);
      const live = await harness({
        "thread/resume": () => {
          const error = new Error("thread/resume: no rollout found for thread id thread-gone");
          (error as { rpcCode?: number }).rpcCode = -32600;
          throw error;
        },
      });
      const recovered = await live.runtime.resumeSession({ threadId: "thread-gone", mode });
      const sessionId = recovered!.sessionId;
      expect(
        await live.runtime.prompt(sessionId, { prompt, requestId: "recovered", attachments: [] }),
      ).toMatchObject({ ok: true });
      const sent = sentTexts(live)[0]!;
      expect(sent).toContain("<recovered_conversation>");
      if (mode === "plan") {
        expect(sent).toStartWith("<system-reminder>\nYou are in Orkestrator plan mode.");
      }
      const liveUsers = userRows(await live.runtime.getMessages(sessionId))
        .filter((message) => message.turnId)
        .map((message) => ({ content: message.content, turnId: message.turnId }));
      expect(liveUsers).toEqual([{ content: prompt, turnId: "turn-1" }]);
      expect(await readTypedPrompt(codexHome, "thread-1", "turn-1")).toMatchObject({
        typed: prompt,
      });
      live.child().notify("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      });
      await live.drain();
      writeRollout("thread-1", [turnContext("turn-1"), user(sent), assistant("Done.")]);
      expect(await live.runtime.closeSessionRetaining(sessionId)).toBe("closed");
      const fresh = await harness();
      const resumed = await fresh.runtime.resumeSession({ threadId: "thread-1", mode });
      const resumedUsers = userRows(await fresh.runtime.getMessages(resumed!.sessionId));
      expect(
        resumedUsers.map((message) => ({ content: message.content, turnId: message.turnId })),
      ).toEqual(liveUsers);
      expect(resumedUsers[0]!.parts.filter((part) => part.type === "file")).toEqual([]);
    },
  );

  test.each(["mkdir", "writeFile", "rename"] as const)(
    "%s failure does not reject dispatch and replay falls back to rollout text",
    async (operation) => {
      writeUserPrompt("review", "Expanded review request.");
      const live = await harness();
      const session = await live.runtime.createSession({ mode: "build" });
      const sessionId = session.sessionId;
      await live.runtime.getCommandCatalogue(sessionId);
      const path = typedPromptRecordPath(codexHome, "thread-1", "turn-1")!;
      let failures = 0;
      const fail = () => {
        failures += 1;
        throw new Error("display metadata unavailable");
      };
      const originalMkdir = fs.mkdir.bind(fs);
      const originalWriteFile = fs.writeFile.bind(fs);
      const originalRename = fs.rename.bind(fs);
      const mkdir = spyOn(fs, "mkdir").mockImplementation((directory, options) => {
        if (operation === "mkdir" && String(directory) === dirname(path)) fail();
        return originalMkdir(directory, options);
      });
      const write = spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
        if (operation === "writeFile" && String(file).startsWith(`${path}.`)) fail();
        return originalWriteFile(file, data, options);
      });
      const rename = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (operation === "rename" && String(destination) === path) fail();
        return originalRename(source, destination);
      });
      try {
        expect(
          await live.runtime.prompt(sessionId, {
            prompt: "/review",
            requestId: "failed-metadata",
            attachments: [],
          }),
        ).toMatchObject({ ok: true });
        // Wait for the background write to settle before restoring the spies.
        expect(await readTypedPrompt(codexHome, "thread-1", "turn-1")).toBeUndefined();
        expect(failures).toBe(1);
      } finally {
        mkdir.mockRestore();
        write.mockRestore();
        rename.mockRestore();
      }
      expect(await fs.readdir(dirname(path)).catch(() => [])).toEqual([]);
      expect(
        userRows(await live.runtime.getMessages(sessionId)).map((message) => message.content),
      ).toEqual(["/review"]);
      const sent = sentTexts(live);
      expect(sent).toEqual(["Expanded review request."]);
      live.child().notify("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      });
      await live.drain();
      writeRollout("thread-1", [turnContext("turn-1"), user(sent[0]!), assistant("Done.")]);
      expect(await live.runtime.closeSessionRetaining(sessionId)).toBe("closed");
      const fresh = await harness();
      const resumed = await fresh.runtime.resumeSession({ threadId: "thread-1", mode: "build" });
      expect(
        userRows(await fresh.runtime.getMessages(resumed!.sessionId)).map(
          (message) => message.content,
        ),
      ).toEqual(sent);
    },
  );

  test("an oversized per-turn record falls back to rollout text during replay", async () => {
    const path = typedPromptRecordPath(codexHome, "thread-1", "turn-1")!;
    mkdirSync(dirname(path), { recursive: true });
    // A valid record with enough trailing whitespace to exceed the byte bound.
    writeFileSync(
      path,
      JSON.stringify({ turnId: "turn-1", sent: typedPromptDigest("Expanded"), typed: "/review" }) +
        " ".repeat(6 * MAX_TYPED_PROMPT_CHARS + 2_049),
    );
    await recordTypedPrompt(codexHome, "thread-1", "turn-2", "Next expanded", "/next");
    writeRollout("thread-1", [
      turnContext("turn-1"),
      user("Expanded"),
      assistant("Done."),
      turnContext("turn-2"),
      user("Next expanded"),
      assistant("Done again."),
    ]);
    const fresh = await harness();
    const resumed = await fresh.runtime.resumeSession({ threadId: "thread-1", mode: "build" });
    expect(
      userRows(await fresh.runtime.getMessages(resumed!.sessionId)).map(
        (message) => message.content,
      ),
    ).toEqual(["Expanded", "/next"]);
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
      user("$tidy now"),
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
      ["/skill:tidy now", "$tidy now", "$tidy now", "$tidy something else"],
    );
  });

  test("full replay retains the earliest and latest rewritten turns beyond the old cap", async () => {
    const records: unknown[] = [];
    for (let i = 0; i < 1005; i += 1) {
      await recordTypedPrompt(codexHome, "long-thread", `turn-${i}`, `expanded ${i}`, `/t ${i}`);
      records.push(turnContext(`turn-${i}`), user(`expanded ${i}`), assistant("done"));
    }
    writeRollout("long-thread", records);
    for (let restart = 0; restart < 2; restart += 1) {
      const h = await harness();
      const session = await h.runtime.resumeSession({ threadId: "long-thread", mode: "build" });
      const rows = userRows(await h.runtime.getMessages(session!.sessionId));
      expect(rows.map((row) => row.content)).toEqual(
        Array.from({ length: 1005 }, (_, i) => `/t ${i}`),
      );
      await h.runtime.closeSessionRetaining(session!.sessionId);
    }
  }, 30_000);

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
