import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE_ERROR_REASONS, CaptureError, captureErrorReason } from "./capture-error.js";
import { DEFAULT_CAPTURE_LIMITS, encodePath, HostCaptureExecutor } from "./capture.js";
import { confinedRead } from "./confined-read.js";
import { scopeUnavailableReason } from "./git-scopes.js";
import { ObjectStore } from "./object-store.js";
import { RemoteSlots } from "./worktree-owner.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "ork-capture-error-"));
  directories.push(directory);
  return directory;
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("CaptureError", () => {
  test("keeps the reason as its message, so logs and older readers are unchanged", () => {
    for (const reason of CAPTURE_ERROR_REASONS) {
      const error = new CaptureError(reason);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(reason);
      expect(error._tag).toBe("CaptureError");
      expect(captureErrorReason(error)).toBe(reason);
    }
  });

  test("readers switch on the reason, never on a message that merely looks like one", () => {
    expect(captureErrorReason(new Error("capture-timeout"))).toBeUndefined();
    expect(captureErrorReason("capture-timeout")).toBeUndefined();
    expect(captureErrorReason(null)).toBeUndefined();
  });

  test("a scope scan reports only the reasons a view explains", () => {
    expect(scopeUnavailableReason(captureErrorReason(new CaptureError("commit-not-found")))).toBe(
      "commit-not-found",
    );
    expect(
      scopeUnavailableReason(captureErrorReason(new CaptureError("baseline-unavailable"))),
    ).toBe("baseline-unavailable");
    expect(
      scopeUnavailableReason(captureErrorReason(new CaptureError("runtime-unavailable"))),
    ).toBe("scan-failed");
    expect(scopeUnavailableReason(captureErrorReason(new Error("commit-not-found")))).toBe(
      "scan-failed",
    );
  });
});

describe("confined reads", () => {
  test("throw their reasons as CaptureErrors", async () => {
    const root = scratch();
    writeFileSync(join(root, "big.txt"), "x".repeat(32));
    const reason = (work: Promise<unknown>) =>
      work.then(
        () => "resolved",
        (error: unknown) => captureErrorReason(error),
      );
    expect(await reason(confinedRead(root, bytes("../escape"), 1024))).toBe("unsafe-capture-path");
    expect(await reason(confinedRead(root, bytes("absent.txt"), 1024))).toBe(
      "capture-file-missing",
    );
    expect(await reason(confinedRead(root, bytes("big.txt"), 8))).toBe("capture-file-too-large");
    const aborted = AbortSignal.abort();
    expect(await reason(confinedRead(root, bytes("big.txt"), 1024, aborted))).toBe(
      "capture-timeout",
    );
  });

  test("the host executor maps them onto read records", async () => {
    const root = scratch();
    writeFileSync(join(root, "big.txt"), "x".repeat(32));
    const executor = new HostCaptureExecutor(root);
    const limits = { ...DEFAULT_CAPTURE_LIMITS, maxFileBytes: 8, readers: 1 };
    const records = await executor.fetch(
      [encodePath(bytes("absent.txt")), encodePath(bytes("big.txt"))],
      limits,
      new AbortController().signal,
    );
    expect(records[0]).toMatchObject({ kind: "missing" });
    expect(records[1]).toMatchObject({ kind: "omitted", reason: "too-large" });
  });
});

describe("remote capture slots", () => {
  test("an abort while waiting rejects with capture-timeout", async () => {
    const slots = new RemoteSlots(1);
    const release = await slots.acquire(new AbortController().signal);
    const controller = new AbortController();
    const waiting = slots.acquire(controller.signal);
    controller.abort();
    const error = await waiting.catch((caught: unknown) => caught);
    expect(captureErrorReason(error)).toBe("capture-timeout");
    expect(captureErrorReason(await slots.acquire(AbortSignal.abort()).catch((e) => e))).toBe(
      "capture-timeout",
    );
    release();
  });
});

describe("object store init", () => {
  test("a failed init is retried by the next call instead of replayed", async () => {
    const parent = scratch();
    // A file where the store's root directory should go makes every mkdir fail.
    const root = join(parent, "store");
    writeFileSync(root, "not a directory");
    const store = new ObjectStore({ root, durable: false });

    await expect(store.init()).rejects.toThrow();
    // Still failing while the cause is in place, by a fresh attempt.
    await expect(store.init()).rejects.toThrow();

    rmSync(root);
    await expect(store.init()).resolves.toBeUndefined();
    // Once it has succeeded, later calls share the same settled promise.
    expect(store.init()).toBe(store.init());
  });
});
