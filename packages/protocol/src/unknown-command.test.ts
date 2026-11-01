import { describe, expect, test } from "bun:test";
import { isUnknownCommandError, unknownBackendCommandMessage } from "./unknown-command.js";

describe("isUnknownCommandError", () => {
  const command = "sync_controller_settings";

  test("matches the backend's own answer, raised or passed on as a string", () => {
    expect(unknownBackendCommandMessage(command)).toBe(
      "Unknown backend command: sync_controller_settings",
    );
    expect(isUnknownCommandError(new Error(unknownBackendCommandMessage(command)), command)).toBe(
      true,
    );
    expect(isUnknownCommandError(unknownBackendCommandMessage(command), command)).toBe(true);
    // A wrapper may add context around it.
    expect(
      isUnknownCommandError(
        new Error(`Node Build box: ${unknownBackendCommandMessage(command)}.`),
        command,
      ),
    ).toBe(true);
  });

  test("does not match the wording no backend sends, another command or a longer name", () => {
    expect(isUnknownCommandError(new Error(`Unknown command: ${command}`), command)).toBe(false);
    expect(isUnknownCommandError(new Error("Unknown backend command: other"), command)).toBe(false);
    expect(
      isUnknownCommandError(new Error(unknownBackendCommandMessage(`${command}_v2`)), command),
    ).toBe(false);
    // A longer name earlier in the text does not hide an exact one later.
    expect(
      isUnknownCommandError(
        new Error(
          `${unknownBackendCommandMessage(`${command}_v2`)}; ${unknownBackendCommandMessage(command)}`,
        ),
        command,
      ),
    ).toBe(true);
    expect(isUnknownCommandError(new Error("401 Unauthorized"), command)).toBe(false);
    expect(isUnknownCommandError(undefined, command)).toBe(false);
    expect(isUnknownCommandError({ message: unknownBackendCommandMessage(command) }, command)).toBe(
      false,
    );
  });
});
