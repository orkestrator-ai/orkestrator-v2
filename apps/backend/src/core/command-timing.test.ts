import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { commandTimings, CommandTimings } from "./command-timing.js";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";

let capture: LogCapture | null = null;
afterEach(() => {
  capture?.restore();
  capture = null;
});

function harness() {
  let clock = 0;
  const timings = new CommandTimings({
    slowMs: 2_000,
    slowSyncMs: 250,
    logIntervalMs: 60_000,
    now: () => clock,
  });
  capture = captureLogs();
  const logs = capture;
  return {
    timings,
    advance: (ms: number) => {
      clock += ms;
    },
    lines: () =>
      logs
        .records()
        .filter((record) => record.area === "backend" && record.event === "command.slow"),
  };
}

describe("command timings", () => {
  test("a synchronous result stays synchronous, and a fast command logs nothing", () => {
    const { timings, lines } = harness();
    expect(timings.time("get_config", () => 42)).toBe(42);
    expect(lines()).toEqual([]);
    expect(timings.inFlightCount()).toBe(0);
  });

  test("an asynchronous command is timed until it settles and logged when slow", async () => {
    const { timings, advance, lines } = harness();
    let resolve!: (value: string) => void;
    const pending = timings.time(
      "get_projects",
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    expect(timings.inFlightCount()).toBe(1);
    expect(timings.stallContext({ fromMs: 0, toMs: 10 })).toMatchObject({
      commandsInFlight: 1,
      commands: "get_projects",
    });
    advance(2_500);
    resolve("done");
    expect(await pending).toBe("done");
    expect(timings.inFlightCount()).toBe(0);
    expect(lines().map((line) => [line.level, line.fields])).toEqual([
      ["info", { command: "get_projects", durationMs: 2_500, syncMs: 0, outcome: "ok" }],
    ]);
  });

  test("a synchronous part that blocks the loop warns, and is named in a stall's context", () => {
    const { timings, advance, lines } = harness();
    timings.time("get_environments", () => advance(400));
    expect(lines()[0]).toMatchObject({
      level: "warn",
      fields: { command: "get_environments", durationMs: 400, syncMs: 400, outcome: "ok" },
    });
    expect(timings.stallContext({ fromMs: 100, toMs: 900 })).toEqual({
      commandsInFlight: 0,
      commands: undefined,
      blockingCommand: "get_environments",
      blockingCommandMs: 400,
    });
    expect(timings.stallContext({ fromMs: 500, toMs: 900 }).blockingCommand).toBeUndefined();
  });

  for (const outcome of ["ok", "failed"] as const) {
    test(`a blocking async command is attributed before ${outcome} settlement and recorded once`, async () => {
      const { timings, advance, lines } = harness();
      const deferred = Promise.withResolvers<string>();
      const pending = timings.time("get_projects", () => {
        advance(400);
        return deferred.promise;
      });
      const window = { fromMs: 100, toMs: 900 };
      expect(timings.stallContext(window)).toEqual({
        commandsInFlight: 1,
        commands: "get_projects",
        blockingCommand: "get_projects",
        blockingCommandMs: 400,
      });
      expect(lines()).toEqual([]);
      advance(1_000);
      if (outcome === "ok") {
        deferred.resolve("done");
        expect(await pending).toBe("done");
      } else {
        deferred.reject(new Error("rejected"));
        await expect(pending).rejects.toThrow("rejected");
      }
      expect(timings.inFlightCount()).toBe(0);
      expect(timings.stallContext(window)).toMatchObject({
        commandsInFlight: 0,
        commands: undefined,
        blockingCommand: "get_projects",
        blockingCommandMs: 400,
      });
      expect(lines().map((line) => [line.level, line.fields])).toEqual([
        ["warn", { command: "get_projects", durationMs: 1_400, syncMs: 400, outcome }],
      ]);

      // The interval remains in the bounded history until 16 newer blockers arrive.
      for (let index = 0; index < 15; index++) {
        timings.time("get_config", () => advance(300));
      }
      expect(timings.stallContext(window).blockingCommand).toBe("get_projects");
      timings.time("get_config", () => advance(300));
      expect(timings.stallContext(window).blockingCommand).toBeUndefined();
      expect(lines().filter((line) => line.fields?.command === "get_projects")).toHaveLength(1);
    });
  }

  test("settling a command does not reinsert an evicted blocking interval", async () => {
    const { timings, advance } = harness();
    const deferred = Promise.withResolvers<void>();
    const pending = timings.time("get_projects", () => {
      advance(400);
      return deferred.promise;
    });
    advance(1_000);
    for (let index = 0; index < 16; index++) {
      timings.time("get_config", () => advance(300));
    }
    const window = { fromMs: 100, toMs: 900 };
    expect(timings.stallContext(window).blockingCommand).toBeUndefined();
    deferred.resolve();
    await pending;
    expect(timings.stallContext(window).blockingCommand).toBeUndefined();
    expect(timings.inFlightCount()).toBe(0);
  });

  test("a rejection still reaches the caller, and a throw is timed as a failure", async () => {
    const { timings, advance, lines } = harness();
    const rejected = timings.time("create_client_grant", async () => {
      advance(3_000);
      throw new Error("PRIVATE-REASON");
    });
    await expect(rejected).rejects.toThrow("PRIVATE-REASON");
    expect(() =>
      timings.time("get_projects", () => {
        advance(300);
        throw new Error("sync");
      }),
    ).toThrow("sync");
    expect(lines().map((line) => line.fields)).toEqual([
      { command: "create_client_grant", durationMs: 3_000, syncMs: 3_000, outcome: "failed" },
      { command: "get_projects", durationMs: 300, syncMs: 300, outcome: "failed" },
    ]);
    expect(JSON.stringify(lines())).not.toContain("PRIVATE-REASON");
  });

  test("repeats of one command within the interval are folded into its next line", () => {
    const { timings, advance, lines } = harness();
    for (const ms of [300, 900, 500]) {
      timings.time("get_projects", () => advance(ms));
      advance(1_000);
    }
    advance(60_000);
    timings.time("get_projects", () => advance(260));
    expect(lines().map((line) => line.fields)).toEqual([
      expect.objectContaining({ durationMs: 300 }),
      expect.objectContaining({ durationMs: 260, folded: 2, foldedMaxMs: 900 }),
    ]);
  });
});

describe("the command registry", () => {
  test("times every registered command under its registered name", async () => {
    const commands = createCommandRegistry();
    const time = spyOn(commandTimings, "time");
    try {
      const [name, handler] = commands.entries().next().value!;
      try {
        // A stub context: the command may fail, but it is timed either way.
        await handler({}, {} as CommandContext);
      } catch {
        // Expected without a real context.
      }
      expect(time).toHaveBeenCalledTimes(1);
      expect(time.mock.calls[0]?.[0]).toBe(name);
    } finally {
      time.mockRestore();
    }
  });
});
