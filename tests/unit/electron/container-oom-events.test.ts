import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { OomEventWatcher } from "../../../apps/backend/src/core/container-oom-events";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  kill() {
    this.exitCode = 143;
    this.emit("close", 143);
    return true;
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const nanos = (seconds: number) => `${BigInt(seconds) * 1_000_000_000n}`;
const ID = "a".repeat(64);

describe("out-of-memory event watcher", () => {
  test("counts kills per container from Docker's events, scoped to this owner", async () => {
    const spawned: string[][] = [];
    const children: FakeChild[] = [];
    const watcher = new OomEventWatcher("0123456789abcdef", ((_command: string, args: string[]) => {
      spawned.push(args);
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as never);
    expect(watcher.count(ID)).toBeNull();
    watcher.start();
    expect(spawned[0]).toContain("label=orkestrator-owner=0123456789abcdef");
    expect(spawned[0]).toContain("event=oom");
    expect(watcher.count(ID)).toBe(0);
    children[0]!.stdout.write(`${ID}\t${nanos(1_000)}\n`);
    children[0]!.stdout.write(`${ID}\t${nanos(1_001)}\n`);
    children[0]!.stdout.write("not-an-id\tgarbage\n");
    await tick();
    expect(watcher.count(ID)).toBe(2);
    // A short id matches the full one.
    expect(watcher.count(ID.slice(0, 12))).toBe(2);
    watcher.stop();
    expect(watcher.count(ID)).toBeNull();
  });

  test("a restarted follower replays the gap without counting an event twice", async () => {
    const spawned: string[][] = [];
    const children: FakeChild[] = [];
    const watcher = new OomEventWatcher("0123456789abcdef", ((_command: string, args: string[]) => {
      spawned.push(args);
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as never);
    watcher.start();
    children[0]!.stdout.write(`${ID}\t${nanos(2_000)}\n`);
    await tick();
    children[0]!.emit("close", 1);
    // Unknown while not following.
    expect(watcher.count(ID)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(spawned).toHaveLength(2);
    expect(spawned[1]).toContain("--since");
    expect(spawned[1]![spawned[1]!.indexOf("--since") + 1]).toBe("2000");
    // The replay repeats the counted event, then a new one.
    children[1]!.stdout.write(`${ID}\t${nanos(2_000)}\n`);
    children[1]!.stdout.write(`${ID}\t${nanos(2_005)}\n`);
    await tick();
    expect(watcher.count(ID)).toBe(2);
    watcher.stop();
  });
});
