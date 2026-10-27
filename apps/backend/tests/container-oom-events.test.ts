import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContainerOomEvents, OomEventWatcher } from "../src/core/container-oom-events";
import { spawnParentBoundCommand } from "../src/core/shell";
import { installControlledTimeout } from "../../../tests/helpers/controlled-timeout";

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

async function waitUntil(predicate: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 3_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for follower state");
    await tick();
  }
}

describe("out-of-memory event watcher", () => {
  test("the backend owner starts once, passes its namespace and stops only its follower", () => {
    const children: FakeChild[] = [];
    const spawn = mock((_command: string, _args: string[]) => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<typeof spawnParentBoundCommand>;
    });
    const first = new ContainerOomEvents(spawn);
    const second = new ContainerOomEvents(spawn);
    const backoff = installControlledTimeout(1_000, { label: "owned OOM follower backoff" });
    try {
      expect(first.count(ID)).toBeNull();
      first.stop();
      first.start("first-owner");
      first.start("ignored-owner");
      second.start("second-owner");
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(
        spawn.mock.calls.map(([command, args]) => [
          command,
          args.find((arg) => arg.startsWith("label=")),
        ]),
      ).toEqual([
        ["docker", "label=orkestrator-owner=first-owner"],
        ["docker", "label=orkestrator-owner=second-owner"],
      ]);
      children[0]!.stdout.write(`${ID}\t${nanos(1_000)}\n`);
      expect(first.count(ID)).toBe(1);
      expect(second.count(ID)).toBe(0);
      first.stop();
      first.stop();
      expect(children[0]!.exitCode).toBe(143);
      expect(children[1]!.exitCode).toBeNull();
      expect(first.count(ID)).toBeNull();
      expect(second.count(ID)).toBe(0);
      // A stop while restart is queued cancels it; late close events cannot revive it.
      children[1]!.emit("close", 1);
      expect(backoff.pendingCount()).toBe(1);
      second.stop();
      children[1]!.emit("close", 1);
      expect(backoff.pendingCount()).toBe(0);
      backoff.advance();
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(second.count(ID)).toBeNull();
    } finally {
      first.stop();
      second.stop();
      backoff.restore();
    }
  });

  test("stop terminates the inner events command through the real wrapper", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oom-follower-"));
    const command = path.join(root, "docker");
    const ready = path.join(root, "ready");
    const stopped = path.join(root, "stopped");
    await writeFile(
      command,
      `#!/bin/sh
trap 'echo stopped > "${stopped}"; exit 0' TERM
echo ready > "${ready}"
while :; do sleep 0.05; done
`,
      { mode: 0o755 },
    );
    let child: ReturnType<typeof spawnParentBoundCommand> | undefined;
    const watcher = new OomEventWatcher("owner", (_command, args) => {
      child = spawnParentBoundCommand(command, args);
      return child;
    });
    try {
      watcher.start();
      await waitUntil(() => Bun.file(ready).exists());
      const closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
      watcher.stop();
      await closed;
      expect(await readFile(stopped, "utf8")).toBe("stopped\n");
      expect(watcher.count(ID)).toBeNull();
    } finally {
      watcher.stop();
      child?.stdin.end();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a missing executable exits the real wrapper with 127 and backs off before restarting", async () => {
    const clock = installControlledTimeout(1_000, { label: "OOM follower initial backoff" });
    const secondClock = installControlledTimeout(2_000, { label: "OOM follower second backoff" });
    const children: ReturnType<typeof spawnParentBoundCommand>[] = [];
    const watcher = new OomEventWatcher("owner", () => {
      const child = spawnParentBoundCommand("/nonexistent/orkestrator-test-docker");
      children.push(child);
      return child;
    });
    try {
      watcher.start();
      await waitUntil(() => clock.pendingCount() === 1);
      expect(children[0]!.exitCode).toBe(127);
      expect(watcher.count(ID)).toBeNull();
      expect(children).toHaveLength(1);
      clock.advance();
      await waitUntil(() => secondClock.pendingCount() === 1);
      expect(children).toHaveLength(2);
      expect(children[1]!.exitCode).toBe(127);
      watcher.stop();
      expect(secondClock.pendingCount()).toBe(0);
      expect(clock.pendingCount()).toBe(0);
    } finally {
      watcher.stop();
      secondClock.restore();
      clock.restore();
    }
  });

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
