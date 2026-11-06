import { describe, expect, test } from "bun:test";
import { RequestLimiter } from "@/lib/hydration-request-limiter";
import { waitForHydrationQuiet } from "./useRealmBootTiming";

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("waitForHydrationQuiet", () => {
  test("waits through reads that start just after the limiter first goes idle", async () => {
    const limiter = new RequestLimiter(2);
    const finished: string[] = [];
    void limiter.run(async () => {
      await nextTask();
      finished.push("environments");
      // As the batcher does: the follow-up read starts from a zero-delay timer.
      setTimeout(() => {
        void limiter.run(async () => {
          await nextTask();
          finished.push("hydration");
        });
      }, 0);
    });

    await waitForHydrationQuiet(limiter);
    expect(finished).toEqual(["environments", "hydration"]);
    expect(limiter.started).toBe(2);
  });

  test("resolves promptly when nothing was ever sent", async () => {
    await waitForHydrationQuiet(new RequestLimiter(1));
  });
});
