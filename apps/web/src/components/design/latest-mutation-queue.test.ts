import { describe, expect, test } from "bun:test";
import { LatestMutationQueue } from "./latest-mutation-queue";

describe("LatestMutationQueue", () => {
  test("commits a second frame mutation submitted while the first is slow", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const committed: string[] = [];
    const busy: boolean[] = [];
    const queue = new LatestMutationQueue<string>(
      async (value) => {
        if (value === "frame-a") await blocked;
        committed.push(value);
      },
      (value) => busy.push(value),
    );

    queue.enqueue("frame-a", "frame-a");
    queue.enqueue("frame-b", "frame-b");
    release();
    await queue.flush();

    expect(committed).toEqual(["frame-a", "frame-b"]);
    expect(busy).toEqual([true, false]);
  });

  test("coalesces repeated pending edits for one frame to the newest request", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const committed: string[] = [];
    const queue = new LatestMutationQueue<string>(async (value) => {
      if (value === "blocking") await blocked;
      committed.push(value);
    });
    queue.enqueue("frame-a", "blocking");
    queue.enqueue("frame-b", "old");
    queue.enqueue("frame-b", "new");
    release();
    await queue.flush();
    expect(committed).toEqual(["blocking", "new"]);
  });
});
