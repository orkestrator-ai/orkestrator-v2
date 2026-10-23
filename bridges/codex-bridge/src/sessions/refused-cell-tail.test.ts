import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RefusedCellTail,
  codeModeCellOutcome,
  reportsRefusal,
  type RefusedCell,
  type RefusedCellTailOptions,
} from "./refused-cell-tail.js";

const TURN = "turn-1";
const BASE_MS = Date.parse("2026-10-17T14:53:40.000Z");

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function rolloutPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "refused-cell-tail-"));
  roots.push(root);
  return join(root, "rollout-2026-10-17T14-53-40-thread-1.jsonl");
}

function record(ms: number, payload: Record<string, unknown>, turnId = TURN): string {
  return `${JSON.stringify({
    timestamp: new Date(BASE_MS + ms).toISOString(),
    type: "response_item",
    payload: { ...payload, internal_chat_message_metadata_passthrough: { turn_id: turnId } },
  })}\n`;
}

function cell(id: string, source: string, ms: number, turnId?: string): string {
  return record(
    ms,
    { type: "custom_tool_call", call_id: id, name: "exec", input: source, status: "completed" },
    turnId,
  );
}

function output(id: string, texts: string[], ms: number, turnId?: string): string {
  return record(
    ms,
    {
      type: "custom_tool_call_output",
      call_id: id,
      output: texts.map((text) => ({ type: "input_text", text })),
    },
    turnId,
  );
}

const TOUCH = 'text(await tools.exec_command({cmd:"touch coordinator-live-shell.txt"}));';
const REFUSED_TOUCH =
  '{"exit_code":1,"output":"touch: coordinator-live-shell.txt: Operation not permitted\\n"}';

function tailFor(
  path: string,
  overrides: Partial<RefusedCellTailOptions> = {},
): { tail: RefusedCellTail; cells: RefusedCell[] } {
  const cells: RefusedCell[] = [];
  const tail = new RefusedCellTail({
    path,
    turnId: TURN,
    onCell: (found) => cells.push(found),
    itemStartedBetween: () => false,
    watch: () => ({ close: () => undefined }),
    ...overrides,
  });
  return { tail, cells };
}

describe("RefusedCellTail", () => {
  test("a cell nothing else shows is reported, failed when the model was told of a refusal", async () => {
    const path = await rolloutPath();
    // An earlier turn's cell is before the tail starts and never reported.
    await writeFile(
      path,
      cell("old", TOUCH, 0, "turn-0") + output("old", [REFUSED_TOUCH], 10, "turn-0"),
    );
    const { tail, cells } = tailFor(path);
    await tail.poll();

    await appendFile(
      path,
      cell("patch", 'text(await tools.apply_patch("*** Add File: x"));', 1_000) +
        output(
          "patch",
          [
            "Script failed\nWall time 0.0 seconds\nOutput:\n",
            "Script error:\npatch rejected: writing is blocked by read-only sandbox",
          ],
          1_100,
        ) +
        cell("lookup", "text(ALL_TOOLS.map((tool) => tool.name));", 2_000) +
        output("lookup", ["Script completed\nOutput:\n", '["exec_command"]'], 2_050),
    );
    await tail.poll();

    expect(cells).toEqual([
      {
        callId: "patch",
        source: 'text(await tools.apply_patch("*** Add File: x"));',
        output:
          "Script failed\nWall time 0.0 seconds\nOutput:\n\nScript error:\npatch rejected: writing is blocked by read-only sandbox",
        failed: true,
        startedAtMs: BASE_MS + 1_000,
        completedAtMs: BASE_MS + 1_100,
      },
      {
        callId: "lookup",
        source: "text(ALL_TOOLS.map((tool) => tool.name));",
        output: 'Script completed\nOutput:\n\n["exec_command"]',
        failed: false,
        startedAtMs: BASE_MS + 2_000,
        completedAtMs: BASE_MS + 2_050,
      },
    ]);
  });

  test("a cell an interrupt stopped is never reported, even with no item", async () => {
    const path = await rolloutPath();
    await writeFile(path, "");
    const { tail, cells } = tailFor(path);
    await tail.poll();
    // Codex 0.164 records a user stop as the cell's whole output.
    await appendFile(
      path,
      cell("stopped", "while (true) {}", 1_000) +
        record(2_500, {
          type: "custom_tool_call_output",
          call_id: "stopped",
          output: "aborted by user after 1.5s",
        }),
    );
    await tail.poll();

    expect(cells).toEqual([]);
    expect(codeModeCellOutcome("aborted by user after 1.5s")).toEqual({
      refused: false,
      failed: false,
      interrupted: true,
    });
    // A refusal is still a refusal, whatever else the output says.
    expect(codeModeCellOutcome("aborted by user: Operation not permitted").interrupted).toBe(false);
  });

  test("a cell whose calls produced items is left alone unless its output reports a refusal", async () => {
    const path = await rolloutPath();
    await writeFile(path, "");
    const windows: Array<[number, number]> = [];
    const { tail, cells } = tailFor(path, {
      itemStartedBetween: (fromMs, toMs) => {
        windows.push([fromMs, toMs]);
        return true;
      },
    });
    await tail.poll();
    await appendFile(
      path,
      cell("listed", 'text(await tools.exec_command({cmd:"ls"}));', 1_000) +
        output(
          "listed",
          ["Script completed\nOutput:\n", '{"exit_code":0,"output":"README.md"}'],
          1_200,
        ) +
        // As a live Codex turn wrote it: the touch is refused, commit has an item.
        cell("grouped", `${TOUCH}\ntext(await tools.exec_command({cmd:"git commit"}));`, 2_000) +
        output("grouped", ["Script completed\nOutput:\n", REFUSED_TOUCH], 2_500),
    );
    await tail.poll();

    expect(cells.map(({ callId, failed }) => ({ callId, failed }))).toEqual([
      { callId: "grouped", failed: true },
    ]);
    expect(windows).toEqual([
      [BASE_MS + 1_000, BASE_MS + 1_200],
      [BASE_MS + 2_000, BASE_MS + 2_500],
    ]);
  });

  test("another turn's records, a partial line and a repeated output are not reported twice", async () => {
    const path = await rolloutPath();
    await writeFile(path, "");
    const { tail, cells } = tailFor(path);
    await tail.poll();

    const line = output("refused", [REFUSED_TOUCH], 1_100);
    await appendFile(
      path,
      cell("other", TOUCH, 500, "turn-0") +
        output("other", [REFUSED_TOUCH], 600, "turn-0") +
        cell("refused", TOUCH, 1_000) +
        line.slice(0, 40),
    );
    await tail.poll();
    expect(cells).toEqual([]);

    await appendFile(path, line.slice(40) + line);
    await tail.poll();
    await tail.poll();
    expect(cells.map((found) => found.callId)).toEqual(["refused"]);
  });

  test("the watch starts with the first read, drives reads, and stops at close", async () => {
    const path = await rolloutPath();
    const changes: Array<() => void> = [];
    let closed = 0;
    const { tail, cells } = tailFor(path, {
      watch: (_watched, onChange) => {
        changes.push(onChange);
        return { close: () => (closed += 1) };
      },
    });
    // A new thread's rollout does not exist when its first turn starts.
    await tail.poll();
    expect(changes).toHaveLength(1);

    await writeFile(path, cell("first", TOUCH, 1_000) + output("first", [REFUSED_TOUCH], 1_100));
    changes[0]!();
    await tail.busy();
    expect(cells.map((found) => found.callId)).toEqual(["first"]);

    await appendFile(path, cell("second", TOUCH, 2_000) + output("second", [REFUSED_TOUCH], 2_100));
    // An item event polls too, without starting a second watch.
    await tail.poll();
    expect(changes).toHaveLength(1);
    expect(cells.map((found) => found.callId)).toEqual(["first", "second"]);

    await appendFile(path, cell("third", TOUCH, 3_000) + output("third", [REFUSED_TOUCH], 3_100));
    await tail.finish();
    expect(cells.map((found) => found.callId)).toEqual(["first", "second", "third"]);
    expect(closed).toBe(1);

    await appendFile(path, cell("late", TOUCH, 4_000) + output("late", [REFUSED_TOUCH], 4_100));
    changes[0]!();
    await tail.busy();
    expect(cells).toHaveLength(3);
  });

  test("the production timer reads appends, finish reads once more, and close stops it", async () => {
    const path = await rolloutPath();
    await writeFile(path, "");
    const { tail, cells } = tailFor(path, { watch: undefined });
    let polls = 0;
    const poll = tail.poll.bind(tail);
    tail.poll = () => {
      polls += 1;
      return poll();
    };
    await tail.poll();
    try {
      await appendFile(path, cell("timer", TOUCH, 100) + output("timer", [REFUSED_TOUCH], 200));
      const deadline = Date.now() + 2_000;
      while (cells.length === 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(cells).toHaveLength(1);
      await appendFile(path, cell("final", TOUCH, 300) + output("final", [REFUSED_TOUCH], 400));
      await tail.finish();
      const pollsAtFinish = polls;
      await appendFile(path, cell("late", TOUCH, 500) + output("late", [REFUSED_TOUCH], 600));
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(tail.busy()).toBeUndefined();
      expect(polls).toBe(pollsAtFinish);
      expect(cells.map((found) => found.callId)).toEqual(["timer", "final"]);
    } finally {
      tail.close();
    }
  });

  test("the first read recovers current-turn cells and excludes older turns", async () => {
    const path = await rolloutPath();
    await writeFile(
      path,
      cell("old", TOUCH, 0, "turn-0") +
        output("old", [REFUSED_TOUCH], 10, "turn-0") +
        cell("fast", TOUCH, 100) +
        output("fast", [REFUSED_TOUCH], 200),
    );
    const { tail, cells } = tailFor(path);
    await tail.poll();
    await tail.finish();
    expect(cells.map((found) => found.callId)).toEqual(["fast"]);
  });

  test("only refusal text a sandbox writes counts as a refusal", () => {
    expect(reportsRefusal("touch: x: Operation not permitted")).toBe(true);
    expect(reportsRefusal("patch rejected: writing outside of the project")).toBe(true);
    expect(reportsRefusal("ssh: Permission denied (publickey)")).toBe(true);
    expect(reportsRefusal("mkdir: x: Read-only file system")).toBe(true);
    // Codex's own heuristic also matches these, but ordinary output says them.
    expect(reportsRefusal("docs/sandbox.md: landlock and seccomp notes")).toBe(false);
  });
});
