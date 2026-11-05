import { expect, test } from "bun:test";
import { WorktreeRemovalReads } from "./worktree-removal-reads.js";

test("removal fences path aliases and drains only that physical root", async () => {
  const reads = new WorktreeRemovalReads();
  const root = { worktreePath: "/fixture/removal-root" };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = reads.run(root, () => gate);
  let releaseOther!: () => void;
  const other = reads.run(
    { worktreePath: "/fixture/removal-root-sibling" },
    () =>
      new Promise<void>((resolve) => {
        releaseOther = resolve;
      }),
  );
  let drained = false;
  const closing = reads.close({ worktreePath: "/fixture/./removal-root" }).then(() => {
    drained = true;
  });
  await Promise.resolve();
  try {
    expect(drained).toBe(false);
    expect(() => reads.run(root, async () => undefined)).toThrow("being removed");
    release();
    await closing;
    expect(drained).toBe(true);
    // The sibling is still pending but did not block the root's drain.
    expect(() =>
      reads.assertReadable({ worktreePath: "/fixture/removal-root-sibling" }),
    ).not.toThrow();
  } finally {
    release();
    releaseOther();
    await Promise.allSettled([running, other, closing]);
  }
});

test("a failed reader settles removal without an unhandled rejection", async () => {
  const reads = new WorktreeRemovalReads();
  const root = { worktreePath: "/fixture/failed-root" };
  const read = reads.run(root, async () => {
    throw new Error("read failed");
  });
  const failed = expect(read).rejects.toThrow("read failed");
  await reads.close(root);
  await failed;
  expect(() => reads.assertReadable(root)).toThrow("being removed");
});
