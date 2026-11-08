import { describe, expect, it } from "bun:test";
import {
  CodedError,
  codedErrorWire,
  fromCodedWire,
  unknownCommand,
  unsupportedVersion,
} from "./errors.js";
import {
  boundErrorDetails,
  codedErrorParts,
  errorCode,
  formatIpcError,
  ipcErrorMessage,
  ipcErrorText,
  isRegisteredErrorCode,
  MAX_ERROR_DETAIL_TEXT_LENGTH,
  parseIpcError,
  REGISTERED_ERROR_CODE_LIST,
} from "./ipc-error.js";

/** What crosses Electron IPC and the context bridge: the message only. */
const overIpc = (error: unknown) => new Error(ipcErrorMessage(error) ?? (error as Error).message);
const overTheWire = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

/** A thrower's own coded class, as the backend defines them. */
class ConflictError extends Error {
  readonly code = "kanban-request-id-conflict" as const;
  constructor(
    message: string,
    readonly record: string,
  ) {
    super(message);
  }
}

describe("the shared IPC error codec", () => {
  it("round-trips every registered code with its message unchanged", () => {
    for (const code of REGISTERED_ERROR_CODE_LIST) {
      const message = formatIpcError(code, {}, "Some text with [brackets] and = signs");
      const parsed = parseIpcError(message);
      expect(parsed).toEqual({
        code,
        details: {},
        message: "Some text with [brackets] and = signs",
      });
      expect(errorCode(new Error(message))).toBe(code);
    }
  });

  it("carries each detail kind and reads it back bounded", () => {
    const thrown = new ConflictError(
      "Kanban ticket requestId was already used with different arguments",
      "ticket",
    );
    const received = overIpc(thrown);
    expect(received.message).toBe(
      "[kanban-request-id-conflict record=ticket] Kanban ticket requestId was already used with different arguments",
    );
    // An older reader that matches the words still finds them.
    expect(received.message).toContain("requestId was already used");
    expect(codedErrorParts(received)).toEqual({
      code: "kanban-request-id-conflict",
      details: { record: "ticket" },
      message: thrown.message,
    });

    const capacity = parseIpcError(
      formatIpcError(
        "native-job-receipt-capacity",
        { limit: 256 },
        "Native job receipt capacity reached",
      ),
    );
    expect(capacity?.details).toEqual({ limit: 256 });

    const version = parseIpcError(
      formatIpcError(
        "unsupported-version",
        { domain: "git", range: { min: 1, max: 3 }, command: "get_x" },
        "m",
      ),
    );
    expect(version?.details).toEqual({
      domain: "git",
      range: { min: 1, max: 3 },
      command: "get_x",
    });
  });

  it("leaves an unregistered code in the text and never reads it as a code", () => {
    const message = "[not-a-registered-code] Some text";
    expect(parseIpcError(message)).toBeNull();
    expect(errorCode(new Error(message))).toBeUndefined();
    expect(ipcErrorMessage(new Error(message))).toBeNull();
    expect(ipcErrorText(message)).toBe(message);
    expect(isRegisteredErrorCode("not-a-registered-code")).toBe(false);
    // An object's own unregistered code is not sent in the message form either.
    expect(ipcErrorMessage(Object.assign(new Error("x"), { code: "something-else" }))).toBeNull();
  });

  it("drops unregistered keys and malformed values, and bounds oversized text", () => {
    const long = "x".repeat(MAX_ERROR_DETAIL_TEXT_LENGTH + 50);
    const message = formatIpcError(
      "kanban-request-id-conflict",
      { record: long, prompt: "secret prompt text", limit: 5 },
      "m",
    );
    expect(message).not.toContain("secret");
    expect(message).not.toContain("limit=");
    // Written cut to the bound...
    expect(parseIpcError(message)?.details).toEqual({
      record: "x".repeat(MAX_ERROR_DETAIL_TEXT_LENGTH),
    });
    // ...and a forged oversized, unregistered or malformed value is dropped on read.
    const forged = `[kanban-request-id-conflict record=${"y".repeat(100)} extra=1] m`;
    expect(parseIpcError(forged)).toEqual({
      code: "kanban-request-id-conflict",
      details: {},
      message: "m",
    });
    expect(parseIpcError("[native-job-receipt-capacity limit=-1] m")?.details).toEqual({});
    expect(parseIpcError("[native-job-receipt-capacity limit=12x] m")?.details).toEqual({});
    expect(parseIpcError("[unsupported-version range=3-1] m")?.details).toEqual({});
    expect(parseIpcError("[kanban-request-id-conflict record=%E0%A4%A] m")?.details).toEqual({});
    expect(boundErrorDetails("native-job-receipt-capacity", { limit: 1.5 })).toEqual({});
    expect(boundErrorDetails("native-agent-provider-session-missing", { any: "x" })).toEqual({});
  });

  it("does not prefix a relayed message twice", () => {
    const once = formatIpcError("native-agent-provider-session-missing", {}, "gone");
    expect(formatIpcError("native-agent-provider-session-missing", {}, once)).toBe(once);
    expect(ipcErrorMessage(new Error(once))).toBe(once);
    expect(ipcErrorText(once)).toBe("gone");
  });

  it("reads the code from every transport's form", () => {
    // In process: the class's own `code`.
    expect(errorCode(new ConflictError("m", "ticket"))).toBe("kanban-request-id-conflict");
    // The gateway's `code` as `GatewayHttpError` or `NodeLink` keeps it, registered or not.
    expect(errorCode(Object.assign(new Error("m"), { code: "node-unavailable" }))).toBe(
      "node-unavailable",
    );
    // Electron IPC: the message prefix.
    expect(errorCode(overIpc(new ConflictError("m", "ticket")))).toBe("kanban-request-id-conflict");
    // A Node system error's code is not in the code form; plain errors have none.
    expect(errorCode(Object.assign(new Error("m"), { code: "ENOENT" }))).toBeUndefined();
    expect(errorCode(new Error("Native agent provider session was not found"))).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
    expect(errorCode("[native-job-receipt-capacity] text")).toBe("native-job-receipt-capacity");
  });

  it("keeps the incompatibility form byte-for-byte", () => {
    const error = unsupportedVersion({
      domain: "git",
      range: { min: 1, max: 3 },
      command: "get_x",
    });
    expect(ipcErrorMessage(error)).toBe(
      `[unsupported-version domain=git range=1-3 command=get_x] ${error.message}`,
    );
  });
});

describe("the gateway body for registered codes", () => {
  it("round-trips a registered code with bounded details through JSON", () => {
    const wire = codedErrorWire(
      new ConflictError("Kanban ticket requestId was already used", "ticket"),
    );
    expect(wire).toEqual({
      error: "Kanban ticket requestId was already used",
      code: "kanban-request-id-conflict",
      details: { record: "ticket" },
    });
    const rebuilt = fromCodedWire(overTheWire(wire));
    expect(rebuilt).toBeInstanceOf(CodedError);
    expect(errorCode(rebuilt)).toBe("kanban-request-id-conflict");
    expect((rebuilt as CodedError).details).toEqual({ record: "ticket" });
    // And on across IPC from there.
    expect(errorCode(overIpc(rebuilt))).toBe("kanban-request-id-conflict");
  });

  it("answers an incompatibility with its own body and class", () => {
    const wire = codedErrorWire(unknownCommand("get_x"));
    expect(wire).toMatchObject({ code: "unknown-command", details: { command: "get_x" } });
    expect(fromCodedWire(overTheWire(wire))?._tag).toBe("UnknownCommandError");
  });

  it("refuses unregistered codes and drops malformed details", () => {
    expect(codedErrorWire(Object.assign(new Error("m"), { code: "other" }))).toBeNull();
    expect(codedErrorWire(new Error("m"))).toBeNull();
    expect(fromCodedWire({ error: "m", code: "other" })).toBeNull();
    expect(fromCodedWire({ error: 1, code: "kanban-request-id-conflict" })).toBeNull();
    const rebuilt = fromCodedWire({
      error: "m",
      code: "native-job-receipt-capacity",
      details: { limit: "lots", prompt: "secret" },
    });
    expect(errorCode(rebuilt)).toBe("native-job-receipt-capacity");
    expect((rebuilt as CodedError).details).toBeUndefined();
  });
});
