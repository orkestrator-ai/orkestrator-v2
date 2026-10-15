import { afterEach, describe, expect, test, type Mock } from "bun:test";
import { invoke } from "@/lib/native/backend";
import { resumeTerminalInput } from "./terminals";

// `@/lib/native/backend` is replaced once for every suite in tests/setup.ts.
const invokeMock = invoke as unknown as Mock<(...args: unknown[]) => Promise<unknown>>;

afterEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("resumeTerminalInput", () => {
  test("sends the resume command for the terminal's family", async () => {
    invokeMock.mockImplementation(async () => ({ resumed: true }));
    await expect(resumeTerminalInput("s")).resolves.toBe(true);
    expect(invokeMock).toHaveBeenLastCalledWith("terminal_input_resume", { sessionId: "s" });
    await expect(resumeTerminalInput("l", { local: true })).resolves.toBe(true);
    expect(invokeMock).toHaveBeenLastCalledWith("local_terminal_input_resume", { sessionId: "l" });
  });

  test("reports nothing resumed when the terminal was not fenced", async () => {
    invokeMock.mockImplementation(async () => ({ resumed: false }));
    await expect(resumeTerminalInput("s")).resolves.toBe(false);
  });

  test("treats a transport without the command as nothing resumed", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error("Unknown backend command: terminal_input_resume");
    });
    await expect(resumeTerminalInput("s")).resolves.toBe(false);
  });

  test("rethrows any other failure", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error("Browser gateway replaced");
    });
    await expect(resumeTerminalInput("s")).rejects.toThrow("Browser gateway replaced");
  });
});
