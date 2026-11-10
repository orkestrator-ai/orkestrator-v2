import { afterEach, describe, expect, test } from "bun:test";

import { TICKET_SYNC_LIMITS } from "@orkestrator/protocol/ticket-sync";

import { LeafTicketImageWants } from "./node-ticket-images.js";

const owned: LeafTicketImageWants[] = [];
afterEach(() => {
  for (const wants of owned.splice(0)) wants.dispose();
});

function wantsWith(options: { timeoutMs?: number; maxWants?: number } = {}) {
  const announced: string[] = [];
  const wants = new LeafTicketImageWants({
    announce: (controllerId) => announced.push(controllerId),
    ...options,
  });
  owned.push(wants);
  return { wants, announced };
}

describe("LeafTicketImageWants", () => {
  test("a want is announced, listed for its command node only, and settled by the answer", async () => {
    const { wants, announced } = wantsWith();
    const first = wants.want("bk_a", "image-1", "unavailable");
    const second = wants.want("bk_a", "image-1", "unavailable");
    expect(announced).toEqual(["bk_a", "bk_a"]);
    expect(wants.wanted("bk_a")).toEqual(["image-1"]);
    expect(wants.wanted("bk_b")).toEqual([]);
    // Another command node cannot answer it.
    wants.answered("bk_b", "image-1", true);
    expect(wants.wanted("bk_a")).toEqual(["image-1"]);
    wants.answered("bk_a", "image-1", true);
    await Promise.all([first, second]);
    expect(wants.wanted("bk_a")).toEqual([]);
  });

  test("an answer without the bytes, a timeout and disposal all fail with the caller's message", async () => {
    const { wants } = wantsWith({ timeoutMs: 20 });
    const missing = wants.want("bk_a", "gone", "not there");
    wants.answered("bk_a", "gone", false);
    await expect(missing).rejects.toThrow("not there");
    await expect(wants.want("bk_a", "slow", "timed out")).rejects.toThrow("timed out");
    const pending = wants.want("bk_a", "pending", "shut down");
    wants.dispose();
    await expect(pending).rejects.toThrow("shut down");
    await expect(wants.want("bk_a", "after", "disposed")).rejects.toThrow("disposed");
  });

  test("wants are bounded, and one collection lists at most a batch", async () => {
    const { wants } = wantsWith({ maxWants: TICKET_SYNC_LIMITS.maxWantedImages + 1 });
    const all = Array.from({ length: TICKET_SYNC_LIMITS.maxWantedImages + 1 }, (_, index) =>
      wants.want("bk_a", `image-${index}`, "unavailable").catch(() => undefined),
    );
    expect(wants.wanted("bk_a")).toHaveLength(TICKET_SYNC_LIMITS.maxWantedImages);
    await expect(wants.want("bk_a", "one-too-many", "full")).rejects.toThrow("full");
    wants.dispose();
    await Promise.all(all);
  });
});
