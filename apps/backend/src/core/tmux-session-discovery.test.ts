import { expect, mock, spyOn, test } from "bun:test";
import { TmuxBackend } from "./tmux-backend.js";
import { TmuxSession } from "./tmux-session-manager.js";
import type { CommandContext } from "./commands.js";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("transcript discovery backs off at 2/4/8/10 seconds, resets on a hook, then binds the tail", async () => {
  let now = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let resume: (() => void) | undefined;
  const backend = TmuxBackend.local("/tmp");
  const instance = new TmuxSession("env", "tab", backend, "/tmp", undefined, undefined, {
    pollTick: () =>
      new Promise<void>((resolve) => {
        resume = resolve;
      }),
  });
  const discoveries: number[] = [];
  let found = false;
  const discover = spyOn(instance, "discoverTranscriptPath").mockImplementation(async () => {
    discoveries.push(now);
    return found ? "/fixture/transcript.jsonl" : undefined;
  });
  const snapshot = spyOn(backend, "pollSnapshot").mockResolvedValue({
    pending: [],
    timeouts: [],
    transcriptSize: 0,
  });
  const remove = spyOn(backend, "removeFile").mockResolvedValue(undefined);
  const observation = spyOn(instance, "capturePane").mockResolvedValue("");
  const alive = spyOn(instance, "tmuxAlive").mockResolvedValue(true);
  const emit = mock(() => {});
  const context = { emit } as unknown as CommandContext;
  const step = async (time: number) => {
    now = time;
    const next = resume!;
    resume = undefined;
    next();
    await settle();
    expect(resume).toBeDefined();
  };
  try {
    instance["spawnPollLoop"](context);
    for (const time of [0, 1999, 2000, 5999, 6000, 13999, 14000, 23999, 24000, 33999, 34000])
      await step(time);
    expect(discoveries).toEqual([0, 2000, 6000, 14000, 24000, 34000]);
    snapshot.mockResolvedValueOnce({
      pending: [],
      timeouts: ["Stop-event.json"],
      transcriptSize: 0,
    });
    await step(35000);
    await step(35001);
    await step(37000);
    found = true;
    const line = { type: "assistant", message: { content: "fixture" } };
    const bytes = Buffer.from(`${JSON.stringify(line)}\n`);
    const read = spyOn(backend, "readFileBytesFrom").mockResolvedValue(bytes);
    snapshot.mockResolvedValue({ pending: [], timeouts: [], transcriptSize: bytes.length });
    await step(37001);
    expect(read).toHaveBeenCalledWith("/fixture/transcript.jsonl", 0);
    expect(emit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        kind: "transcript-line",
        line: expect.objectContaining({ type: "assistant" }),
      }),
    );
    read.mockRestore();
    expect(discoveries.slice(-2)).toEqual([35001, 37001]);
    expect(snapshot.mock.calls.at(-1)?.[1]).toBe("/fixture/transcript.jsonl");
    await step(100000);
    expect(discover).toHaveBeenCalledTimes(8);
  } finally {
    instance["stopRequested"] = true;
    resume?.();
    await settle();
    for (const spy of [clock, discover, snapshot, remove, observation, alive]) spy.mockRestore();
  }
});
