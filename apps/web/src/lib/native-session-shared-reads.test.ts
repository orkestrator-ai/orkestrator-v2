import { afterEach, describe, expect, test } from "bun:test";
import type { ReadContext } from "@/lib/read-coordinator";
import {
  NativeSessionReadRound,
  nativeSessionViewCount,
  registerNativeSessionView,
  resetNativeSessionSharedReadsForTests,
  runNativeSessionReadRound,
} from "./native-session-shared-reads";

const context: ReadContext = {
  reason: "interval",
  explicit: false,
  signal: new AbortController().signal,
  connectionId: "local",
  connectionGeneration: 1,
};

afterEach(() => resetNativeSessionSharedReadsForTests());

describe("native session shared reads", () => {
  test("joins identical requests within a round, whatever the key order", async () => {
    const round = new NativeSessionReadRound();
    let sent = 0;
    const send = async () => ({ sent: ++sent });
    const [a, b] = await Promise.all([
      round.request("transcript", { environmentId: "env", knownToken: "t1" }, send),
      round.request("transcript", { knownToken: "t1", environmentId: "env" }, send),
    ]);
    expect(sent).toBe(1);
    expect(a).toBe(b);
    expect(round.joinedRequests()).toBe(1);

    // A different conditional token or command is a different request.
    await round.request("transcript", { environmentId: "env", knownToken: "t2" }, send);
    await round.request("session-state", { environmentId: "env", knownToken: "t1" }, send);
    expect(sent).toBe(3);
  });

  test("a later round never reuses an earlier round's answer", async () => {
    let sent = 0;
    const send = async () => ++sent;
    await new NativeSessionReadRound().request("transcript", { token: "t" }, send);
    await new NativeSessionReadRound().request("transcript", { token: "t" }, send);
    expect(sent).toBe(2);
  });

  test("refreshes only the session's views that want a background read", async () => {
    const calls: string[] = [];
    const rounds = new Set<NativeSessionReadRound>();
    const view = (name: string, wants: () => boolean) => ({
      wantsBackgroundRead: wants,
      refresh: async (_context: ReadContext, round: NativeSessionReadRound) => {
        calls.push(name);
        rounds.add(round);
      },
    });
    let secondActive = false;
    const unregisterA = registerNativeSessionView(
      "env\0claude\0tab",
      view("a", () => true),
    );
    registerNativeSessionView(
      "env\0claude\0tab",
      view("b", () => secondActive),
    );
    registerNativeSessionView(
      "env\0claude\0other",
      view("other", () => true),
    );
    expect(nativeSessionViewCount("env\0claude\0tab")).toBe(2);

    await runNativeSessionReadRound("env\0claude\0tab", context);
    expect(calls).toEqual(["a"]);

    secondActive = true;
    await runNativeSessionReadRound("env\0claude\0tab", context);
    expect(calls).toEqual(["a", "a", "b"]);
    // Both views of one coordinator read share one round.
    expect(rounds.size).toBe(2);

    unregisterA();
    expect(nativeSessionViewCount("env\0claude\0tab")).toBe(1);
  });

  test("fails the coordinated read only when every participating view failed", async () => {
    let failB = true;
    registerNativeSessionView("target", {
      wantsBackgroundRead: () => true,
      refresh: async () => {
        throw new Error("a failed");
      },
    });
    registerNativeSessionView("target", {
      wantsBackgroundRead: () => true,
      refresh: async () => {
        if (failB) throw new Error("b failed");
      },
    });
    await expect(runNativeSessionReadRound("target", context)).rejects.toThrow("a failed");
    failB = false;
    await expect(runNativeSessionReadRound("target", context)).resolves.toBeInstanceOf(
      NativeSessionReadRound,
    );
  });
});
