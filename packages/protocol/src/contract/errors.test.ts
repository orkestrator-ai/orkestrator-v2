import { describe, expect, it } from "bun:test";
import { unknownBackendCommandMessage } from "../unknown-command.js";
import { formatIpcIncompatibility, parseIpcIncompatibility } from "./ipc-error.js";
import {
  UnknownCommandError,
  UnsupportedFieldError,
  UnsupportedVersionError,
  fromWire,
  incompatibility,
  incompatibilityIpcMessage,
  incompatibilityOfAnyCommand,
  isIncompatibilityError,
  toWire,
  unknownCommand,
  unsupportedField,
  unsupportedVersion,
} from "./errors.js";

/** What a JSON transport does to an error body. */
const overTheWire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("incompatibility errors", () => {
  it("are Errors with a code, a tag and the legacy unknown-command text", () => {
    const error = unknownCommand("get_x", "git");
    expect(error).toBeInstanceOf(Error);
    expect(error._tag).toBe("UnknownCommandError");
    expect(error.code).toBe("unknown-command");
    expect(error.message).toBe(unknownBackendCommandMessage("get_x"));
    expect(isIncompatibilityError(error)).toBe(true);
    expect(isIncompatibilityError(new Error("x"))).toBe(false);
  });

  it("round-trip through toWire and fromWire over JSON", () => {
    const errors = [
      unknownCommand("get_x", "git"),
      unknownCommand("get_y"),
      unsupportedVersion({ domain: "node-mail", range: { min: 1, max: 3 }, version: 5 }),
      unsupportedField({ field: "steer", domain: "node-mail", command: "deliver_node_mail" }),
    ];
    for (const error of errors) {
      const wire = overTheWire(toWire(error));
      const rebuilt = fromWire(wire);
      expect(rebuilt?.constructor).toBe(error.constructor);
      expect(rebuilt?.message).toBe(error.message);
      expect(rebuilt?.code).toBe(error.code);
      expect(incompatibility(rebuilt)).toEqual(incompatibility(error));
    }
  });

  it("put only bounded, value-free details on the wire", () => {
    expect(toWire(unknownCommand("get_y"))).toEqual({
      error: unknownBackendCommandMessage("get_y"),
      code: "unknown-command",
      details: { command: "get_y" },
    });
    // A name that is not an identifier (or is too long) stays in the message only.
    expect(toWire(unknownCommand("get y; rm")).details).toBeUndefined();
    expect(toWire(unknownCommand(`c${"x".repeat(64)}`)).details).toBeUndefined();
    expect(
      toWire(unsupportedVersion({ domain: "git", range: { min: 2, max: 4 }, command: "c" })),
    ).toEqual({
      error: "Domain git for c is not supported; this backend accepts versions 2 to 4.",
      code: "unsupported-version",
      details: { domain: "git", range: { min: 2, max: 4 }, command: "c" },
    });
    expect(unsupportedField({ field: "f".repeat(100) }).field).toHaveLength(64);
  });

  it("fromWire refuses bodies that are not coded incompatibilities", () => {
    for (const body of [
      null,
      "Unknown backend command: x",
      { error: "boom" },
      { error: "boom", code: "internal" },
      { code: "unknown-command" },
      { error: 7, code: "unknown-command" },
    ]) {
      expect(fromWire(body)).toBeNull();
    }
  });

  it("fromWire drops malformed details but keeps the code", () => {
    const rebuilt = fromWire({
      error: "e",
      code: "unsupported-version",
      details: { domain: "Not A Domain", range: { min: 1, max: 2 } },
    });
    expect(rebuilt).toBeInstanceOf(UnsupportedVersionError);
    expect(incompatibility(rebuilt)).toEqual({ code: "unsupported-version" });
    const inverted = fromWire({
      error: "e",
      code: "unsupported-version",
      details: { domain: "git", range: { min: 3, max: 1 }, extra: true },
    });
    expect(incompatibility(inverted)).toEqual({ code: "unsupported-version", domain: "git" });
  });
});

describe("incompatibility()", () => {
  it("reads the error classes", () => {
    expect(
      incompatibility(new UnknownCommandError({ message: "m", command: "c", domain: "git" })),
    ).toEqual({ code: "unknown-command", domain: "git", command: "c" });
    expect(incompatibility(new UnsupportedFieldError({ message: "m", field: "steer" }))).toEqual({
      code: "unsupported-field",
      field: "steer",
    });
  });

  it("reads a transport's rebuilt error carrying code and details", () => {
    const error = Object.assign(new Error("Not supported"), {
      code: "unsupported-version",
      details: { domain: "previews", range: { min: 1, max: 1 } },
    });
    expect(incompatibility(error)).toEqual({
      code: "unsupported-version",
      domain: "previews",
      range: { min: 1, max: 1 },
    });
    expect(incompatibility({ error: "x", code: "unknown-command" })).toEqual({
      code: "unknown-command",
    });
  });

  it("reads a pre-contract node's legacy text only for the command asked about", () => {
    const legacy = new Error(`Remote failed: ${unknownBackendCommandMessage("get_x")}`);
    expect(incompatibility(legacy, "get_x")).toEqual({ code: "unknown-command" });
    expect(incompatibility(unknownBackendCommandMessage("get_x"), "get_x")).toEqual({
      code: "unknown-command",
    });
    expect(incompatibility(legacy, "get")).toBeNull();
    expect(incompatibility(legacy)).toBeNull();
  });

  it("returns null for unrelated errors", () => {
    for (const error of [
      new Error("401 Unauthorized"),
      Object.assign(new Error("x"), { code: "ENOENT" }),
      { code: 3 },
      undefined,
      null,
      "text",
    ]) {
      expect(incompatibility(error, "get_x")).toBeNull();
    }
  });
});

describe("incompatibility() and the command it names", () => {
  it("ignores a coded incompatibility for another command (a nested call's)", () => {
    const nested = overTheWire(toWire(unknownCommand("get_inner")));
    expect(incompatibility(fromWire(nested), "get_outer")).toBeNull();
    expect(incompatibility(fromWire(nested), "get_inner")).toEqual({
      code: "unknown-command",
      command: "get_inner",
    });
    // Without a command to compare, the code is read as is.
    expect(incompatibility(fromWire(nested))?.code).toBe("unknown-command");
    // A coded error that names no command counts for any command asked about.
    expect(incompatibility({ error: "e", code: "unknown-command" }, "get_x")).toEqual({
      code: "unknown-command",
    });
  });

  it("incompatibilityOfAnyCommand reads codes and only the anchored legacy answer", () => {
    expect(incompatibilityOfAnyCommand(new Error(unknownBackendCommandMessage("get_x")))).toEqual({
      code: "unknown-command",
      command: "get_x",
    });
    expect(
      incompatibilityOfAnyCommand(new Error(`Wrapped: ${unknownBackendCommandMessage("get_x")}`)),
    ).toBeNull();
    expect(incompatibilityOfAnyCommand(unsupportedField({ field: "steer" }))).toEqual({
      code: "unsupported-field",
      field: "steer",
    });
    expect(incompatibilityOfAnyCommand(new Error("Unknown backend command: "))).toBeNull();
    expect(incompatibilityOfAnyCommand(new Error("boom"))).toBeNull();
  });
});

describe("the IPC message form", () => {
  it("carries the code and details in the message and reads them back", () => {
    const error = unsupportedVersion({
      domain: "node-mail",
      range: { min: 1, max: 3 },
      version: 5,
      command: "deliver_node_mail",
    });
    const message = incompatibilityIpcMessage(error);
    expect(message).toBe(
      `[unsupported-version domain=node-mail range=1-3 command=deliver_node_mail] ${error.message}`,
    );
    // Only the message crosses IPC and the context bridge.
    const crossed = new Error(message!);
    expect(incompatibility(crossed)).toEqual({
      code: "unsupported-version",
      domain: "node-mail",
      range: { min: 1, max: 3 },
      command: "deliver_node_mail",
    });
    expect(incompatibility(crossed, "other_command")).toBeNull();
    expect(parseIpcIncompatibility(message!)?.message).toBe(error.message);
  });

  it("keeps a legacy matcher working on the prefixed unknown-command message", () => {
    const message = incompatibilityIpcMessage(unknownCommand("get_x"))!;
    expect(message).toBe(
      `[unknown-command command=get_x] ${unknownBackendCommandMessage("get_x")}`,
    );
    expect(incompatibility(new Error(message), "get_x")?.code).toBe("unknown-command");
  });

  it("encodes values so a field cannot break out of the brackets", () => {
    const message = incompatibilityIpcMessage(unsupportedField({ field: "a] b c=d" }))!;
    expect(message.startsWith("[unsupported-field field=a%5D%20b%20c%3Dd] ")).toBe(true);
    expect(incompatibility(new Error(message))).toEqual({
      code: "unsupported-field",
      field: "a] b c=d",
    });
  });

  it("does not prefix twice and refuses unrelated or malformed prefixes", () => {
    const once = incompatibilityIpcMessage(unknownCommand("get_x"))!;
    expect(formatIpcIncompatibility("unknown-command", { command: "get_x" }, once)).toBe(once);
    expect(incompatibilityIpcMessage(new Error("boom"))).toBeNull();
    expect(parseIpcIncompatibility("[node-unavailable] The node did not open.")).toBeNull();
    expect(parseIpcIncompatibility("[unknown-command]x")).toBeNull();
    // Malformed details are dropped by the bounded reader; the code stays.
    expect(
      incompatibility(new Error("[unsupported-version domain=Not%20A%20Domain range=3-1] m")),
    ).toEqual({ code: "unsupported-version" });
  });
});
