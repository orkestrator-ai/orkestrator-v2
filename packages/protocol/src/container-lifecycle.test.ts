import { describe, expect, test } from "bun:test";
import { codedErrorWire, fromCodedWire } from "./contract/errors";
import { errorCode, ipcErrorMessage } from "./contract/ipc-error";
import {
  ContainerLifecycleError,
  formatContainerLifecycleError,
  parseContainerLifecycleError,
  parseRecreateEnvironmentRequest,
} from "./container-lifecycle";

describe("container lifecycle contract", () => {
  test("round-trips typed errors through transport prefixes", () => {
    const message = formatContainerLifecycleError("runtime-changed", "Review again.");
    expect(parseContainerLifecycleError(new Error(message))).toEqual({
      code: "runtime-changed",
      message: "Review again.",
    });
    expect(
      parseContainerLifecycleError(`Error invoking remote method 'invoke': Error: ${message}`),
    ).toEqual({ code: "runtime-changed", message: "Review again." });
    expect(parseContainerLifecycleError("ContainerLifecycleError:made-up: nope")).toBeNull();
    expect(parseContainerLifecycleError("plain failure")).toBeNull();
    expect(parseContainerLifecycleError(undefined)).toBeNull();
  });

  test("carries the registered container-lifecycle code with its reason over every transport", () => {
    const thrown = new ContainerLifecycleError("operation-in-progress", "Busy.");
    // The message keeps the marker an older reader matches.
    expect(thrown.message).toBe("ContainerLifecycleError:operation-in-progress: Busy.");
    expect(thrown.reason).toBe("operation-in-progress");
    expect(errorCode(thrown)).toBe("container-lifecycle");
    expect(parseContainerLifecycleError(thrown)).toEqual({
      code: "operation-in-progress",
      message: "Busy.",
    });
    // Gateway body, then desktop main's rebuilt error, then Electron IPC.
    const wire = codedErrorWire(thrown);
    expect(wire).toEqual({
      error: thrown.message,
      code: "container-lifecycle",
      details: { reason: "operation-in-progress" },
    });
    const rebuilt = fromCodedWire(JSON.parse(JSON.stringify(wire)));
    expect(parseContainerLifecycleError(rebuilt)?.code).toBe("operation-in-progress");
    const overIpc = new Error(ipcErrorMessage(rebuilt) ?? "");
    expect(overIpc.message).toBe(
      "[container-lifecycle reason=operation-in-progress] ContainerLifecycleError:operation-in-progress: Busy.",
    );
    expect(parseContainerLifecycleError(overIpc)).toEqual({
      code: "operation-in-progress",
      message: "Busy.",
    });
    // A relay that kept only the code still reads the reason from the marker.
    expect(
      parseContainerLifecycleError(
        Object.assign(new Error(thrown.message), { code: "container-lifecycle" }),
      ),
    ).toEqual({ code: "operation-in-progress", message: "Busy." });
    // Another registered code decides against, even beside the marker.
    expect(
      parseContainerLifecycleError(
        Object.assign(new Error(thrown.message), { code: "prompt-queue-message-conflict" }),
      ),
    ).toBeNull();
  });

  test("an omitted intent means preserve, never discard", () => {
    expect(parseRecreateEnvironmentRequest({ environmentId: "env-1" })).toEqual({
      environmentId: "env-1",
      intent: "preserve",
      expectedContainerId: null,
    });
  });

  test("discard must name the reviewed container", () => {
    expect(() =>
      parseRecreateEnvironmentRequest({ environmentId: "env-1", intent: "discard" }),
    ).toThrow("ContainerLifecycleError:invalid-request");
    expect(
      parseRecreateEnvironmentRequest({
        environmentId: "env-1",
        intent: "discard",
        expectedContainerId: "abc",
      }),
    ).toEqual({ environmentId: "env-1", intent: "discard", expectedContainerId: "abc" });
  });

  test("rejects malformed and oversized fields", () => {
    expect(() => parseRecreateEnvironmentRequest({ environmentId: 7 })).toThrow("invalid-request");
    expect(() =>
      parseRecreateEnvironmentRequest({ environmentId: "env-1", intent: "DISCARD" }),
    ).toThrow("invalid-request");
    expect(() =>
      parseRecreateEnvironmentRequest({
        environmentId: "env-1",
        intent: "discard",
        expectedContainerId: "x".repeat(257),
      }),
    ).toThrow("too long");
  });
});
