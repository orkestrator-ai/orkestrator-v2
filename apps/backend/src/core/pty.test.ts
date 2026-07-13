import { describe, expect, test } from "bun:test";
import { spawnPty } from "./pty.js";

describe("Bun PTY adapter", () => {
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
});
