import { describe, expect, test } from "bun:test";
import type { TerminalInputRequest } from "./terminal-input-batcher";
import {
  parseTerminalLifecycleCommand,
  TERMINAL_INPUT_CLOSED_MESSAGE,
  TerminalInputSequencer,
  type TerminalInputRecovery,
  type TerminalInputSequencerOptions,
  type TerminalLifecycleOperation,
} from "./terminal-input-sequencer";

const tick = async () => {
  for (let index = 0; index < 25; index += 1) await Promise.resolve();
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Deferred = ReturnType<typeof deferred<void>>;

const outcome = (promise: Promise<unknown> | null) =>
  (promise ?? Promise.reject(new Error("not routed"))).then(
    () => "ok",
    (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
  );

/** A sequencer whose HTTP and lifecycle sends are logged and answered at once. */
function harness(
  recovery: TerminalInputRecovery,
  overrides: Partial<TerminalInputSequencerOptions> = {},
) {
  const log: string[] = [];
  const sequencer = new TerminalInputSequencer({
    recovery,
    batchDelayMs: 0,
    sendInput: async (request: TerminalInputRequest) => {
      log.push(`http:${request.data}`);
      return { delivered: true };
    },
    runLifecycle: async (operation: TerminalLifecycleOperation) => {
      log.push(operation.command);
      return null;
    },
    ...overrides,
  });
  return { log, sequencer };
}

describe("parseTerminalLifecycleCommand", () => {
  test("maps each lifecycle command to the input it orders against", () => {
    expect(parseTerminalLifecycleCommand("detach_terminal", { sessionId: "s" })).toMatchObject({
      inputCommand: "terminal_write",
      kind: "close",
      sessionId: "s",
    });
    expect(
      parseTerminalLifecycleCommand("local_terminal_resize", { sessionId: "l", cols: 1 }),
    ).toMatchObject({ inputCommand: "local_terminal_write", kind: "resize" });
  });

  test("ignores other commands, missing session ids, and prototype keys", () => {
    expect(parseTerminalLifecycleCommand("get_projects", { sessionId: "s" })).toBeNull();
    expect(parseTerminalLifecycleCommand("terminal_resize", { sessionId: 1 })).toBeNull();
    expect(parseTerminalLifecycleCommand("toString", { sessionId: "s" })).toBeNull();
  });
});

describe("TerminalInputSequencer", () => {
  test("routes only terminal input and lifecycle commands", () => {
    const { sequencer } = harness("rearm-on-lifecycle");
    expect(sequencer.invoke("get_projects", {})).toBeNull();
    expect(sequencer.invoke("terminal_write", { sessionId: 1, data: "x" })).toBeNull();
    expect(sequencer.invoke("terminal_resize", { cols: 80 })).toBeNull();
  });

  test("rejects an unknown recovery rule", () => {
    expect(() => harness("sometimes" as TerminalInputRecovery)).toThrow("recovery");
  });

  test("bounds a lifecycle command by the send deadline and aborts it", async () => {
    let signal: AbortSignal | undefined;
    const { sequencer } = harness("rearm-on-lifecycle", {
      sendTimeoutMs: 20,
      runLifecycle: (_operation, lifecycleSignal) => {
        signal = lifecycleSignal;
        return new Promise(() => undefined);
      },
    });
    expect(
      await outcome(sequencer.invoke("terminal_resize", { sessionId: "s", cols: 1, rows: 1 })),
    ).toContain("timed out");
    expect(signal?.aborted).toBe(true);
    // A timed-out resize does not strand later input behind it.
    expect(await outcome(sequencer.invoke("terminal_write", { sessionId: "s", data: "x" }))).toBe(
      "ok",
    );
  });

  test("dispose rejects queued work and every later call", async () => {
    const held = deferred<unknown>();
    const { sequencer } = harness("fence-until-start", { sendInput: () => held.promise });
    const write = outcome(sequencer.invoke("terminal_write", { sessionId: "s", data: "a" }));
    const close = outcome(sequencer.invoke("detach_terminal", { sessionId: "s" }));
    sequencer.dispose(new Error("replaced"));
    expect(await write).toBe("rejected: replaced");
    expect(await close).toBe("rejected: replaced");
    expect(await outcome(sequencer.invoke("terminal_write", { sessionId: "t", data: "b" }))).toBe(
      "rejected: replaced",
    );
    expect(await outcome(sequencer.invoke("start_terminal_session", { sessionId: "t" }))).toBe(
      "rejected: replaced",
    );
  });

  test("forgets the oldest closed session beyond its memory", async () => {
    const { sequencer } = harness("rearm-on-lifecycle", { closedSessionMemory: 2 });
    for (const sessionId of ["a", "b", "c"]) {
      await sequencer.invoke("detach_terminal", { sessionId });
    }
    expect(sequencer.getStats().closedSessions).toBe(2);
    expect(await outcome(sequencer.invoke("terminal_write", { sessionId: "a", data: "x" }))).toBe(
      "ok",
    );
    expect(await outcome(sequencer.invoke("terminal_write", { sessionId: "c", data: "x" }))).toBe(
      `rejected: ${TERMINAL_INPUT_CLOSED_MESSAGE}`,
    );
  });

  test("forgets lifecycle bookkeeping once commands settle", async () => {
    const { sequencer } = harness("rearm-on-lifecycle");
    await Promise.all([
      sequencer.invoke("terminal_resize", { sessionId: "s", cols: 1, rows: 1 }),
      sequencer.invoke("terminal_resize", { sessionId: "s", cols: 2, rows: 2 }),
    ]);
    await tick();
    expect(sequencer.getStats()).toMatchObject({ pendingLifecycleOperations: 0, terminals: 0 });
  });

  for (const command of ["start_terminal_session", "terminal_resize"]) {
    for (const pipelined of [false, true]) {
      for (const limit of ["count", "bytes"] as const) {
        test(`${command}: bounds ${limit} before lifecycle completes (pipelined=${pipelined})`, async () => {
          const held = deferred<unknown>();
          const { log, sequencer } = harness("fence-until-start", {
            runLifecycle: () => held.promise,
            maxPendingInputs: limit === "count" ? 2 : 20,
            maxBatchBytes: 4,
            maxQueuedBytes: 4,
            ...(pipelined
              ? {
                  pipelined: {
                    active: () => true,
                    send: () => {
                      log.push("socket");
                      return Promise.resolve();
                    },
                  },
                }
              : {}),
          });
          const lifecycle = outcome(sequencer.invoke(command, { sessionId: "s" }));
          await tick();
          const writes = Array.from({ length: limit === "count" ? 3 : 6 }, () =>
            outcome(
              sequencer.invoke("terminal_write", {
                sessionId: "s",
                data: limit === "count" ? "x" : "😀",
              }),
            ),
          );
          // All rejected before releasing the lifecycle, including accepted predecessors.
          expect(
            (await Promise.all(writes)).every((value) => value.includes("queue limit exceeded")),
          ).toBe(true);
          expect(sequencer.getStats()).toMatchObject({
            pendingInputs: 0,
            reservedInputBytes: 0,
            failedTerminals: 1,
          });
          held.resolve(null);
          expect(await lifecycle).toBe("ok");
          expect(log).toEqual([]);
          expect(
            await outcome(sequencer.invoke("terminal_write", { sessionId: "s", data: "z" })),
          ).toContain("queue limit exceeded");
          sequencer.dispose();
        });
      }
    }
  }

  test("overflow issued before start executes remains fenced", async () => {
    const { log, sequencer } = harness("fence-until-start", { maxPendingInputs: 1 });
    const start = outcome(sequencer.invoke("start_terminal_session", { sessionId: "s" }));
    const first = outcome(sequencer.invoke("terminal_write", { sessionId: "s", data: "x" }));
    const second = outcome(sequencer.invoke("terminal_write", { sessionId: "s", data: "y" }));
    expect(
      (await Promise.all([first, second])).every((value) => value.includes("queue limit exceeded")),
    ).toBe(true);
    expect(await start).toBe("ok");
    expect(sequencer.getStats().failedTerminals).toBe(1);
    expect(log).toEqual(["start_terminal_session"]);
    await sequencer.invoke("start_terminal_session", { sessionId: "s" });
    expect(await outcome(sequencer.invoke("terminal_write", { sessionId: "s", data: "z" }))).toBe(
      "ok",
    );
  });

  test("disposal promptly releases writes waiting behind unresolved lifecycle work", async () => {
    const held = deferred<unknown>();
    const { log, sequencer } = harness("fence-until-start", { runLifecycle: () => held.promise });
    const start = outcome(sequencer.invoke("start_terminal_session", { sessionId: "s" }));
    await tick();
    const write = outcome(sequencer.invoke("terminal_write", { sessionId: "s", data: "held" }));
    expect(sequencer.getStats()).toMatchObject({ pendingInputs: 1, reservedInputBytes: 4 });
    sequencer.dispose(new Error("replaced"));
    expect(await write).toBe("rejected: replaced");
    expect(sequencer.getStats()).toMatchObject({ pendingInputs: 0, reservedInputBytes: 0 });
    expect(await start).toBe("rejected: replaced");
    await tick();
    expect(sequencer.getStats()).toMatchObject({ terminals: 0, pendingLifecycleOperations: 0 });
    held.resolve(null);
    expect(log).toEqual([]);
  });

  for (const command of ["start_terminal_session", "terminal_resize"]) {
    test(`${command}: reserves capacity before lifecycle execution and retains failure fences`, async () => {
      const held = deferred<unknown>();
      const calls: string[] = [];
      const { sequencer } = harness("fence-until-start", {
        maxTerminals: 2,
        runLifecycle: ({ sessionId }) => {
          calls.push(sessionId);
          return held.promise;
        },
      });
      const first = outcome(sequencer.invoke(command, { sessionId: "a" }));
      const second = outcome(sequencer.invoke(command, { sessionId: "b" }));
      expect(await outcome(sequencer.invoke(command, { sessionId: "c" }))).toContain(
        "capacity reached",
      );
      expect(sequencer.getStats().terminals).toBe(2);
      held.reject(new Error("lost response"));
      expect(await Promise.all([first, second])).toEqual([
        "rejected: lost response",
        "rejected: lost response",
      ]);
      expect(await outcome(sequencer.invoke(command, { sessionId: "c" }))).toContain(
        "capacity reached",
      );
      expect(sequencer.getStats()).toMatchObject({ terminals: 2, failedTerminals: 2 });
      expect(calls).toEqual(["a", "b"]);
      sequencer.dispose();
    });
  }

  test("writes waiting behind a resize preserve issue order", async () => {
    const held = deferred<unknown>();
    const { log, sequencer } = harness("fence-until-start", { runLifecycle: () => held.promise });
    const resize = sequencer.invoke("terminal_resize", { sessionId: "s" });
    const writes = ["a", "b", "c"].map((data) =>
      sequencer.invoke("terminal_write", { sessionId: "s", data }),
    );
    await tick();
    expect(log).toEqual([]);
    held.resolve(null);
    await Promise.all([resize, ...writes]);
    expect(log.join("").replaceAll("http:", "")).toBe("abc");
    expect(sequencer.getStats()).toMatchObject({
      terminals: 0,
      pendingInputs: 0,
      reservedInputBytes: 0,
    });
  });

  describe("pipelined input", () => {
    function pipelinedHarness(recovery: TerminalInputRecovery) {
      const acks: Deferred[] = [];
      let usable = true;
      const { log, sequencer } = harness(recovery, {
        pipelined: {
          active: () => true,
          send: (request) => {
            if (!usable) return null;
            log.push(`socket:${request.data}`);
            const ack = deferred();
            acks.push(ack);
            return ack.promise;
          },
        },
      });
      return {
        log,
        sequencer,
        acks,
        setUsable: (value: boolean) => {
          usable = value;
        },
      };
    }

    test("sends consecutive writes without waiting for acknowledgements", async () => {
      const { log, sequencer, acks } = pipelinedHarness("rearm-on-lifecycle");
      const writes = ["a", "b", "c"].map((data) =>
        outcome(sequencer.invoke("terminal_write", { sessionId: "s", data })),
      );
      await tick();
      expect(log).toEqual(["socket:a", "socket:b", "socket:c"]);
      for (const ack of acks) ack.resolve();
      expect(await Promise.all(writes)).toEqual(["ok", "ok", "ok"]);
    });

    test("a lifecycle command waits for every outstanding acknowledgement", async () => {
      const { log, sequencer, acks } = pipelinedHarness("rearm-on-lifecycle");
      const write = outcome(sequencer.invoke("terminal_write", { sessionId: "s", data: "a" }));
      await tick();
      const close = outcome(sequencer.invoke("detach_terminal", { sessionId: "s" }));
      await tick();
      expect(log).toEqual(["socket:a"]);
      acks[0]!.resolve();
      expect(await Promise.all([write, close])).toEqual(["ok", "ok"]);
      expect(log).toEqual(["socket:a", "detach_terminal"]);
    });

    test("resize drains only earlier acknowledgements and never waits on its own later writes", async () => {
      const { log, sequencer, acks } = pipelinedHarness("rearm-on-lifecycle");
      const first = outcome(sequencer.invoke("terminal_write", { sessionId: "s", data: "a" }));
      const resize = outcome(sequencer.invoke("terminal_resize", { sessionId: "s" }));
      const second = outcome(sequencer.invoke("terminal_write", { sessionId: "s", data: "b" }));
      await tick();
      expect(log).toEqual(["socket:a"]);
      acks[0]!.resolve();
      await tick();
      expect(log).toEqual(["socket:a", "terminal_resize", "socket:b"]);
      acks[1]!.resolve();
      expect(await Promise.all([first, resize, second])).toEqual(["ok", "ok", "ok"]);
    });

    test("falls back to HTTP when the channel cannot carry a write", async () => {
      const { log, sequencer, setUsable } = pipelinedHarness("rearm-on-lifecycle");
      setUsable(false);
      expect(await outcome(sequencer.invoke("terminal_write", { sessionId: "s", data: "a" }))).toBe(
        "ok",
      );
      expect(log).toEqual(["http:a"]);
    });

    for (const recovery of ["rearm-on-lifecycle", "fence-until-start"] as const) {
      test(`${recovery}: an accepted channel write ${
        recovery === "rearm-on-lifecycle" ? "re-arms" : "does not re-arm"
      } a failed HTTP queue`, async () => {
        let failHttp = true;
        const acks: Deferred[] = [];
        let usable = false;
        const log: string[] = [];
        const sequencer = new TerminalInputSequencer({
          recovery,
          batchDelayMs: 0,
          sendInput: async (request) => {
            log.push(`http:${request.data}`);
            if (failHttp) throw new Error("http failed");
            return { delivered: true };
          },
          runLifecycle: async () => null,
          pipelined: {
            active: () => true,
            send: (request) => {
              if (!usable) return null;
              log.push(`socket:${request.data}`);
              const ack = deferred();
              acks.push(ack);
              ack.resolve();
              return ack.promise;
            },
          },
        });
        expect(
          await outcome(sequencer.invoke("terminal_write", { sessionId: "s", data: "a" })),
        ).toBe("rejected: http failed");
        usable = true;
        failHttp = false;
        const viaSocket = await outcome(
          sequencer.invoke("terminal_write", { sessionId: "s", data: "b" }),
        );
        usable = false;
        const viaHttp = await outcome(
          sequencer.invoke("terminal_write", { sessionId: "s", data: "c" }),
        );
        if (recovery === "rearm-on-lifecycle") {
          expect([viaSocket, viaHttp]).toEqual(["ok", "ok"]);
          expect(log).toEqual(["http:a", "socket:b", "http:c"]);
        } else {
          expect([viaSocket, viaHttp]).toEqual(["rejected: http failed", "rejected: http failed"]);
          expect(log).toEqual(["http:a"]);
        }
      });
    }
  });
});
