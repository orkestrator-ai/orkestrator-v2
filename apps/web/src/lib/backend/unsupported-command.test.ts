import { describe, expect, test } from "bun:test";
import { isUnsupportedBackendCommand } from "./shared";

describe("isUnsupportedBackendCommand", () => {
  const command = "launch_multi_review";

  test("recognises the backend's answer for exactly this command", () => {
    expect(
      isUnsupportedBackendCommand(new Error(`Unknown backend command: ${command}`), command),
    ).toBe(true);
    expect(isUnsupportedBackendCommand(`Unknown backend command: ${command}`, command)).toBe(true);
    // Electron IPC prefixes what the backend threw.
    expect(
      isUnsupportedBackendCommand(
        new Error(`Error invoking remote method: Error: Unknown backend command: ${command}`),
        command,
      ),
    ).toBe(true);
    expect(isUnsupportedBackendCommand(new Error(`Unknown command: ${command}`), command)).toBe(
      true,
    );
  });

  test("never treats another failure as a missing command", () => {
    // Any of these may mean the launch ran, so a fallback could run it twice.
    for (const error of [
      new Error("Unknown backend command: get_native_agent_model_catalog"),
      new Error("Unknown command: /review"),
      new Error("Start the environment and finish setup before opening Multi Review"),
      { message: `Unknown backend command: ${command}` },
      undefined,
    ]) {
      expect(isUnsupportedBackendCommand(error, command)).toBe(false);
    }
  });
});
