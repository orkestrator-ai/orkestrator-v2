import { describe, expect, test } from "bun:test";
import {
  duplicatedContent,
  lostContent,
  sameDisplayedRows,
  trailOrder,
  trailStopsRead,
  type Row,
} from "../../e2e/agent-testing/cold-restart-evidence";

const prompt: Row = { id: "user", role: "user", content: "Follow the trail" };
const reply = (id: string, content: string): Row => ({
  id,
  role: "assistant",
  content,
  parts: [{ type: "text", content }],
});
const tool = (id: string, stop = 1): Row => ({
  id,
  role: "assistant",
  content: "",
  parts: [
    {
      type: "tool-invocation",
      toolUseId: id,
      toolName: "cat",
      toolArgs: { stop },
      toolState: "success",
      toolOutput: "result",
    },
  ],
});
const reads = (row: Row): number[] =>
  ((row.parts as Array<{ toolArgs?: { stop: number } }>) ?? []).flatMap((part) =>
    part.toolArgs ? [part.toolArgs.stop] : [],
  );
const trail = { dir: "trail", stopsRead: reads };

describe("cold restart evidence", () => {
  test("matching ids cannot certify stale text or tool parts", () => {
    expect(sameDisplayedRows([reply("same", "old")], [reply("same", "new")])).toBe(false);
    expect(sameDisplayedRows([tool("same", 1)], [tool("same", 2)])).toBe(false);
    const pending = structuredClone(tool("same"));
    (pending.parts as Array<Record<string, unknown>>)[0]!.toolState = "pending";
    expect(sameDisplayedRows([pending], [tool("same")])).toBe(false);
  });

  test("only documented timing and envelope metadata are volatile", () => {
    const old = { ...tool("same"), createdAt: "old", revision: 1 };
    const next = { ...tool("same"), createdAt: "new", revision: 2 };
    Object.assign((old.parts as object[])[0]!, {
      createdAt: "old",
      toolDurationMs: 10,
      elapsedMs: 1,
    });
    Object.assign((next.parts as object[])[0]!, {
      createdAt: "new",
      toolDurationMs: 11,
      elapsedMs: 2,
    });
    expect(sameDisplayedRows([old], [next])).toBe(true);
    // The same key inside tool input is user-visible data, not volatile metadata.
    (next.parts as Array<Record<string, unknown>>)[0]!.toolArgs = { stop: 1, createdAt: "changed" };
    expect(sameDisplayedRows([old], [next])).toBe(false);
  });

  test("re-keyed duplicate intermediate prose and tools fail occurrence checks", () => {
    const before = [prompt, reply("a", "Reached stop one."), tool("b")];
    expect(
      duplicatedContent(before, [...before, reply("c", "Reached stop one."), tool("d")]),
    ).toEqual({ replies: 1, tools: 1 });
    expect(trailOrder([...before, tool("d")], reads).duplicates).toBe(1);
  });

  test("legitimate row splitting and streaming growth preserve content once", () => {
    const before = [prompt, reply("a", "Reached stop one. Reading next."), tool("b")];
    const after = [
      prompt,
      reply("new-a", "Reached stop one."),
      reply("new-b", "Reading next. More text."),
      tool("new-c"),
    ];
    expect(duplicatedContent(before, after)).toEqual({ replies: 0, tools: 0 });
    expect(duplicatedContent(before, [...after, reply("duplicate", "Reached stop one.")])).toEqual({
      replies: 1,
      tools: 0,
    });
    expect(lostContent(before, after, [trail])).toEqual({ prompts: 0, stops: 0, replies: 0 });
  });

  test("streamed parts may grow without requiring artificial adjacency between responses", () => {
    const before = [prompt, reply("a", "Thinking"), reply("b", "Then proceed.")];
    const after = [
      prompt,
      reply("a-new", "Thinking through the next step."),
      reply("b-new", "Then proceed."),
    ];
    expect(lostContent(before, after, [])).toEqual({ prompts: 0, stops: 0, replies: 0 });
    expect(duplicatedContent(before, after)).toEqual({ replies: 0, tools: 0 });
  });

  test("unpunctuated intermediate responses still count after replay merges rows", () => {
    const before = [prompt, reply("a", "stop one reached"), reply("b", "reading the next file")];
    const merged = [prompt, reply("merged", "stop one reached reading the next file")];
    expect(duplicatedContent(before, merged)).toEqual({ replies: 0, tools: 0 });
    expect(duplicatedContent(before, [...merged, reply("duplicate", "stop one reached")])).toEqual({
      replies: 1,
      tools: 0,
    });
  });

  test("a follow-up may intentionally re-read, but duplicates within it still fail", () => {
    const before = [prompt, reply("a", "Reached stop one."), tool("b")];
    const after = [
      ...before,
      { ...prompt, id: "follow-up", content: "Continue" },
      reply("c", "Reached stop one."),
      tool("d"),
      tool("e", 2),
    ];
    expect(duplicatedContent(before, after)).toEqual({ replies: 0, tools: 0 });
    expect(trailOrder(after, reads)).toEqual({ highest: 2, outOfOrder: 0, duplicates: 0 });
    expect(trailOrder([...after, tool("f", 2)], reads).duplicates).toBe(1);
  });

  test("Codex live and rollout trail commands normalize without hiding duplicate calls or output", () => {
    const file = "trail-a1b2c3/0123456789.txt";
    const live: Row = {
      role: "assistant",
      parts: [
        {
          type: "tool-invocation",
          toolName: "bash",
          content: `cat ${file}`,
          toolArgs: { command: `cat ${file}` },
          toolOutput: "Trail stop 1",
        },
      ],
    };
    const replay: Row = {
      role: "assistant",
      parts: [
        {
          type: "tool-invocation",
          toolName: "exec_command",
          content: "exec_command",
          toolArgs: {
            cmd: `cat ${file}`,
            command: `cat ${file}`,
            workdir: "/fixture",
            yield_time_ms: 1000,
          },
          toolOutput:
            "Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 0\nFinal output:\nTrail stop 1\n",
        },
      ],
    };
    expect(lostContent([live], [replay], []).replies).toBe(0);
    expect(lostContent([replay], [live], []).replies).toBe(0);
    expect(duplicatedContent([live], [replay, replay])).toEqual({ tools: 1, replies: 0 });
    expect(sameDisplayedRows([live], [replay])).toBe(false);
    const codeMode: Row = {
      role: "assistant",
      parts: [
        {
          type: "tool-invocation",
          toolName: "exec",
          content: "exec",
          toolArgs: {
            input: `await tools.exec_command({cmd:"cat ${file}"})`,
            command: `cat ${file}`,
          },
          toolOutput: "Trail stop 1",
        },
      ],
    };
    expect(lostContent([live], [codeMode], []).replies).toBe(0);
    expect(lostContent([codeMode], [live], []).replies).toBe(0);
    expect(duplicatedContent([live], [codeMode, codeMode])).toEqual({ tools: 1, replies: 0 });
    const positions = new Map([["0123456789.txt", 1]]);
    expect(trailStopsRead(codeMode, positions)).toEqual([1]);
    expect(
      trailStopsRead(
        { parts: [...(codeMode.parts as object[]), ...(codeMode.parts as object[])] },
        positions,
      ),
    ).toEqual([1, 1]);
    const compound = structuredClone(live);
    (compound.parts as Array<Record<string, unknown>>)[0]!.toolArgs = {
      command: `cat ${file}; echo changed`,
    };
    expect(lostContent([live], [compound], []).replies).toBe(1);
  });

  test("new model steps after the replay frontier may repeat prose, while replay duplicates fail", () => {
    const before = [prompt, reply("a", "Reading the next file."), tool("b", 1), reply("c", "I")];
    const progress = [
      prompt,
      reply("a-new", "Reading the next file."),
      tool("b-new", 1),
      reply("c-new", "Reading the next file. I think I will read it."),
      tool("d", 2),
    ];
    expect(duplicatedContent(before, progress)).toEqual({ replies: 0, tools: 0 });
    const duplicate = [
      prompt,
      reply("a-new", "Reading the next file."),
      reply("extra", "Reading the next file."),
      tool("b-new", 1),
      ...progress.slice(3),
    ];
    expect(duplicatedContent(before, duplicate).replies).toBe(1);
  });

  test("cached tool output may grow and move into the terminal error field", () => {
    const pending = tool("old");
    const failed = structuredClone(tool("new"));
    Object.assign((failed.parts as Array<Record<string, unknown>>)[0]!, {
      toolOutput: undefined,
      toolError: "result followed by failure",
      toolState: "failure",
    });
    expect(lostContent([pending], [failed], [])).toEqual({ prompts: 0, stops: 0, replies: 0 });
    expect(sameDisplayedRows([pending], [failed])).toBe(false);
  });

  test("cached content must be a counted subset even when replay re-keys rows", () => {
    const cached = [prompt, reply("old", "Reached stop one."), tool("old-tool")];
    const provider = [prompt, reply("new", "Reached stop one. Next step."), tool("new-tool")];
    expect(lostContent(cached, provider, [trail])).toEqual({ prompts: 0, stops: 0, replies: 0 });
    expect(lostContent([...cached, tool("phantom", 2)], provider, [trail]).stops).toBe(1);
    expect(
      lostContent([...cached, reply("phantom", "Absent content")], provider, [trail]).replies,
    ).toBe(1);
    const staleOutput = structuredClone(tool("old-tool"));
    (staleOutput.parts as Array<Record<string, unknown>>)[0]!.toolOutput = "phantom output";
    expect(lostContent([staleOutput], provider, [trail]).replies).toBe(1);
    expect(
      lostContent([...cached, reply("duplicate", "Reached stop one.")], provider, [trail]).replies,
    ).toBe(1);
  });
});
