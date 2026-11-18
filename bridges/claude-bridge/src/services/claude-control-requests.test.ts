import { describe, expect, test } from "bun:test";
import {
  ClaudeControlRequests,
  MAX_SETTLED_CLAUDE_CONTROL_REQUESTS,
} from "./claude-control-requests.js";

// One CLI's requests, each answered once: a redelivery shares an open answer
// or is refused once answered, and nothing is answered after the process ends.

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const refuse = (reason: string) => `refused:${reason}`;

describe("answering a CLI's requests once", () => {
  test("a redelivery of an open request shares its one answer", async () => {
    const requests = new ClaudeControlRequests();
    const card = deferred<string>();
    let shown = 0;
    const answer = async () => {
      shown += 1;
      return card.promise;
    };
    const live = requests.answerOnce("req-1", undefined, refuse, answer);
    const replay = requests.answerOnce("req-1", undefined, refuse, answer);
    expect(shown).toBe(1);
    expect(requests.isOpen("req-1")).toBe(true);
    card.resolve("allowed");
    expect(await live).toBe("allowed");
    expect(await replay).toBe("allowed");
    expect(requests.isOpen("req-1")).toBe(false);
    expect(requests.isSettled("req-1")).toBe(true);
  });

  test("a replay that crosses the answer is refused, never shown again", async () => {
    const requests = new ClaudeControlRequests();
    await requests.answerOnce("req-2", undefined, refuse, async () => "allowed");
    let shown = false;
    const replay = await requests.answerOnce("req-2", undefined, refuse, async () => {
      shown = true;
      return "allowed";
    });
    expect(replay).toBe("refused:already-answered");
    expect(shown).toBe(false);
  });

  test("the CLI withdrawing a request aborts the card's signal", async () => {
    const requests = new ClaudeControlRequests();
    const cli = new AbortController();
    const answer = requests.answerOnce(
      "req-3",
      cli.signal,
      refuse,
      (signal) =>
        new Promise<string>((resolve) =>
          signal.addEventListener("abort", () => resolve("withdrawn"), { once: true }),
        ),
    );
    cli.abort();
    expect(await answer).toBe("withdrawn");
    // A withdrawn request redelivered later cannot be approved.
    expect(await requests.answerOnce("req-3", undefined, refuse, async () => "allowed")).toBe(
      "refused:already-answered",
    );
  });

  test("an already withdrawn request reaches its card withdrawn", async () => {
    const requests = new ClaudeControlRequests();
    const cli = new AbortController();
    cli.abort();
    const aborted = await requests.answerOnce("req-4", cli.signal, refuse, async (signal) =>
      String(signal.aborted),
    );
    expect(aborted).toBe("true");
  });

  test("the process ending withdraws every open card and refuses later ones", async () => {
    const requests = new ClaudeControlRequests();
    const withdrawnOnEnd = (signal: AbortSignal) =>
      new Promise<string>((resolve) =>
        signal.addEventListener("abort", () => resolve("withdrawn"), { once: true }),
      );
    const named = requests.answerOnce("req-5", undefined, refuse, withdrawnOnEnd);
    // A delivery without a request id is still withdrawn.
    const anonymous = requests.answerOnce(undefined, undefined, refuse, withdrawnOnEnd);
    expect(requests.openCount).toBe(2);
    requests.end();
    requests.end();
    expect(requests.ended).toBe(true);
    expect(await named).toBe("withdrawn");
    expect(await anonymous).toBe("withdrawn");
    expect(requests.openCount).toBe(0);
    let shown = false;
    const late = await requests.answerOnce("req-6", undefined, refuse, async () => {
      shown = true;
      return "allowed";
    });
    expect(late).toBe("refused:process-ended");
    expect(shown).toBe(false);
  });

  test("a failed answer still counts as answered", async () => {
    const requests = new ClaudeControlRequests();
    await expect(
      requests.answerOnce("req-7", undefined, refuse, async () => {
        throw new Error("card failed");
      }),
    ).rejects.toThrow("card failed");
    expect(requests.isOpen("req-7")).toBe(false);
    expect(await requests.answerOnce("req-7", undefined, refuse, async () => "allowed")).toBe(
      "refused:already-answered",
    );
  });

  test("keeps answered ids within its bound, oldest first", async () => {
    const requests = new ClaudeControlRequests();
    for (let index = 0; index <= MAX_SETTLED_CLAUDE_CONTROL_REQUESTS; index += 1) {
      await requests.answerOnce(`req-${index}`, undefined, refuse, async () => "answered");
    }
    expect(requests.isSettled("req-0")).toBe(false);
    expect(requests.isSettled("req-1")).toBe(true);
    expect(requests.isSettled(`req-${MAX_SETTLED_CLAUDE_CONTROL_REQUESTS}`)).toBe(true);
  });
});
