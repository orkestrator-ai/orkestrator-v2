import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isIgnorableWorktreeChange,
  startWorktreeWatcher,
  WATCH_SETTLE_MS,
} from "../../../apps/backend/src/core/worktree-watcher";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

interface FakeWatch {
  emit: (eventType: string, filename: string | null) => void;
  closed: boolean;
  fail: (error: unknown) => void;
}

function fakeWatcher(): { start: NonNullable<Parameters<typeof startWorktreeWatcher>[0]["startWatch"]>; handle: FakeWatch } {
  const handle: FakeWatch = { emit: () => {}, closed: false, fail: () => {} };
  const errorHandlers = new Set<(error: unknown) => void>();

  const start = ((_target: string, listener: (eventType: string, filename: string | null) => void) => {
    handle.emit = listener;
    handle.fail = (error) => {
      for (const onError of errorHandlers) onError(error);
    };
    return {
      on(event: string, onError: (error: unknown) => void) {
        if (event === "error") errorHandlers.add(onError);
        return this;
      },
      close() {
        handle.closed = true;
      },
    };
  }) as NonNullable<Parameters<typeof startWorktreeWatcher>[0]["startWatch"]>;

  return { start, handle };
}

async function waitForSettle(settleMs: number) {
  await new Promise((resolve) => setTimeout(resolve, settleMs + 30));
}

describe("isIgnorableWorktreeChange", () => {
  // Git rewrites .git constantly with locks, object writes and packing; only the
  // index and HEAD change what a diff reports.
  test.each([
    ".git/objects/ab/cdef",
    ".git/index.lock",
    ".git/refs/heads/main",
    ".git/COMMIT_EDITMSG",
    ".git/logs/HEAD",
  ])("ignores git churn: %s", (filename) => {
    expect(isIgnorableWorktreeChange(filename)).toBe(true);
  });

  test.each([".git/index", ".git/HEAD"])("does not ignore %s", (filename) => {
    expect(isIgnorableWorktreeChange(filename)).toBe(false);
  });

  test.each([
    "src/index.ts",
    "README.md",
    ".gitignore",
    ".github/workflows/ci.yml",
    "docs/.git-notes.md",
  ])("does not ignore source path: %s", (filename) => {
    expect(isIgnorableWorktreeChange(filename)).toBe(false);
  });

  // A rename can arrive without a filename; assuming "irrelevant" would drop a
  // real change, so it must fall through to a scan.
  test("does not ignore a missing filename", () => {
    expect(isIgnorableWorktreeChange(null)).toBe(false);
  });

  test("does not ignore a path merely starting with .git", () => {
    expect(isIgnorableWorktreeChange(".gitmodules")).toBe(false);
  });
});

describe("startWorktreeWatcher", () => {
  test("debounces a burst of events into one callback", async () => {
    const { start, handle } = fakeWatcher();
    let changes = 0;
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      settleMs: 20,
      startWatch: start,
      onChange: () => { changes += 1; },
    });
    cleanups.push(() => watcher.close());

    handle.emit("change", "a.ts");
    handle.emit("change", "b.ts");
    handle.emit("change", "c.ts");
    expect(changes).toBe(0);

    await waitForSettle(20);
    expect(changes).toBe(1);
  });

  test("fires again for a later burst", async () => {
    const { start, handle } = fakeWatcher();
    let changes = 0;
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      settleMs: 20,
      startWatch: start,
      onChange: () => { changes += 1; },
    });
    cleanups.push(() => watcher.close());

    handle.emit("change", "a.ts");
    await waitForSettle(20);
    handle.emit("change", "b.ts");
    await waitForSettle(20);

    expect(changes).toBe(2);
  });

  test("does not fire for git churn alone", async () => {
    const { start, handle } = fakeWatcher();
    let changes = 0;
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      settleMs: 20,
      startWatch: start,
      onChange: () => { changes += 1; },
    });
    cleanups.push(() => watcher.close());

    handle.emit("change", ".git/index.lock");
    handle.emit("change", ".git/objects/aa/bb");
    await waitForSettle(20);

    expect(changes).toBe(0);
  });

  test("does not fire after close", async () => {
    const { start, handle } = fakeWatcher();
    let changes = 0;
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      settleMs: 20,
      startWatch: start,
      onChange: () => { changes += 1; },
    });

    handle.emit("change", "a.ts");
    watcher.close();
    await waitForSettle(20);

    expect(changes).toBe(0);
    expect(handle.closed).toBe(true);
  });

  test("close is idempotent", () => {
    const { start } = fakeWatcher();
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      startWatch: start,
      onChange: () => {},
    });

    watcher.close();
    expect(() => watcher.close()).not.toThrow();
    expect(watcher.watching).toBe(false);
  });

  test("close remains safe when the platform watcher throws while closing", () => {
    const start = ((_target: string, _listener: (eventType: string, filename: string | null) => void) => ({
      on() {
        return this;
      },
      close() {
        throw new Error("watcher already torn down");
      },
    })) as NonNullable<Parameters<typeof startWorktreeWatcher>[0]["startWatch"]>;
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      startWatch: start,
      onChange: () => {},
    });

    expect(watcher.watching).toBe(true);
    expect(() => watcher.close()).not.toThrow();
    expect(watcher.watching).toBe(false);
  });

  // The owner has to fall back to polling rather than going quiet forever.
  test("reports not watching when the watch cannot be established", () => {
    let reported: unknown;
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      startWatch: () => { throw new Error("ENOSYS: recursive watch unsupported"); },
      onChange: () => {},
      onError: (error) => { reported = error; },
    });
    cleanups.push(() => watcher.close());

    expect(watcher.watching).toBe(false);
    expect(reported).toBeInstanceOf(Error);
  });

  test("reports and closes when the watch fails asynchronously", () => {
    const { start, handle } = fakeWatcher();
    let reported: unknown;
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      startWatch: start,
      onChange: () => {},
      onError: (error) => { reported = error; },
    });
    cleanups.push(() => watcher.close());
    expect(watcher.watching).toBe(true);

    handle.fail(new Error("EMFILE"));

    expect(reported).toBeInstanceOf(Error);
    expect(watcher.watching).toBe(false);
  });

  test("defaults to a settle window rather than firing per event", () => {
    expect(WATCH_SETTLE_MS).toBeGreaterThan(0);
  });

  // Exercises the real fs.watch rather than the injected fake. Recursive watching
  // is not available on every platform, so an unwatchable environment is a skip
  // and not a failure - that is the documented degradation.
  test("observes a real file write", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ork-watch-"));
    let changes = 0;
    let resolveChange!: () => void;
    const changeObserved = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = startWorktreeWatcher({
      worktreePath: directory,
      settleMs: 50,
      onChange: () => {
        changes += 1;
        resolveChange();
      },
    });
    cleanups.push(() => watcher.close());

    if (!watcher.watching) return;

    const deadline = Date.now() + 2_000;
    let attempt = 0;
    while (changes === 0 && Date.now() < deadline) {
      await fs.writeFile(
        path.join(directory, `created-${attempt}.ts`),
        `export const value = ${attempt};\n`,
      );
      attempt += 1;
      await Promise.race([
        changeObserved,
        new Promise<void>((resolve) => setTimeout(resolve, 75)),
      ]);
    }

    expect(changes).toBeGreaterThan(0);
  });
});
