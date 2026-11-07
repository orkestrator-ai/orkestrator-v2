import { describe, expect, test } from "bun:test";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import { isUnknownBackendCommand } from "./unknown-command";

const command = "arrange_projects_by_intent";

describe("isUnknownBackendCommand", () => {
  test("matches the backend's own answer for the command", () => {
    expect(isUnknownBackendCommand(new Error(unknownBackendCommandMessage(command)), command)).toBe(
      true,
    );
    expect(isUnknownBackendCommand(unknownBackendCommandMessage(command), command)).toBe(true);
  });

  test("matches the answer behind a transport's prefix", () => {
    const wrapped = `Error invoking remote method 'orkestrator:invoke': Error: ${unknownBackendCommandMessage(command)}`;
    expect(isUnknownBackendCommand(new Error(wrapped), command)).toBe(true);
  });

  test("does not match another command's answer, a longer name or other failures", () => {
    expect(
      isUnknownBackendCommand(new Error(unknownBackendCommandMessage("arrange_projects")), command),
    ).toBe(false);
    expect(
      isUnknownBackendCommand(new Error(unknownBackendCommandMessage(`${command}_v2`)), command),
    ).toBe(false);
    expect(isUnknownBackendCommand(new Error("denied"), command)).toBe(false);
  });

  test("still counts a message naming the command as not available in this backend", () => {
    expect(
      isUnknownBackendCommand(new Error(`${command} is not available in this backend.`), command),
    ).toBe(true);
    expect(
      isUnknownBackendCommand(new Error("Ticket sync is not available in this backend."), command),
    ).toBe(false);
  });
});
