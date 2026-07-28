import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { isPtyPlatformSupported, spawnPty } from "./pty.js";

type FakePtyHarness = {
  emit: (data: string | Uint8Array) => void;
  exit: (code?: number) => void;
  close: ReturnType<typeof mock>;
};

const spawnSpies: Array<ReturnType<typeof spyOn>> = [];

function spawnFakePty(
  options: Parameters<typeof spawnPty>[2],
): { process: ReturnType<typeof spawnPty>; harness: FakePtyHarness } {
  let onTerminalData: ((terminal: unknown, data: Uint8Array) => void) | undefined;
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  const close = mock(() => {
    fakeTerminal.closed = true;
  });
  const fakeTerminal = {
    closed: false,
    close,
    write: mock(() => undefined),
    resize: mock(() => undefined),
  };
  const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((
    _command: string[],
    spawnOptions: { terminal?: { data?: typeof onTerminalData } },
  ) => {
    onTerminalData = spawnOptions.terminal?.data;
    return {
      pid: 42,
      terminal: fakeTerminal,
      exited,
      kill: mock(() => undefined),
    };
  }) as unknown as typeof Bun.spawn);
  spawnSpies.push(spawnSpy);

  return {
    process: spawnPty("/bin/sh", [], options),
    harness: {
      emit(data) {
        const bytes = typeof data === "string"
          ? new TextEncoder().encode(data)
          : data;
        onTerminalData?.(fakeTerminal, bytes);
      },
      exit(code = 0) {
        resolveExited(code);
      },
      close,
    },
  };
}

afterEach(() => {
  for (const spy of spawnSpies.splice(0)) spy.mockRestore();
});

describe("Bun PTY adapter", () => {
  test("documents the supported desktop platforms", () => {
    expect(isPtyPlatformSupported("darwin")).toBe(true);
    expect(isPtyPlatformSupported("linux")).toBe(true);
    expect(isPtyPlatformSupported("win32")).toBe(false);
  });

  test("supports terminal input and resize without crossing a native-addon fd boundary", async () => {
    if (process.platform === "win32") return;

    let output = "";
    let resolveExit!: (exitCode: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    const terminal = spawnPty("/bin/sh", [], {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        TERM: "xterm-256color",
      },
    });

    terminal.onData((data) => {
      output += data;
    });
    terminal.onExit(({ exitCode }) => resolveExit(exitCode));

    terminal.resize(93, 31);
    terminal.write("stty size; printf '__PTY_READY__\\n'; exit\n");

    const exitCode = await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("PTY did not exit")), 3_000)),
    ]);

    expect(exitCode).toBe(0);
    expect(output).toContain("31 93");
    expect(output).toContain("__PTY_READY__");
  }, 5_000);

  test("delivers the leading chunk immediately and coalesces the rest of a burst", async () => {
    const { process: terminal, harness } = spawnFakePty({
      cols: 80,
      rows: 24,
      coalesceMs: 10,
    });
    const output: string[] = [];
    terminal.onData((data) => output.push(data));

    harness.emit("first");
    harness.emit("-second");
    harness.emit("-third");
    expect(output).toEqual(["first"]);
    await Bun.sleep(25);
    expect(output).toEqual(["first", "-second-third"]);
  });

  test("flushes a full pending window immediately instead of growing without bound", () => {
    const { process: terminal, harness } = spawnFakePty({
      cols: 80,
      rows: 24,
      coalesceMs: 60_000,
    });
    const output: string[] = [];
    terminal.onData((data) => output.push(data));

    harness.emit("leading");
    harness.emit("x".repeat(256 * 1024));
    expect(output).toEqual(["leading", "x".repeat(256 * 1024)]);
  });

  test("can disable coalescing for latency-sensitive callers", () => {
    const { process: terminal, harness } = spawnFakePty({
      cols: 80,
      rows: 24,
      coalesceMs: 0,
    });
    const output: string[] = [];
    terminal.onData((data) => output.push(data));
    harness.emit("a");
    harness.emit("b");
    expect(output).toEqual(["a", "b"]);
  });

  test("replays output that arrived before the first data listener", () => {
    const { process: terminal, harness } = spawnFakePty({
      cols: 80,
      rows: 24,
      coalesceMs: 0,
    });
    harness.emit("early");
    const output: string[] = [];
    terminal.onData((data) => output.push(data));
    expect(output).toEqual(["early"]);
  });

  test("flushes pending and decoder-tail output before notifying exit listeners", async () => {
    const { process: terminal, harness } = spawnFakePty({
      cols: 80,
      rows: 24,
      coalesceMs: 60_000,
    });
    const events: string[] = [];
    terminal.onData((data) => events.push(`data:${data}`));
    terminal.onExit(({ exitCode }) => events.push(`exit:${exitCode}`));

    harness.emit("leading");
    harness.emit("-pending");
    harness.emit(new Uint8Array([0xe2, 0x82]));
    harness.exit(7);
    await Bun.sleep(0);

    expect(events).toEqual([
      "data:leading",
      "data:-pending�",
      "exit:7",
    ]);
    expect(harness.close).toHaveBeenCalledTimes(1);
  });
});
