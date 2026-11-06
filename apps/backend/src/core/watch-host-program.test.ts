import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { WATCH_HOST_PROGRAM, WATCH_HOST_MAX_EVENTS_PER_FLUSH } from "./watch-host.js";

/** Runs the shipped helper program with a deterministic OS watcher and a blocked stdout. */
function program() {
  const stdin = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  const stdout = new EventEmitter();
  const listeners = new Map<number, (type: string, name: string) => void>();
  const frames: any[] = [];
  const writes: Array<() => void> = [];
  const timers: Array<() => void> = [];
  let next = 0;
  runInNewContext(WATCH_HOST_PROGRAM, {
    require: () => ({
      watch: (_path: string, _options: unknown, listener: (type: string, name: string) => void) => {
        const id = ++next;
        listeners.set(id, listener);
        return Object.assign(new EventEmitter(), { close: () => listeners.delete(id) });
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
  return { send, frames, writes, timers, listeners };
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
  expect(p.frames.at(-1)).toEqual({ type: "events", batches: [[1, [["change", "first"]], false]] });
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
  expect(batches[1]).toEqual([2, [], true]);
  p.writes.shift()!();
  b("change", "after");
  p.timers.shift()!();
  expect(p.frames.at(-1)).toEqual({ type: "events", batches: [[2, [["change", "after"]], false]] });
  p.writes.shift()!();
  p.send({ op: "close", id: 1 });
  a("change", "late");
  expect(p.timers).toHaveLength(0);
});
