import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { WATCH_HOST_PROGRAM, WATCH_HOST_MAX_EVENTS_PER_FLUSH } from "./watch-host.js";

/** Runs the shipped helper program with a deterministic OS watcher and a blocked stdout. */
function program() {
  const stdin = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  const stdout = new EventEmitter();
  const listeners = new Map<number, (type: string, name: string) => void>();
  const opened = new Map<number, EventEmitter>();
  const frames: any[] = [];
  const writes: Array<() => void> = [];
  const timers: Array<() => void> = [];
  let next = 0;
  let refuse = false;
  runInNewContext(WATCH_HOST_PROGRAM, {
    require: () => ({
      watch: (_path: string, _options: unknown, listener: (type: string, name: string) => void) => {
        if (refuse) {
          refuse = false;
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        const id = ++next;
        listeners.set(id, listener);
        const handle = Object.assign(new EventEmitter(), { close: () => listeners.delete(id) });
        opened.set(id, handle);
        return handle;
      },
    }),
    process: {
      stdin,
      stdout: Object.assign(stdout, {
        write: (line: string, done?: () => void) => {
          frames.push(JSON.parse(line));
          if (done) writes.push(done);
          return false;
        },
      }),
      exit: () => undefined,
    },
    setTimeout: (callback: () => void) => {
      timers.push(callback);
      return callback;
    },
  });
  const send = (message: object) => stdin.emit("data", `${JSON.stringify(message)}\n`);
  const refuseNext = () => {
    refuse = true;
  };
  return { send, frames, writes, timers, listeners, opened, refuseNext };
}

test("the helper deduplicates, bounds overflow and flushes after a slow reader resumes", () => {
  const p = program();
  p.send({ op: "watch", id: 1, path: "/a", recursive: false });
  p.send({ op: "watch", id: 2, path: "/b", recursive: false });
  const a = p.listeners.get(1)!;
  const b = p.listeners.get(2)!;
  a("change", "first");
  a("change", "first");
  p.timers.shift()!();
  // Opening the second watch rebuilt the stream under the first.
  expect(p.frames.at(-1)).toEqual({
    type: "events",
    batches: [[1, [["change", "first"]], false, true]],
  });
  // Leave its write callback parked: a reader has stopped draining stdout.
  for (let n = 0; n < WATCH_HOST_MAX_EVENTS_PER_FLUSH + 30; n += 1) a("rename", `file-${n}`);
  b("change", "other");
  p.timers.shift()!();
  expect(p.frames.filter((frame) => frame.type === "events")).toHaveLength(1);
  expect(p.timers).toHaveLength(0);
  p.writes.shift()!();
  p.timers.shift()!();
  const batches = p.frames.at(-1).batches;
  expect(batches[0][1]).toHaveLength(WATCH_HOST_MAX_EVENTS_PER_FLUSH);
  expect(batches[0][2]).toBe(true);
  expect(batches[1]).toEqual([2, [], true, false]);
  p.writes.shift()!();
  b("change", "after");
  p.timers.shift()!();
  expect(p.frames.at(-1)).toEqual({
    type: "events",
    batches: [[2, [["change", "after"]], false, false]],
  });
  p.writes.shift()!();
  p.send({ op: "close", id: 1 });
  a("change", "late");
  // The close tells the remaining watch; the closed one's late event goes nowhere.
  p.timers.shift()!();
  expect(p.frames.at(-1)).toEqual({ type: "events", batches: [[2, [], false, true]] });
});

test("a start or close flags every other live watch once per flush, never its own", () => {
  const p = program();
  p.send({ op: "watch", id: 1, path: "/a", recursive: true });
  // The first watch has no one else to tell, so nothing is scheduled.
  expect(p.timers).toHaveLength(0);
  p.send({ op: "watch", id: 2, path: "/b", recursive: true });
  p.send({ op: "watch", id: 3, path: "/c", recursive: true });
  p.send({ op: "watch", id: 4, path: "/d", recursive: true });
  expect(p.timers).toHaveLength(1);
  p.timers.shift()!();
  // Three starts in one flush: one flag each for the watches that were live.
  expect(p.frames.at(-1)).toEqual({
    type: "events",
    batches: [
      [1, [], false, true],
      [2, [], false, true],
      [3, [], false, true],
    ],
  });
  p.writes.shift()!();

  p.send({ op: "close", id: 2 });
  p.timers.shift()!();
  expect(p.frames.at(-1)).toEqual({
    type: "events",
    batches: [
      [1, [], false, true],
      [3, [], false, true],
      [4, [], false, true],
    ],
  });
  p.writes.shift()!();

  // A close of something already gone rebuilt nothing.
  p.send({ op: "close", id: 2 });
  expect(p.timers).toHaveLength(0);
  // Nor did a refused start.
  const refused = program();
  refused.send({ op: "watch", id: 1, path: "/a", recursive: true });
  const failing = runFailingStart(refused);
  expect(failing.timers).toHaveLength(0);
});

/** A second start whose `fs.watch` throws, as for a missing path. */
function runFailingStart(p: ReturnType<typeof program>) {
  p.refuseNext();
  p.send({ op: "watch", id: 2, path: "/missing", recursive: true });
  expect(p.frames.at(-1)).toEqual({ type: "error", id: 2, code: "ENOENT" });
  return p;
}

test("an asynchronous error that closes an established watch flags the survivors once", () => {
  const p = program();
  p.send({ op: "watch", id: 1, path: "/a", recursive: true });
  p.send({ op: "watch", id: 2, path: "/b", recursive: true });
  p.timers.shift()!();
  p.writes.shift()!();
  expect(p.timers).toHaveLength(0);

  p.opened.get(2)!.emit("error", Object.assign(new Error("gone"), { code: "ENOENT" }));
  expect(p.frames.at(-1)).toEqual({ type: "error", id: 2, code: "ENOENT" });
  // The helper closed the failed watch itself, which rebuilt the stream under watch 1.
  expect(p.listeners.has(2)).toBe(false);
  expect(p.timers).toHaveLength(1);
  p.timers.shift()!();
  expect(p.frames.at(-1)).toEqual({ type: "events", batches: [[1, [], false, true]] });
  p.writes.shift()!();

  // The backend's own close of the id it saw fail rebuilds nothing more.
  p.send({ op: "close", id: 2 });
  expect(p.timers).toHaveLength(0);
});
