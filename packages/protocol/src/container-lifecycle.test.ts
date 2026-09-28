import { describe, expect, test } from "bun:test";
import {
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
