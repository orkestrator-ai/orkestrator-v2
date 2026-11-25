import { expect, spyOn, test } from "bun:test";
import { fakePid } from "@orkestrator/protocol/testing/fake-pids";
import { installControlledTimeout } from "../../../tests/helpers/controlled-timeout";
import { CliDriver, captureUntilObserving, RunManifest } from "../scenarios/harness.js";

/**
 * The scenario `client-exit` interrupts a `--wait` client only once it says it
 * is observing (flake 9869), never on a timer.
 */

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test("signals once when the observing record arrives, even split across chunks", async () => {
  let signals = 0;
  const record = JSON.stringify({
    type: "observing",
    action: "environment.start",
    operationId: "op-1",
  });
  const captured = await captureUntilObserving(
    streamOf(["warning: slow\n", record.slice(0, 10), `${record.slice(10)}\n`, `${record}\n`]),
    () => {
      signals += 1;
    },
  );
  expect(signals).toBe(1);
  expect(captured).toBe(`warning: slow\n${record}\n${record}\n`);
});

test("never signals when the client exits before observing", async () => {
  let signals = 0;
  const captured = await captureUntilObserving(
    streamOf(['{"type":"other"}\n', "{not json\n", "error [busy]: try later\n"]),
    () => {
      signals += 1;
    },
  );
  expect(signals).toBe(0);
  expect(captured).toContain("error [busy]");
});

test("a command whose child never settles fails as its own stage", async () => {
  const deadline = installControlledTimeout(60_000, { label: "command deadline" });
  const clock = installControlledTimeout(60_000 + 5_000, { label: "unsettled command" });
  const kills: unknown[] = [];
  // Flake 1001: Bun never saw the child exit, so nothing here ever settles.
  const spawn = spyOn(Bun, "spawn").mockReturnValue({
    pid: fakePid(1),
    exitCode: null,
    signalCode: null,
    stdout: streamOf(["{}"]),
    stderr: new ReadableStream(),
    exited: new Promise(() => undefined),
    kill: (signal: unknown) => kills.push(signal),
  } as unknown as ReturnType<typeof Bun.spawn>);
  const text = spyOn(Response.prototype, "text");
  try {
    const cli = new CliDriver("stuck", {}, new RunManifest(null), 60_000);
    const run = cli.run(["project", "add"], { stage: "project add" });
    const failure = run.catch((error: Error) => error.message);
    // The one end that settled is not blamed.
    await text.mock.results[0]!.value;
    await new Promise((resolve) => setImmediate(resolve));
    expect(kills).toEqual([]);
    expect(deadline.advance()).toBe(1);
    expect(kills).toEqual(["SIGKILL"]);
    clock.advance();
    expect(await failure).toBe(
      `[project add] pid ${fakePid(1)} did not settle (stderr, exit open; exitCode null, signal null)`,
    );
    expect(kills).toEqual(["SIGKILL"]);
  } finally {
    text.mockRestore();
    spawn.mockRestore();
    clock.restore();
    deadline.restore();
  }
});

test("a pipe capture error kills the child and stays the failure cause", async () => {
  const captureError = new Error("stdout capture failed");
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(captureError);
    },
  });
  const exit = Promise.withResolvers<number>();
  const kills: unknown[] = [];
  const spawn = spyOn(Bun, "spawn").mockReturnValue({
    pid: fakePid(1),
    exitCode: null,
    signalCode: null,
    stdout,
    stderr: streamOf([]),
    exited: exit.promise,
    kill: (signal: unknown) => {
      kills.push(signal);
      exit.resolve(137);
    },
  } as unknown as ReturnType<typeof Bun.spawn>);
  try {
    const cli = new CliDriver("broken pipe", {}, new RunManifest(null), 60_000);
    await expect(cli.run(["project", "add"], { stage: "project add" })).rejects.toBe(captureError);
    expect(kills).toEqual(["SIGKILL"]);
  } finally {
    spawn.mockRestore();
  }
});
