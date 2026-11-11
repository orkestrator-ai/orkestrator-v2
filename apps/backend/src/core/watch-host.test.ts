import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { WATCH_HOST_MAX_LINE_CHARS, WatchHost, watchDirectory } from "./watch-host.js";

/** A helper process the test plays both ends of. */
function fakeHelper() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    kill: () => boolean;
    unref: () => void;
    killed: number;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.killed = 0;
  child.kill = () => {
    child.killed += 1;
    return true;
  };
  child.unref = () => undefined;
  const sent: Array<Record<string, unknown>> = [];
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) if (line) sent.push(JSON.parse(line));
  });
  return {
    child: child as unknown as ChildProcess,
    raw: child,
    sent,
    say: (message: unknown) => child.stdout.write(`${JSON.stringify(message)}\n`),
  };
}

function hostWith() {
  const helpers: Array<ReturnType<typeof fakeHelper>> = [];
  const host = new WatchHost(() => {
    const helper = fakeHelper();
    helpers.push(helper);
    return helper.child;
  });
  return { host, helpers };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("WatchHost", () => {
  test("a start returns before the helper answers, and only asks it", async () => {
    const { host, helpers } = hostWith();
    let established = false;
    const handle = host.watch("/wt", () => undefined, { recursive: true });
    void handle.established?.then(() => (established = true));
    await tick();
    expect(helpers).toHaveLength(1);
    expect(helpers[0]!.sent).toEqual([{ op: "watch", id: 1, path: "/wt", recursive: true }]);
    expect(established).toBe(false);

    helpers[0]!.say({ type: "ready", id: 1 });
    await tick();
    expect(established).toBe(true);
  });

  test("delivers a batch to its own watch, and reports overflow as an unknown path", async () => {
    const { host, helpers } = hostWith();
    const seen: Array<[string, string, string | null]> = [];
    host.watch("/a", (type, name) => seen.push(["a", type, name]), { recursive: true });
    host.watch("/b", (type, name) => seen.push(["b", type, name]), { recursive: true });
    helpers[0]!.say({
      type: "events",
      batches: [
        [
          1,
          [
            ["rename", "x"],
            ["change", "y"],
          ],
          true,
        ],
        [2, [["rename", null]], false],
      ],
    });
    await tick();
    expect(seen).toEqual([
      ["a", "rename", "x"],
      ["a", "change", "y"],
      ["a", "change", null],
      ["b", "rename", null],
    ]);
  });

  test("a lost flag reaches only that watch's lost listeners, after its events", async () => {
    const { host, helpers } = hostWith();
    const seen: string[] = [];
    const a = host.watch("/a", (type, name) => seen.push(`a ${type} ${name}`), {
      recursive: true,
    });
    const b = host.watch("/b", (type, name) => seen.push(`b ${type} ${name}`), {
      recursive: true,
    });
    a.onEventsLost?.(() => seen.push("a lost"));
    b.onEventsLost?.(() => seen.push("b lost"));
    helpers[0]!.say({
      type: "events",
      batches: [
        [1, [["rename", "x"]], false, true],
        [2, [["change", "y"]], false, false],
        // An older helper sends no flag at all.
        [2, [["change", "z"]], false],
      ],
    });
    await tick();
    expect(seen).toEqual(["a rename x", "a lost", "b change y", "b change z"]);

    // A watch closed by one of its own listeners hears nothing more.
    seen.length = 0;
    const c = host.watch(
      "/c",
      () => {
        seen.push("c event");
        c.close();
      },
      { recursive: true },
    );
    c.onEventsLost?.(() => seen.push("c lost"));
    helpers[0]!.say({ type: "events", batches: [[3, [["rename", "q"]], false, true]] });
    await tick();
    expect(seen).toEqual(["c event"]);
  });

  test("a close returns at once, tells the helper, and silences late events", async () => {
    const { host, helpers } = hostWith();
    const seen: Array<string | null> = [];
    const errors: Error[] = [];
    const handle = host.watch("/a", (_type, name) => seen.push(name), { recursive: true });
    handle.on("error", (error) => errors.push(error));
    handle.close();
    handle.close();
    await expect(handle.established).rejects.toMatchObject({ code: "ECANCELED" });
    await tick();
    expect(helpers[0]!.sent.filter((message) => message.op === "close")).toEqual([
      { op: "close", id: 1 },
    ]);
    helpers[0]!.say({ type: "events", batches: [[1, [["rename", "late"]], false]] });
    helpers[0]!.say({ type: "ready", id: 1 });
    await tick();
    expect(seen).toEqual([]);
    expect(errors).toEqual([]);
    expect(host.openWatches).toBe(0);
  });

  test("a refused watch reports its code through `error` and rejects `established`", async () => {
    const { host, helpers } = hostWith();
    const errors: NodeJS.ErrnoException[] = [];
    const handle = host.watch("/gone", () => undefined, { recursive: true });
    handle.on("error", (error) => errors.push(error));
    helpers[0]!.say({ type: "error", id: 1, code: "ENOENT" });
    await expect(handle.established).rejects.toMatchObject({ code: "ENOENT" });
    expect(errors.map((error) => error.code)).toEqual(["ENOENT"]);
    expect(host.openWatches).toBe(0);
  });

  test("an error before anyone listens still reaches the first listener", async () => {
    const { host, helpers } = hostWith();
    const handle = host.watch("/gone", () => undefined, { recursive: true });
    helpers[0]!.say({ type: "error", id: 1, code: "ENOENT" });
    await tick();
    const errors: unknown[] = [];
    handle.on("error", (error) => errors.push(error));
    expect(errors).toHaveLength(1);
  });

  test("a lost helper fails every open watch, and the next start spawns another", async () => {
    const { host, helpers } = hostWith();
    const errors: unknown[] = [];
    host.watch("/a", () => undefined, { recursive: true }).on("error", (e) => errors.push(e));
    host.watch("/b", () => undefined, { recursive: true }).on("error", (e) => errors.push(e));
    helpers[0]!.raw.emit("exit", 1);
    expect(errors).toHaveLength(2);
    expect(host.openWatches).toBe(0);

    host.watch("/c", () => undefined, { recursive: true });
    await tick();
    expect(helpers).toHaveLength(2);
    expect(helpers[1]!.sent).toEqual([{ op: "watch", id: 3, path: "/c", recursive: true }]);
  });

  test("a helper that cannot be spawned degrades to the watch's error", async () => {
    const host = new WatchHost(() => {
      throw new Error("spawn refused");
    });
    const handle = host.watch("/a", () => undefined, { recursive: true });
    await expect(handle.established).rejects.toMatchObject({ code: "EWATCHHOST" });
  });

  test("garbage or an unbounded line from the helper ends it", async () => {
    const { host, helpers } = hostWith();
    const errors: unknown[] = [];
    host.watch("/a", () => undefined, { recursive: true }).on("error", (e) => errors.push(e));
    helpers[0]!.raw.stdout.write("not json\n");
    await tick();
    expect(errors).toHaveLength(1);
    expect(helpers[0]!.raw.killed).toBe(1);

    host.watch("/b", () => undefined, { recursive: true }).on("error", (e) => errors.push(e));
    helpers[1]!.raw.stdout.write("x".repeat(WATCH_HOST_MAX_LINE_CHARS + 1));
    await tick();
    expect(errors).toHaveLength(2);
    expect(helpers[1]!.raw.killed).toBe(1);
  });
});

/** The real helper program, as `bun -e` runs it. */
describe("the helper process", () => {
  let directory = "";
  const host = new WatchHost();

  afterEach(async () => {
    host.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  test("establishes a watch on a directory and refuses a missing one", async () => {
    directory = await realpath(await mkdtemp(path.join(tmpdir(), "ork-watch-host-")));
    const live = host.watch(directory, () => undefined, { recursive: false });
    await live.established;
    const missing = host.watch(path.join(directory, "absent"), () => undefined, {
      recursive: false,
    });
    await expect(missing.established).rejects.toMatchObject({ code: "ENOENT" });
    live.close();
  }, 60_000);

  test("is only used on macOS", async () => {
    directory = await realpath(await mkdtemp(path.join(tmpdir(), "ork-watch-host-")));
    const inProcess = watchDirectory(directory, () => undefined, { recursive: false }, "linux");
    expect(inProcess.established).toBeUndefined();
    inProcess.close();
    const hosted = watchDirectory(directory, () => undefined, { recursive: false }, "darwin");
    await hosted.established;
    hosted.close();
  }, 60_000);
});
